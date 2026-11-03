/**
 * fish-audio-service.js - Servicio Completo de Integración con Fish Audio AI
 * =========================================================================
 * Soporte para:
 * - Síntesis TTS en tiempo real (REST y WebSocket Streaming)
 * - Clonación de voz (Voice Cloning con audio de referencia y modelos persistentes)
 * - Consulta y gestión de modelos de voz (propios y de catálogo)
 * - Caché de baja latencia y conmutación automática de modelos (s2.1-pro-free / s2.1-pro)
 */

const WebSocket = require('ws');
const { defaultLogger } = require('./logger');

class FishAudioService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.defaultModel = options.model || 's2.1-pro-free';
    this.defaultVoiceId = options.voiceId || null;
    this.baseUrl = 'https://api.fish.audio';
    this.wsUrl = 'wss://api.fish.audio/v1/tts/live';
    this.ttsCache = new Map(); // Cache simple para respuestas idénticas recientes
  }

  setApiKey(key) {
    if (key && key.trim()) {
      this.apiKey = key.trim();
    }
  }

  /**
   * Realiza síntesis de texto a voz (TTS) ultrarrápida vía REST API.
   * Retorna un Buffer con el audio sintetizado (por defecto MP3).
   */
  async synthesizeTTS({ text, voiceModelId = null, model = null, format = 'mp3', latency = 'balanced' }) {
    if (!text || !text.trim()) {
      throw new Error('El texto para sintetizar no puede estar vacío');
    }
    if (!this.apiKey) {
      throw new Error('Fish Audio API Key no configurada');
    }

    const cleanText = text.trim();
    const activeModel = model || this.defaultModel || 's2.1-pro-free';
    const activeVoiceId = voiceModelId || this.defaultVoiceId || null;

    // Verificar si está en caché (clave: modelo + voz + texto)
    const cacheKey = `${activeModel}_${activeVoiceId || 'default'}_${format}_${cleanText}`;
    if (this.ttsCache.has(cacheKey)) {
      defaultLogger.info('FISH-AUDIO', `⚡ Audio recuperado de caché para: "${cleanText.substring(0, 30)}..."`);
      return this.ttsCache.get(cacheKey);
    }

    const payload = {
      text: cleanText,
      format: format,
      latency: latency,
      normalize: true
    };

    if (activeVoiceId && activeVoiceId !== 'default' && activeVoiceId !== 'none') {
      payload.reference_id = activeVoiceId;
    }

    const startTime = Date.now();

    // Intentar con el modelo especificado; si falla por 402 (créditos) y no era free, conmutar a s2.1-pro-free
    const modelsToTry = [activeModel];
    if (activeModel !== 's2.1-pro-free') {
      modelsToTry.push('s2.1-pro-free');
    }

    let lastError = null;

    for (const currentModel of modelsToTry) {
      try {
        defaultLogger.info('FISH-AUDIO', `Sintetizando con modelo [${currentModel}] (${activeVoiceId ? `Voz: ${activeVoiceId}` : 'Voz estándar'}): "${cleanText.substring(0, 40)}..."`);

        const response = await fetch(`${this.baseUrl}/v1/tts`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'model': currentModel
          },
          body: JSON.stringify(payload)
        });

        const elapsed = Date.now() - startTime;

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          defaultLogger.success('FISH-AUDIO', `✅ TTS sintetizado exitosamente en ${elapsed}ms (${buffer.byteLength} bytes, modelo: ${currentModel})`);

          // Guardar en caché (máximo 50 elementos)
          if (this.ttsCache.size > 50) {
            const firstKey = this.ttsCache.keys().next().value;
            this.ttsCache.delete(firstKey);
          }
          this.ttsCache.set(cacheKey, buffer);

          return {
            success: true,
            audioBuffer: buffer,
            format: format,
            model: currentModel,
            elapsedMs: elapsed
          };
        } else {
          const errBody = await response.text();
          defaultLogger.warn('FISH-AUDIO', `HTTP ${response.status} en modelo ${currentModel}: ${errBody}`);
          lastError = new Error(`HTTP ${response.status}: ${errBody}`);

          // Si es 402 (sin créditos) y tenemos más modelos para intentar, continuar
          if (response.status === 402 && modelsToTry.length > 1) {
            continue;
          }
        }
      } catch (err) {
        defaultLogger.error('FISH-AUDIO', `Excepción sintetizando con ${currentModel}: ${err.message}`);
        lastError = err;
      }
    }

    throw lastError || new Error('No fue posible sintetizar audio con Fish Audio');
  }

  /**
   * Obtiene la lista de modelos de voz disponibles (propios del usuario y catálogo).
   */
  async listVoiceModels({ selfOnly = false, pageSize = 30, pageNumber = 1 } = {}) {
    if (!this.apiKey) {
      return { total: 0, items: [] };
    }

    try {
      const url = `${this.baseUrl}/model?page_size=${pageSize}&page_number=${pageNumber}${selfOnly ? '&self_only=true' : ''}&sort_by=score`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        const err = await response.text();
        defaultLogger.warn('FISH-AUDIO', `Error consultando modelos (${response.status}): ${err}`);
        return { total: 0, items: [] };
      }

      const data = await response.json();
      return data;
    } catch (err) {
      defaultLogger.error('FISH-AUDIO', `Error en listVoiceModels: ${err.message}`);
      return { total: 0, items: [] };
    }
  }

  /**
   * Crea un nuevo clon de voz persistente en Fish Audio a partir de un archivo o buffer de audio.
   * Utiliza multipart/form-data contra POST /model.
   */
  async createVoiceClone({ title, audioBuffer, audioMimeType = 'audio/wav', sampleText = '', description = '', visibility = 'private' }) {
    if (!this.apiKey) {
      throw new Error('API Key requerida para crear clon de voz');
    }
    if (!title || !title.trim()) {
      throw new Error('El título del modelo de voz es obligatorio');
    }
    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error('La muestra de audio no puede estar vacía');
    }

    defaultLogger.info('FISH-AUDIO', `🎙️ Creando modelo de clonación de voz: "${title}" (${audioBuffer.length} bytes)...`);

    try {
      const formData = new FormData();
      formData.append('type', 'tts');
      formData.append('title', title.trim());
      formData.append('train_mode', 'fast');
      formData.append('visibility', visibility || 'private');
      if (description) {
        formData.append('description', description);
      }

      // Convertir audio buffer a Blob
      const audioBlob = new Blob([audioBuffer], { type: audioMimeType });
      const filename = audioMimeType.includes('wav') ? 'voice_sample.wav' : 'voice_sample.mp3';
      formData.append('voices', audioBlob, filename);

      if (sampleText && sampleText.trim()) {
        formData.append('texts', sampleText.trim());
      }

      const startTime = Date.now();
      const response = await fetch(`${this.baseUrl}/model`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: formData
      });

      const elapsed = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text();
        defaultLogger.error('FISH-AUDIO', `Error HTTP ${response.status} al crear clon de voz: ${errText}`);
        return { success: false, error: errText, status: response.status };
      }

      const result = await response.json();
      defaultLogger.success('FISH-AUDIO', `🎉 Clon de voz creado exitosamente en ${elapsed}ms! ID: ${result._id || result.id}`);

      return {
        success: true,
        modelId: result._id || result.id,
        modelData: result,
        elapsedMs: elapsed
      };
    } catch (err) {
      defaultLogger.error('FISH-AUDIO', `Excepción al crear clon de voz: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Valida la API Key consultando el endpoint de modelos.
   */
  async testConnection(apiKey = null) {
    const key = apiKey || this.apiKey;
    if (!key) {
      return { ok: false, message: 'API Key no proporcionada' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/model?page_size=1`, {
        headers: {
          'Authorization': `Bearer ${key.trim()}`
        }
      });

      if (response.ok) {
        return { ok: true, message: 'Conexión con Fish Audio exitosa y API Key válida' };
      } else {
        const err = await response.text();
        return { ok: false, message: `Error HTTP ${response.status}: ${err}` };
      }
    } catch (err) {
      return { ok: false, message: `Error de conexión: ${err.message}` };
    }
  }
}

