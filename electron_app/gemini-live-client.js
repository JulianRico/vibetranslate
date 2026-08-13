/**
 * gemini-live-client.js - Cliente WebSocket para Gemini Multimodal Live API en Node.js/Electron
 */

const WebSocket = require('ws');

class GeminiLiveClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'models/gemini-2.0-flash-exp';
    this.voiceName = options.voiceName || 'Puck';
    this.targetLanguage = options.targetLanguage || 'en';
    this.ws = null;
    this.isConnected = false;

    this.onAudioReceived = options.onAudioReceived || null;
    this.onTextReceived = options.onTextReceived || null;
    this.onError = options.onError || null;
    this.onClose = options.onClose || null;
    this.onOpen = options.onOpen || null;
  }

  connect() {
    if (!this.apiKey || this.apiKey.trim().length < 5) {
      console.error('[Gemini Live Electron] Error: Se requiere ingresar una API Key en el campo de configuración.');
      if (this.onError) this.onError(new Error('Ingresa una API Key en el campo de configuración.'));
      return;
    }

    const cleanKey = this.apiKey.trim();
    let wsUrl = '';
    const wsOptions = {
      headers: {}
    };

    if (cleanKey.startsWith('AIzaSy')) {
      // Clave API de Google AI Studio
      wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;
      console.log(`[Gemini Live Electron] Conectando con API Key AI Studio (${cleanKey.substring(0, 8)}...)...`);
    } else {
      // Token OAuth2 / Bearer Token
      wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?access_token=${encodeURIComponent(cleanKey)}`;
      wsOptions.headers['Authorization'] = `Bearer ${cleanKey}`;
      console.log(`[Gemini Live Electron] Conectando con OAuth2 Access Token (${cleanKey.substring(0, 8)}...)...`);
    }

    try {
      this.ws = new WebSocket(wsUrl, wsOptions);
    } catch (e) {
      this.ws = new WebSocket(wsUrl);
    }

    this.ws.on('open', () => {
      console.log('[Gemini Live Electron] 🟢 Conexión WebSocket establecida con éxito. Enviando Handshake...');
      this.isConnected = true;
      this.sendSetupHandshake();
      if (this.onOpen) this.onOpen();
    });

    this.ws.on('message', (data) => {
      try {
        const textData = data.toString('utf-8');
        const response = JSON.parse(textData);
        this.handleServerMessage(response);
      } catch (err) {
        console.warn('[Gemini Live Electron] Error procesando respuesta:', err);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Gemini Live Electron] 🔴 Error en WebSocket:', err);
      if (this.onError) this.onError(err);
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString('utf-8') : '';
      console.log(`[Gemini Live Electron] ⚪ WebSocket cerrado (${code}: ${reasonStr})`);
      this.isConnected = false;
      if (this.onClose) this.onClose({ code, reason: reasonStr });
    });
  }

  sendSetupHandshake() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const setupMsg = {
      setup: {
        model: this.model,
        generationConfig: {
          responseModalities: ["AUDIO", "TEXT"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName
              }
            }
          }
        },
        systemInstruction: {
          parts: [
            {
              text: `You are a real-time simultaneous audio interpreter for video calls (Teams, Zoom, Google Meet). Actively listen to the incoming speech. If spoken in Spanish, translate immediately into English with natural tone and zero commentary. Return both translated spoken audio and plain translated text.`
            }
          ]
        }
      }
    };

    this.ws.send(JSON.stringify(setupMsg));
  }

  sendRealtimeAudioChunk(base64Pcm16Data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const mediaChunkMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: base64Pcm16Data
          }
        ]
      }
    };

    this.ws.send(JSON.stringify(mediaChunkMsg));
  }

  handleServerMessage(response) {
    if (!response || !response.serverContent) return;

    const parts = response.serverContent.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.text && this.onTextReceived) {
        this.onTextReceived(part.text);
      }

      if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/pcm') && this.onAudioReceived) {
        const base64Audio = part.inlineData.data;
        const rawBytes = Buffer.from(base64Audio, 'base64');
        this.onAudioReceived(rawBytes, base64Audio);
      }
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeminiLiveClient;
}
