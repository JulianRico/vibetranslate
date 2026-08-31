/**
 * voxcpm-service.js - Servicio de Integración con el Motor VoxCPM Local/Remoto
 * ============================================================================
 * Proporciona:
 * - Síntesis ultrarrápida (<100ms) vía WebSocket Streaming
 * - Clonación Zero-Shot con perfiles de voz locales
 * - Fallback automático a REST HTTP
 * - Audio de alta fidelidad 48kHz para el Micrófono Virtual
 * ============================================================================
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { defaultLogger } = require('./logger');

class VoxCPMService {
  constructor(options = {}) {
    this.serverHost = options.host || '127.0.0.1';
    this.serverPort = options.port || 8765;
    this.baseUrl = `http://${this.serverHost}:${this.serverPort}`;
    this.wsUrl = `ws://${this.serverHost}:${this.serverPort}/v1/tts/live`;
    this.activeVoiceId = options.voiceId || 'default';
    this.ws = null;
    this.isConnected = false;
    this.audioCallbacks = new Map();
  }

  /**
   * Verifica si el servidor VoxCPM está en línea y si cuenta con GPU CUDA activa.
   */
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseUrl}/health`, { timeout: 2000 }, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(rawData);
            defaultLogger.info('VOXCPM', `✅ Servidor activo en ${data.device.toUpperCase()} (GPU: ${data.gpu_name || 'N/A'})`);
            resolve({ online: true, ...data });
          } catch (e) {
            resolve({ online: false, error: e.message });
          }
        });
      });

      req.on('error', (err) => {
        defaultLogger.warn('VOXCPM', `⚠️ Servidor VoxCPM no detectado en ${this.baseUrl} (${err.message})`);
        resolve({ online: false, error: err.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ online: false, error: 'Timeout' });
      });
    });
  }

  /**
   * Inicializa la conexión persistente por WebSocket para streaming de latencia mínima.
   */
  initWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.on('open', () => {
        this.isConnected = true;
        defaultLogger.info('VOXCPM', '⚡ Conexión WebSocket establecida con VoxCPM.');
        // Registrar voz activa
        this.ws.send(JSON.stringify({
          type: 'set_voice',
          voice_id: this.activeVoiceId
        }));
      });

      this.ws.on('message', (data, isBinary) => {
        if (isBinary) {
          // Chunk de audio PCM 16-bit 48kHz
          const audioBuffer = Buffer.from(data);
          this.onReceiveAudioChunk(audioBuffer);
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'audio_meta') {
              defaultLogger.info('VOXCPM', `🔊 Audio generado en ${msg.latency_ms}ms (${msg.pcm_bytes_length} bytes)`);
            }
          } catch (e) {}
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        defaultLogger.warn('VOXCPM', '🔌 WebSocket desconectado. Reintentando en 3s...');
        setTimeout(() => this.initWebSocket(), 3000);
      });

      this.ws.on('error', (err) => {
        defaultLogger.error('VOXCPM', `❌ Error en WebSocket VoxCPM: ${err.message}`);
      });
    } catch (e) {
      defaultLogger.error('VOXCPM', `❌ No se pudo conectar a WebSocket VoxCPM: ${e.message}`);
    }
  }

  /**
   * Registra un listener para recibir los chunks de audio generados en streaming.
   */
  onReceiveAudioChunk(buffer) {
    if (typeof this.onAudioChunkCallback === 'function') {
      this.onAudioChunkCallback(buffer);
    }
  }

  setAudioChunkListener(callback) {
    this.onAudioChunkCallback = callback;
  }

  /**
   * Envía texto en tiempo real al WebSocket de VoxCPM para generar audio inmediatamente (<100ms).
   */
  streamText(text, language = 'en') {
    if (!text || !text.trim()) return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'synthesize',
        text: text.trim(),
        voice_id: this.activeVoiceId,
        language: language
      }));
    } else {
      defaultLogger.warn('VOXCPM', 'WebSocket no disponible. Usando fallback HTTP...');
      return this.synthesizeTTS({ text, language });
    }
  }

  /**
   * Síntesis directa vía REST HTTP (devuelve Buffer WAV).
   */
  async synthesizeTTS({ text, voiceId = null, language = 'en' }) {
    if (!text || !text.trim()) {
      throw new Error('El texto no puede estar vacío');
    }

    const payload = JSON.stringify({
      text: text.trim(),
      voice_id: voiceId || this.activeVoiceId,
      language: language,
      format: 'wav'
    });

    return new Promise((resolve, reject) => {
      const req = http.request(`${this.baseUrl}/v1/tts/synthesize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Error ${res.statusCode} en VoxCPM`));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const audioBuffer = Buffer.concat(chunks);
          resolve(audioBuffer);
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  /**
   * Sube un audio de referencia (3 a 10s) para clonar la voz del usuario.
   */
  async registerVoiceProfile(voiceId, audioBuffer) {
    const payload = JSON.stringify({
      voice_id: voiceId,
      audio_base64: audioBuffer.toString('base64')
    });

    return new Promise((resolve, reject) => {
      const req = http.request(`${this.baseUrl}/v1/voice/clone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            this.activeVoiceId = voiceId;
            defaultLogger.info('VOXCPM', `🎙️ Voz '${voiceId}' clonada y configurada como activa.`);
            resolve(data);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { VoxCPMService };