/**
 * FishAudioStreamer - Cliente de streaming en tiempo real vía WebSocket.
 */
class FishAudioStreamer {
  constructor(apiKey, voiceModelId = null, model = 's2.1-pro-free') {
    this.apiKey = apiKey;
    this.voiceModelId = voiceModelId;
    this.model = model;
    this.ws = null;
    this.isConnected = false;
    this.wsUrl = 'wss://api.fish.audio/v1/tts/live';
    this.onAudioChunk = null;
    this.onError = null;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'model': this.model
          }
        });

        this.ws.on('open', () => {
          defaultLogger.info('FISH-AUDIO-WS', '✅ Conexión WebSocket establecida con Fish Audio Live');
          this.isConnected = true;

          // Iniciar sesión con evento start
          const startPayload = {
            event: 'start',
            request: {
              text: '',
              format: 'mp3',
              latency: 'balanced'
            }
          };
          if (this.voiceModelId && this.voiceModelId !== 'default') {
            startPayload.request.reference_id = this.voiceModelId;
          }
          this.ws.send(JSON.stringify(startPayload));
          resolve();
        });

        this.ws.on('message', (data, isBinary) => {
          if (isBinary || Buffer.isBuffer(data)) {
            if (this.onAudioChunk) {
              this.onAudioChunk(data);
            }
          }
        });

        this.ws.on('error', (error) => {
          defaultLogger.error('FISH-AUDIO-WS', `❌ Error en WebSocket: ${error.message}`);
          if (this.onError) this.onError(error);
          reject(error);
        });

        this.ws.on('close', (code, reason) => {
          defaultLogger.info('FISH-AUDIO-WS', `🔌 Conexión WebSocket cerrada (${code})`);
          this.isConnected = false;
          if (this.onClose) this.onClose({ code, reason });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  sendTextChunk(text) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      defaultLogger.warn('FISH-AUDIO-WS', 'WebSocket no está conectado para enviar chunk de texto.');
      return;
    }
    const payload = {
      event: 'text',
      text: text
    };
    this.ws.send(JSON.stringify(payload));
  }

  finish() {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'finish' }));
    }
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
      this.isConnected = false;
    }
  }
}

module.exports = {
  FishAudioService,
  FishAudioStreamer
};
