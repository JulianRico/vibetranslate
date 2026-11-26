/**
 * personaplex-client.js - Cliente Full-Duplex para NVIDIA PersonaPlex (Moshi 7B)
 * ===============================================================================
 * Conecta ViBeTranslate con `personaplex_service/server.py` o un servidor oficial
 * `python -m moshi.server` mediante su protocolo binario de 1 byte:
 * - Salud / capacidades (`GET /health`, `GET /voices`)
 * - Streaming bidireccional continuo a 24 kHz (Mimi sample rate) con re-muestreo
 *   automático desde 16 kHz / 48 kHz si aplica
 * - Acumulador de tokens SentencePiece (`0x02`) en frases completas para subtítulos
 *   y registro de evaluación en el Estudio de Práctica
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const {
  PERSONAPLEX_VOICES,
  normalizeVoicePromptFile,
  encodeAudioFrame,
  encodeControl,
  encodePing,
  decodeMessage,
  wrapSystemPrompt
} = require('./personaplex-protocol');

const PERSONAPLEX_SAMPLE_RATE = 24000;

/**
 * Re-muestrea un Buffer o Int16Array PCM 16-bit mono entre frecuencias (p. ej. 16000 -> 24000 Hz)
 * usando interpolación lineal sin dependencias nativas.
 */
function resamplePcm16(input, fromRate, toRate = PERSONAPLEX_SAMPLE_RATE) {
  if (!input || input.length === 0) return Buffer.alloc(0);
  const srcBytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const srcSamples = Math.floor(srcBytes.length / 2);
  if (srcSamples === 0) return Buffer.alloc(0);
  if (fromRate === toRate) return Buffer.from(srcBytes.subarray(0, srcSamples * 2));

  const ratio = fromRate / toRate;
  const dstSamples = Math.max(1, Math.round(srcSamples / ratio));
  const out = Buffer.allocUnsafe(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.min(srcSamples - 1, Math.floor(srcPos));
    const idx1 = Math.min(srcSamples - 1, idx0 + 1);
    const frac = srcPos - idx0;
    const s0 = srcBytes.readInt16LE(idx0 * 2);
    const s1 = srcBytes.readInt16LE(idx1 * 2);
    const interpolated = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
    out.writeInt16LE(interpolated, i * 2);
  }
  return out;
}

class PersonaPlexClient {
  constructor(options = {}) {
    this.host = options.host || process.env.PERSONAPLEX_HOST || '127.0.0.1';
    this.port = Number(options.port || process.env.PERSONAPLEX_PORT) || 8998;
    this.secure = Boolean(options.secure);
    this.rawPrompt = Boolean(options.rawPrompt);
    this.voicePrompt = this.rawPrompt
      ? String(options.voicePrompt || 'auto').trim()
      : normalizeVoicePromptFile(options.voicePrompt || process.env.PERSONAPLEX_VOICE || 'NATF2');
    this.textPrompt = options.textPrompt || '';
    this.audioFormat = options.audioFormat || 'pcm16'; // 'pcm16' (personaplex_service) | 'opus' (upstream moshi.server)
    this.seed = options.seed ?? null;
    this.rejectUnauthorized = options.rejectUnauthorized ?? false; // moshi.server usa certificados temporales con --ssl

    this.ws = null;
    this.isConnected = false;
    this.handshakeReady = false;
    this.pendingSentence = '';
    this.flushTimer = null;

    this.onReady = options.onReady || null;
    this.onAudioFrame = options.onAudioFrame || null;
    this.onTextToken = options.onTextToken || null;
    this.onSentence = options.onSentence || null;
    this.onMetadata = options.onMetadata || null;
    this.onControl = options.onControl || null;
    this.onError = options.onError || null;
    this.onClose = options.onClose || null;
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
  }

  get httpBaseUrl() {
    const proto = this.secure ? 'https' : 'http';
    return `${proto}://${this.host}:${this.port}`;
  }

  buildWsUrl({ voicePrompt, textPrompt, audioFormat, seed, rawPrompt } = {}) {
    const proto = this.secure ? 'wss' : 'ws';
    // ¿Por qué `rawPrompt`?: PersonaPlex requiere envolver en `<system> ... <system>` y archivos `.pt`,
    // mientras que Haru-4B recibe una Character Card estructurada tal cual y clips de referencia `.wav`/`.flac` o `auto`.
    const useRaw = rawPrompt !== undefined ? Boolean(rawPrompt) : this.rawPrompt;
    const rawVp = voicePrompt || this.voicePrompt;
    const vp = useRaw ? String(rawVp || 'auto').trim() : normalizeVoicePromptFile(rawVp);
    const rawTp = textPrompt !== undefined ? textPrompt : this.textPrompt;
    const tp = useRaw ? String(rawTp || '').trim() : wrapSystemPrompt(rawTp);
    const fmt = audioFormat || this.audioFormat;
    const params = new URLSearchParams();
    params.set('voice_prompt', vp);
    params.set('text_prompt', tp);
    if (fmt) params.set('audio_format', fmt);
    if (seed !== null && seed !== undefined) params.set('seed', String(seed));
    return `${proto}://${this.host}:${this.port}/api/chat?${params.toString()}`;
  }

