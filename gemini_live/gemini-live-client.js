/**
 * gemini-live-client.js - Cliente WebSocket para Gemini Multimodal Live API
 * =========================================================================
 * Maneja la conexión bidireccional streaming en tiempo real (Audio-to-Audio)
 * utilizando el endpoint BidiGenerateContent por WebSockets.
 */

class GeminiLiveClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'models/gemini-2.0-flash-exp';
    this.voiceName = options.voiceName || 'Puck'; // Puck, Charon, Kore, Fenrir, Aoede
    this.targetLanguage = options.targetLanguage || 'en';
    this.ws = null;
    this.isConnected = false;

    // Callbacks de eventos
    this.onAudioReceived = options.onAudioReceived || null; // callback(pcm24kUint8Array, pcm24kBase64)
    this.onTextReceived = options.onTextReceived || null;   // callback(textSpan)
    this.onError = options.onError || null;                 // callback(error)
    this.onClose = options.onClose || null;                 // callback()
    this.onOpen = options.onOpen || null;                   // callback()
  }

  /**
   * Conecta al servidor de Gemini Live e inicia el apretón de manos (setup).
   */
  connect() {
    if (!this.apiKey) {
      console.error('[Gemini Live] Error: Se requiere una API Key válida.');
      if (this.onError) this.onError(new Error('Se requiere API Key de Gemini.'));
      return;
    }

    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;
    
    console.log('[Gemini Live] Conectando a Gemini Live WebSocket...');
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[Gemini Live] 🟢 Conexión WebSocket establecida. Enviando mensaje de setup...');
      this.isConnected = true;
      this.sendSetupHandshake();
      if (this.onOpen) this.onOpen();
    };

    this.ws.onmessage = async (event) => {
      try {
        let textData = event.data;
        if (event.data instanceof Blob) {
          textData = await event.data.text();
        }
        const response = JSON.parse(textData);
        this.handleServerMessage(response);
      } catch (err) {
        console.warn('[Gemini Live] Error procesando mensaje del servidor:', err);
      }
    };

    this.ws.onerror = (evt) => {
      console.error('[Gemini Live] 🔴 Error en WebSocket:', evt);
      if (this.onError) this.onError(evt);
    };

    this.ws.onclose = (evt) => {
      console.log('[Gemini Live] ⚪ Conexión WebSocket cerrada.');
      this.isConnected = false;
      if (this.onClose) this.onClose(evt);
    };
  }

  /**
   * Envía el mensaje de configuración inicial (setup) a Gemini Live.
   */
  sendSetupHandshake() {
    const setupMsg = {
      setup: {
        model: this.model,
        generationConfig: {
          responseModalities: ["AUDIO"],
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
              text: `You are a real-time simultaneous audio interpreter translating from Spanish to English. You will receive real-time streaming audio of a speaker speaking Spanish. Your goal is to translate what they say into English in real time. Speak ONLY the English translation with natural intonation. Do not add intro text, greetings, comments, or explanations.`
            }
          ]
        }
      }
    };

    this.sendJson(setupMsg);
  }

  /**
   * Transmite un trozo (chunk) de audio PCM 16kHz Mono codificado en Base64 a Gemini Live.
   */
  sendRealtimeAudioChunk(pcm16kBase64) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const audioMsg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: pcm16kBase64
          }
        ]
      }
    };

    this.sendJson(audioMsg);
  }

  /**
   * Procesa los mensajes recibidos del servidor Gemini Live.
   */
  handleServerMessage(response) {
    if (!response || !response.serverContent) return;

    const serverContent = response.serverContent;

    if (serverContent.modelTurn && serverContent.modelTurn.parts) {
      for (const part of serverContent.modelTurn.parts) {
        // 1. Audio retornado (PCM 24kHz Base64)
        if (part.inlineData && part.inlineData.data) {
          const audioBase64 = part.inlineData.data;
          const rawBytes = base64ToUint8Array(audioBase64);
          
          if (this.onAudioReceived) {
            this.onAudioReceived(rawBytes, audioBase64);
          }
        }

        // 2. Transcripción o texto retornado
        if (part.text) {
          if (this.onTextReceived) {
            this.onTextReceived(part.text);
          }
        }
      }
    }
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
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
