/**
 * gemini-live-client.js - Cliente WebSocket para Gemini Multimodal Live API en Node.js/Electron
 */

const WebSocket = require('ws');

class GeminiLiveClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.mode = options.mode || 'transcribe_live'; // 'transcribe_live' | 'translate_audio'
    this.model = options.model || (this.mode === 'transcribe_live' ? 'models/gemini-3.5-transcribe-live' : 'models/gemini-2.5-flash-native-audio-latest');
    this.voiceName = options.voiceName || 'Puck';
    this.sourceLang = options.sourceLang || 'es-ES';
    this.targetLang = options.targetLang || 'en';
    this.customVocabulary = options.customVocabulary || [];
    this.ws = null;
    this.isConnected = false;

    this.onAudioReceived = options.onAudioReceived || null;
    this.onTextReceived = options.onTextReceived || null;
    this.onInterrupted = options.onInterrupted || null;
    this.onError = options.onError || null;
    this.onClose = options.onClose || null;
    this.onOpen = options.onOpen || null;
  }

  getLanguageNames() {
    const map = {
      'es': 'Spanish',
      'es-ES': 'Spanish',
      'en': 'English',
      'en-US': 'English',
      'pt': 'Portuguese',
      'pt-BR': 'Portuguese',
      'fr': 'French',
      'de': 'German',
      'it': 'Italian',
      'auto': 'the detected speaker language'
    };
    const src = map[this.sourceLang] || 'Spanish';
    const tgt = map[this.targetLang] || 'English';
    return { src, tgt };
  }

  connect() {
    if (!this.apiKey || this.apiKey.trim().length < 5) {
      console.error('[Gemini Live Electron] Error: Se requiere ingresar una API Key en el campo de configuración.');
      if (this.onError) this.onError(new Error('Ingresa una API Key en el campo de configuración.'));
      return;
    }

    const cleanKey = this.apiKey.trim();
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(cleanKey)}`;
    console.log(`[Gemini Live Electron] Conectando a Google Gemini Live (${this.mode} - ${this.model})...`);

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[Gemini Live Electron] Error instanciando WebSocket:', err);
      if (this.onError) this.onError(err);
      return;
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

    const { src, tgt } = this.getLanguageNames();
    const vocabList = Array.isArray(this.customVocabulary) && this.customVocabulary.length > 0
      ? `\nCustom vocabulary and technical terms to recognize accurately: ${this.customVocabulary.join(', ')}.`
      : '';

    let setupMsg;

    if (this.mode === 'transcribe_live') {
      const systemPrompt = `You are an ultra-fast, intelligent real-time speech-to-text transcriber (Gemini 3.5 Transcribe Live).
Transcribe incoming spoken ${src} with maximum precision.
CRITICAL SMART TRANSCRIPTION RULES:
1. Clean up disfluencies: remove filler words ("um", "uh", "eh", "este", "o sea") and smoothly resolve self-corrections into the intended phrase.
2. Output clear, well-punctuated, capitalized text in real-time.
3. Output ONLY the transcribed words. Zero commentary, zero preamble, zero markdown formatting.${vocabList}
4. If unintelligible or pure silence/noise, output nothing.`;

      setupMsg = {
        setup: {
          model: this.model,
          generationConfig: {
            responseModalities: ["TEXT"]
          },
          contextWindowCompression: {
            triggerTokens: "104857",
            slidingWindow: { targetTokens: "52428" }
          },
          systemInstruction: {
            parts: [
              { text: systemPrompt }
            ]
          }
        }
      };
    } else {
      const targetStyle = tgt === 'Spanish'
        ? 'fluent, natural, idiomatic neutral Latin American Spanish'
        : (tgt === 'English'
          ? 'fluent, natural, idiomatic North American English with a native American business tone'
          : `fluent, natural, idiomatic ${tgt}`);
      const systemPrompt = `You are a professional simultaneous interpreter for executive corporate video calls.
Translate spoken ${src} into ${targetStyle}.
CRITICAL RULES:
1. Translate smoothly and idiomatically. Avoid awkward, literal, or robotic translations.
2. Output ONLY the direct translated spoken audio in clear native ${tgt}.
3. Zero commentary, zero internal monologue, zero markdown, zero explanations.${vocabList}
4. If unintelligible or background noise, output absolute silence.`;

      setupMsg = {
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
            },
            thinkingConfig: {
              thinkingBudget: 0
            }
          },
          systemInstruction: {
            parts: [
              { text: systemPrompt }
            ]
          }
        }
      };
    }

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

    // Notificar interrupción si el usuario empezó a hablar de nuevo
    if (response.serverContent.interrupted && this.onInterrupted) {
      this.onInterrupted();
    }

    const parts = response.serverContent.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.text && this.onTextReceived) {
        // Filtrar encabezados residuales si existieran
        const cleanText = part.text
          .replace(/^\*\*.*?\*\*\s*/gs, '')
          .replace(/^I've (?:directly )?translated.*?:/gi, '')
          .trim();
        if (cleanText.length > 0) {
          this.onTextReceived(cleanText);
        }
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
      const sock = this.ws;
      this.ws = null;
      this.isConnected = false;
      try {
        sock.removeAllListeners();
        sock.on('error', () => {});
        if (sock.readyState === WebSocket.OPEN) sock.close();
        else sock.terminate();
      } catch (e) {}
    }
    this.isConnected = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeminiLiveClient;
}