  async checkHealth(timeoutMs = 1800) {
    const client = this.secure ? https : http;
    return new Promise((resolve) => {
      const req = client.get(
        `${this.httpBaseUrl}/health`,
        { timeout: timeoutMs, rejectUnauthorized: this.rejectUnauthorized },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(raw);
                resolve({ online: true, ...parsed });
                return;
              } catch {
                resolve({ online: true, service: 'moshi-compatible', voices: PERSONAPLEX_VOICES });
                return;
              }
            }
            // Si es un `python -m moshi.server` puro sin ruta /health, responde 404 pero está vivo
            if (res.statusCode === 404 || res.statusCode === 426) {
              resolve({ online: true, service: 'nvidia-moshi-upstream', audioFormat: 'opus', voices: PERSONAPLEX_VOICES });
              return;
            }
            resolve({ online: false, statusCode: res.statusCode });
          });
        }
      );
      req.on('error', (err) => resolve({ online: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ online: false, error: 'Timeout' });
      });
    });
  }

  connect(overrides = {}) {
    this.disconnect();
    const url = this.buildWsUrl(overrides);
    const wsOpts = this.secure ? { rejectUnauthorized: this.rejectUnauthorized } : {};

    try {
      this.ws = new this.WebSocketImpl(url, wsOpts);
      this.ws.binaryType = 'nodebuffer';
    } catch (err) {
      if (this.onError) this.onError(err);
      return;
    }

    this.ws.on('open', () => {
      this.isConnected = true;
    });

    this.ws.on('message', (data) => {
      const msg = decodeMessage(data);
      switch (msg.type) {
        case 'handshake':
          this.handshakeReady = true;
          if (this.onReady) this.onReady({ version: msg.version, model: msg.model });
          break;
        case 'audio':
          if (this.onAudioFrame && msg.data && msg.data.length > 0) {
            this.onAudioFrame(msg.data);
          }
          break;
        case 'text':
          this._handleTextToken(msg.data);
          break;
        case 'control':
          if (this.onControl) this.onControl(msg);
          break;
        case 'metadata':
          if (this.onMetadata) this.onMetadata(msg.data);
          break;
        case 'error':
          if (this.onError) this.onError(new Error(msg.data || 'PersonaPlex server error'));
          break;
        default:
          break;
      }
    });

    this.ws.on('error', (err) => {
      if (this.onError) this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      this.flushPendingSentence();
      this.isConnected = false;
      this.handshakeReady = false;
      if (this.onClose) {
        this.onClose({ code, reason: reason ? reason.toString('utf8') : '' });
      }
    });
  }

  _handleTextToken(token) {
    if (!token) return;
    if (this.onTextToken) this.onTextToken(token);
    this.pendingSentence += token;

    if (this.flushTimer) clearTimeout(this.flushTimer);

    // Emitir frase cuando cierra oración (. ? !) con longitud razonable, o tras 900 ms de silencio textual
    const trimmed = this.pendingSentence.trim();
    if (/[.?!]\s*$/.test(this.pendingSentence) && trimmed.split(/\s+/).length >= 3) {
      this.flushPendingSentence();
    } else {
      this.flushTimer = setTimeout(() => this.flushPendingSentence(), 900);
    }
  }

  flushPendingSentence() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const clean = this.pendingSentence.replace(/\s+/g, ' ').trim();
    this.pendingSentence = '';
    if (clean && this.onSentence) {
      this.onSentence(clean);
    }
    return clean;
  }

  sendAudioFrame(rawBytes) {
    if (!this.ws || this.ws.readyState !== 1 || !this.handshakeReady) return false;
    if (!rawBytes || rawBytes.length === 0) return false;
    this.ws.send(encodeAudioFrame(rawBytes));
    return true;
  }

  sendAudioPcm16(pcm16Buffer, inputSampleRate = PERSONAPLEX_SAMPLE_RATE) {
    const resampled = resamplePcm16(pcm16Buffer, inputSampleRate, PERSONAPLEX_SAMPLE_RATE);
    return this.sendAudioFrame(resampled);
  }

  sendControl(action) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(encodeControl(action));
    return true;
  }

  ping() {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(encodePing());
    return true;
  }

  disconnect() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushPendingSentence();
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      try {
        sock.removeAllListeners();
        sock.on('error', () => {});
        if (sock.readyState === 1) sock.close();
        else if (typeof sock.terminate === 'function') sock.terminate();
      } catch {}
    }
    this.isConnected = false;
    this.handshakeReady = false;
  }
}

module.exports = {
  PersonaPlexClient,
  PERSONAPLEX_SAMPLE_RATE,
  PERSONAPLEX_VOICES,
  resamplePcm16
};
