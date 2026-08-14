/**
 * offscreen.js - Pipeline de audio, Web Speech API y Traducción IA
 * Responsabilidades:
 * 1. Recepción del streamId mediante getUserMedia en la API offscreen.
 * 2. Redirección de audio al AudioContext destination (Preservación de escucha local).
 * 3. Transcripción Speech-to-Text continua en tiempo real con Web Speech API.
 * 4. Módulo de traducción extensible (Fast API / TranslateGemma Ollama con fallback).
 * 5. Manejo seguro de memoria y detención limpia de tracks e hilos de audio.
 */

// Variables de estado global en la ventana offscreen
let currentStream = null;
let audioContext = null;
let speechRecognizer = null;
let isListening = false;
let sttWatchdogInterval = null;
let micStream = null;
let micMediaRecorder = null;
let mediaRecorderSTT = null;
let isProcessingMicChunk = false;
let isProcessingTabChunk = false;
let warnedNoTabStt = false;
let currentSettings = {
  sourceLang: 'es-ES',
  targetLang: 'en',
  engine: 'fast',
  ollamaEndpoint: 'http://localhost:11434'
};

// Memoria caché para evitar solicitudes redundantes de traducción
const translationCache = new Map();
const MAX_CACHE_SIZE = 200;

/**
 * Escuchador principal de mensajes desde background.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  (async () => {
    try {
      switch (message.type) {
        case 'START_CAPTURE':
          if (message.settings) {
            currentSettings = { ...currentSettings, ...message.settings };
          }
          await startAudioCaptureAndSTT(message.streamId);
          sendResponse({ success: true });
          break;

        case 'STOP_CAPTURE':
          await stopAudioCaptureAndSTT();
          sendResponse({ success: true });
          break;

        case 'SETTINGS_CHANGED':
          if (message.settings) {
            const langChanged = currentSettings.sourceLang !== message.settings.sourceLang;
            currentSettings = { ...currentSettings, ...message.settings };

            // Si cambió el idioma origen, reiniciar el reconocedor con la nueva configuración
            if (langChanged && isListening && speechRecognizer) {
              console.log('[MeetTranslate AI Offscreen] Cambiando idioma STT en caliente a:', currentSettings.sourceLang);
              try {
                speechRecognizer.onend = null; // Desactivar callback para evitar inicio duplicado
                speechRecognizer.stop();
              } catch (e) { }

              // Reiniciar el reconocedor de voz con el nuevo idioma tras un breve retardo
              setTimeout(() => {
                if (isListening) {
                  initSpeechRecognition();
                }
              }, 200);
            }
          }
          sendResponse({ success: true });
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('[MeetTranslate AI Offscreen] Error al procesar comando:', err);
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        error: err.message
      }).catch(() => { });
    }
  })();

  return true;
});

/**
 * Inicializa la captura del stream de la pestaña y la salida local de audio.
 */
async function startAudioCaptureAndSTT(streamId) {
  console.log('[MeetTranslate AI Offscreen] Solicitando MediaStream con streamId:', streamId);

  // Detener captura previa si existiera
  await stopAudioCaptureAndSTT();

  try {
    // 1. Obtener el stream de audio de la pestaña capturada
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    console.log('[MeetTranslate AI Offscreen] Stream de audio obtenido con éxito.');

    // 2. Preservación del Audio Local:
    // Conectar el stream al AudioContext destination para que el altavoz/auriculares reproduzcan el audio de la reunión
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const mediaStreamSource = audioContext.createMediaStreamSource(currentStream);
    mediaStreamSource.connect(audioContext.destination);

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    console.log('[MeetTranslate AI Offscreen] Audio local redirigido exitosamente a altavoces.');

    // 3. Elegir el motor STT según la configuración.
    //
    //    IMPORTANTE: la Web Speech API de Chrome SOLO escucha el micrófono
    //    predeterminado del sistema. NO puede transcribir el audio de la pestaña,
    //    es decir, no puede oír al participante remoto. Por eso:
    //
    //      - 'webspeech'  ➔ solo dirección SALIENTE (mi voz ➔ inglés al receptor).
    //      - 'whisper_*'  ➔ ambas direcciones, con MediaRecorder sobre micrófono
    //                       (saliente) y sobre el audio de la pestaña (entrante).
    const sttEngine = currentSettings.sttEngine || 'webspeech';
    const usesWhisper = sttEngine.startsWith('whisper_');

    if (usesWhisper) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        startMicAudioRecorder(micStream);
        console.log('[MeetTranslate AI Offscreen] Micrófono local capturado para STT saliente (Whisper).');
      } catch (micErr) {
        console.warn('[MeetTranslate AI Offscreen] Micrófono local no accesible:', micErr);
      }
      startTabAudioRecorder();
    } else {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('[MeetTranslate AI Offscreen] Micrófono local activado en documento Offscreen para WebSpeech API.');
      } catch (micErr) {
        console.warn('[MeetTranslate AI Offscreen] Error al solicitar micrófono para WebSpeech:', micErr);
      }
      initSpeechRecognition();
      console.warn('[MeetTranslate AI Offscreen] Motor "webspeech": la voz del participante ' +
        'remoto NO se transcribirá. Para traducir al receptor hacia el español, ' +
        'configura Groq Whisper o Whisper local en el popup.');
    }

  } catch (error) {
    console.error('[MeetTranslate AI Offscreen] Error obteniendo streams de audio:', error);
    throw error;
  }
}

/**
 * Graba fragmentos del micrófono local del usuario (dirección SALIENTE).
 */
function startMicAudioRecorder(stream) {
  if (!stream) return;
  try {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    micMediaRecorder = new MediaRecorder(stream, { mimeType });

    micMediaRecorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 2000 && !isProcessingMicChunk) {
        isProcessingMicChunk = true;
        try {
          await processAudioChunk(event.data, 'outgoing');
        } catch (e) {
        } finally {
          isProcessingMicChunk = false;
        }
      }
    };

    micMediaRecorder.start(2500);
    console.log('[MeetTranslate AI Offscreen] Pipeline MediaRecorder para Micrófono Local iniciado.');
  } catch (err) {
    console.warn('[MeetTranslate AI Offscreen] Error en micMediaRecorder:', err);
  }
}

/**
 * Graba fragmentos de audio continuo del stream de la pestaña (dirección ENTRANTE:
 * la voz del participante remoto). Resuelve la limitación de la Web Speech API de
 * Chrome, que solo escucha el micrófono local.
 */
function startTabAudioRecorder() {
  if (!currentStream) return;

  try {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorderSTT = new MediaRecorder(currentStream, { mimeType });

    mediaRecorderSTT.ondataavailable = async (event) => {
      if (event.data && event.data.size > 2000 && !isProcessingTabChunk) {
        isProcessingTabChunk = true;
        try {
          await processAudioChunk(event.data, 'incoming');
        } catch (e) {
          console.warn('[MeetTranslate AI Offscreen] Excepción procesando fragmento de audio de pestaña:', e);
        } finally {
          isProcessingTabChunk = false;
        }
      }
    };

    // Capturar fragmentos de audio cada 2.5 segundos para transcripción continua
    mediaRecorderSTT.start(2500);
    console.log('[MeetTranslate AI Offscreen] Pipeline MediaRecorder para Audio de Pestaña iniciado.');
  } catch (err) {
    console.error('[MeetTranslate AI Offscreen] Error al iniciar MediaRecorder de pestaña:', err);
  }
}

/**
 * Determina el par de idiomas según quién está hablando.
 *
 *   sourceLang = el idioma que hablo YO       (por defecto es-ES)
 *   targetLang = el idioma que habla el OTRO  (por defecto en)
 *
 *   'outgoing' (mi micrófono)      ➔ yo   ➔ el otro   (es ➔ en)
 *   'incoming' (audio de pestaña)  ➔ otro ➔ yo        (en ➔ es)
 */
function langPairFor(direction) {
  let mine = currentSettings.sourceLang || 'es-ES';
  let theirs = currentSettings.targetLang || 'en';

  const mineShort = mine.substring(0, 2);
  let theirsShort = theirs.substring(0, 2);

  // Si Origen y Destino coinciden (ej. ambos seleccionados en 'es'), el receptor habla el idioma opuesto ('en')
  if (theirsShort === mineShort && theirs !== 'auto') {
    theirsShort = mineShort === 'es' ? 'en' : 'es';
    theirs = theirsShort;
  }

  if (direction === 'incoming') {
    return { src: theirs, tgt: mine };
  }
  return { src: mine, tgt: theirs };
}

/**
 * Transcribe un fragmento de audio con Whisper (Groq / OpenAI / Local).
 * El idioma de transcripción depende de la dirección: el audio de la pestaña
 * viene en el idioma del participante remoto, no en el mío.
 */
async function processAudioChunk(blob, direction) {
  const sttEngine = currentSettings.sttEngine || 'webspeech';
  const { src } = langPairFor(direction);
  let transcribedText = '';

  if (sttEngine === 'whisper_groq') {
    transcribedText = await transcribeWithGroq(blob, currentSettings.groqApiKey, src);
  } else if (sttEngine === 'whisper_openai') {
    transcribedText = await transcribeWithOpenAI(blob, currentSettings.openaiApiKey, src);
  } else if (sttEngine === 'whisper_local') {
    transcribedText = await transcribeWithLocalWhisper(blob, currentSettings.whisperEndpoint, src);
  } else {
    // 'webspeech' no puede transcribir blobs; avisar una sola vez y salir.
    if (!warnedNoTabStt) {
      warnedNoTabStt = true;
      console.warn('[MeetTranslate AI Offscreen] El motor "webspeech" no transcribe fragmentos ' +
        'grabados. Configura Groq Whisper o Whisper local para la dirección "' + direction + '".');
    }
    return;
  }

  if (transcribedText && transcribedText.trim().length > 0) {
    const etiqueta = direction === 'incoming' ? 'Voz del participante remoto' : 'Mi voz (micrófono)';
    console.log('[MeetTranslate AI Offscreen] ' + etiqueta + ' transcrita:', transcribedText);
    await handleTranscription(transcribedText.trim(), true, direction);
  }
}

/**
 * Transcripción con Groq Whisper API (Gratis, Ultrarrápida ~100ms)
 */
async function transcribeWithGroq(blob, apiKey, sourceLang) {
  if (!apiKey) return '';
  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('response_format', 'json');
  if (sourceLang && sourceLang !== 'auto') {
    formData.append('language', sourceLang.substring(0, 2));
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  } catch (err) {
    console.warn('[MeetTranslate AI Offscreen] Error en Groq Whisper:', err);
    return '';
  }
}

/**
 * Transcripción con OpenAI Whisper API
 */
async function transcribeWithOpenAI(blob, apiKey, sourceLang) {
  if (!apiKey) return '';
  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  if (sourceLang && sourceLang !== 'auto') {
    formData.append('language', sourceLang.substring(0, 2));
  }

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });

    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  } catch (err) {
    console.warn('[MeetTranslate AI Offscreen] Error en OpenAI Whisper:', err);
    return '';
  }
}

/**
 * Transcripción con Servidor Local Whisper / Ollama
 */
async function transcribeWithLocalWhisper(blob, endpoint, sourceLang) {
  const baseUrl = (endpoint || 'http://localhost:8000').replace(/\/$/, '');
  const url = `${baseUrl}/v1/audio/transcriptions`;
  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  if (sourceLang && sourceLang !== 'auto') {
    formData.append('language', sourceLang.substring(0, 2));
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  } catch (err) {
    console.warn('[MeetTranslate AI Offscreen] Error en Local Whisper:', err);
    return '';
  }
}

/**
 * Configura e inicia Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 */
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    const errorMsg = 'Web Speech API no está soportada en este navegador.';
    console.error('[MeetTranslate AI Offscreen]', errorMsg);
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: errorMsg }).catch(() => { });
    return;
  }

  speechRecognizer = new SpeechRecognition();
  speechRecognizer.continuous = true;
  speechRecognizer.interimResults = true;
  let speechLang = currentSettings.sourceLang || 'es-ES';
  if (speechLang === 'auto') {
    speechLang = 'es-ES'; // Configuración base para captura multi-idioma en Web Speech API
  }
  speechRecognizer.lang = speechLang;
  speechRecognizer.maxAlternatives = 1;

  let geminiLiveClient = null;
  let geminiScriptNode = null;
  let geminiAudioReader = null;

  async function startGeminiLiveAudioStream(stream) {
    if (!stream || !currentSettings.geminiApiKey) {
      console.warn('[Gemini Live Offscreen] No hay stream de micrófono o falta la Gemini API Key.');
      return;
    }

    geminiLiveClient = new GeminiLiveClient({
      apiKey: currentSettings.geminiApiKey,
      voiceName: currentSettings.geminiVoice || 'Puck',
      onAudioReceived: async (rawBytes, base64Data) => {
        try {
          const arrayBuffer = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);

          chrome.runtime.sendMessage({
            type: 'GEMINI_LIVE_AUDIO_OUT',
            audioData: Array.from(new Uint8Array(arrayBuffer))
          });
        } catch (err) {
          console.warn('[Gemini Live Offscreen] Error procesando audio de salida:', err);
        }
      },
      onTextReceived: (textSpan) => {
        chrome.runtime.sendMessage({
          type: 'STT_RESULT',
          text: textSpan,
          translated: textSpan,
          direction: 'outgoing'
        });
      },
      onError: (err) => {
        console.error('[Gemini Live Offscreen] Error en Gemini Live Client:', err);
      }
    });

    geminiLiveClient.connect();

    const track = stream.getAudioTracks()[0];
    if (!track) {
      console.warn('[Gemini Live Offscreen] No hay track de audio en el stream.');
      return;
    }

    try {
      if (typeof MediaStreamTrackProcessor !== 'undefined') {
        const processor = new MediaStreamTrackProcessor({ track });
        geminiAudioReader = processor.readable.getReader();

        console.log('[Gemini Live Offscreen] 🚀 MediaStreamTrackProcessor iniciado exitosamente.');

        while (geminiLiveClient && geminiLiveClient.isConnected) {
          const { done, value: audioFrame } = await geminiAudioReader.read();
          if (done) break;

          try {
            const sampleRate = audioFrame.sampleRate || 48000;
            const numberOfFrames = audioFrame.numberOfFrames;
            const numberOfChannels = audioFrame.numberOfChannels || 1;
            const buffer = new Float32Array(numberOfFrames * numberOfChannels);

            audioFrame.copyTo(buffer, { planeIndex: 0 });
            audioFrame.close();

            const resampled16k = resampleTo16kHZ(buffer, sampleRate);
            const pcm16Buffer = floatTo16BitPCM(resampled16k);
            const pcm16Base64 = arrayBufferToBase64(pcm16Buffer);

            geminiLiveClient.sendRealtimeAudioChunk(pcm16Base64);
          } catch (frameErr) {
            if (audioFrame && audioFrame.close) audioFrame.close();
          }
        }
      } else {
        if (!audioContext || audioContext.state === 'closed') {
          audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const micSource = audioContext.createMediaStreamSource(stream);
        const sampleRate = audioContext.sampleRate;
        geminiScriptNode = audioContext.createScriptProcessor(4096, 1, 1);

        geminiScriptNode.onaudioprocess = (e) => {
          if (!geminiLiveClient || !geminiLiveClient.isConnected) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const resampled16k = resampleTo16kHZ(inputData, sampleRate);
          const pcm16Buffer = floatTo16BitPCM(resampled16k);
          const pcm16Base64 = arrayBufferToBase64(pcm16Buffer);
          geminiLiveClient.sendRealtimeAudioChunk(pcm16Base64);
        };

        micSource.connect(geminiScriptNode);
        geminiScriptNode.connect(audioContext.destination);
      }
    } catch (err) {
      console.error('[Gemini Live Offscreen] Error en el procesador de audio:', err);
    }
  }

  speechRecognizer.onstart = () => {
    isListening = true;
    console.log('[MeetTranslate AI Offscreen] Reconocedor de voz iniciado. Idioma:', speechRecognizer.lang);
  };

  let processedWordIndex = 0;

  speechRecognizer.onresult = async (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      const text = result[0].transcript;

      if (result.isFinal) {
        finalTranscript += text;
      } else {
        interimTranscript += text;
      }
    }

    const currentFullText = (finalTranscript || interimTranscript).trim();
    if (!currentFullText) return;

    const words = currentFullText.split(/\s+/);
    const isFinal = finalTranscript.length > 0;
    const newWords = words.slice(processedWordIndex);

    // Interpretación simultánea por streaming: enviar cada 4 palabras nuevas o al finalizar frase
    if (newWords.length >= 4 || isFinal) {
      const clauseToTranslate = newWords.join(' ');
      if (clauseToTranslate.trim().length > 0) {
        processedWordIndex = words.length;
        // La Web Speech API solo oye mi micrófono ➔ siempre dirección saliente
        await handleTranscription(clauseToTranslate.trim(), true, 'outgoing');
      }
    } else {
      // Notificar vista previa visual intermedia
      await handleTranscription(currentFullText, false, 'outgoing');
    }

    if (isFinal) {
      processedWordIndex = 0;
    }
  };

  speechRecognizer.onerror = (event) => {
    console.warn('[MeetTranslate AI Offscreen] Error en SpeechRecognition:', event.error);
    // Ignorar 'no-speech' sin detener el flujo
    if (event.error === 'no-speech' || event.error === 'aborted') {
      return;
    }
  };

  speechRecognizer.onend = () => {
    console.log('[MeetTranslate AI Offscreen] Evento onend de SpeechRecognition.');
    // Si la captura sigue activa, reiniciar incondicionalmente el reconocedor de voz del micrófono
    if (isListening) {
      try {
        speechRecognizer.start();
      } catch (e) {
        setTimeout(() => {
          if (isListening) {
            try { speechRecognizer.start(); } catch (err) { }
          }
        }, 200);
      }
    }
  };

  // Iniciar activamente el reconocedor de voz del micrófono
  try {
    isListening = true;
    speechRecognizer.start();
    console.log('[MeetTranslate AI Offscreen] speechRecognizer.start() ejecutado.');
  } catch (e) {
    console.warn('[MeetTranslate AI Offscreen] Error al arrancar speechRecognizer:', e);
  }

  // Timer de vigilancia (Watchdog) para garantizar la reinicialización permanente en segundo plano
  if (!sttWatchdogInterval) {
    sttWatchdogInterval = setInterval(() => {
      if (isListening && speechRecognizer) {
        try {
          speechRecognizer.start();
        } catch (e) { }
      }
    }, 2000);
  }
}

/**
 * Detecta si el texto transcrito está en español o inglés para el modo bilingüe automático.
 */
function detectTextLanguage(text) {
  const esPattern = /\b(que|el|la|los|las|del|por|para|con|un|una|unos|unas|es|son|esta|este|esto|como|mas|pero|no|si|y|o|en|hola|gracias|buenos|noches|dias|bien|muy|tambien|hacer|tengo|tienes|hace|todo|nada|algo|aqui|alla|donde|cuando|quien|porque|cual|estamos|tenemos)\b|[áéíóúñ¿¡]/gi;
  const enPattern = /\b(the|is|are|was|were|and|or|for|with|this|that|these|those|have|has|had|not|you|they|we|it|from|at|by|hello|thanks|good|morning|night|well|very|also|do|does|did|everything|nothing|something|here|there|where|when|who|why|which)\b/gi;

  const esCount = (text.match(esPattern) || []).length;
  const enCount = (text.match(enPattern) || []).length;

  if (esCount > enCount) return 'es';
  if (enCount > esCount) return 'en';
  if (/[áéíóúñ¿¡]/i.test(text)) return 'es';
  return 'es';
}

/**
 * Aplica corrección de diccionario/glosario técnico antes de la traducción.
 * Corrige errores fonéticos frecuentes de STT (ej: 'real' -> 'React', 'cherpoy' -> 'SharePoint').
 */
function applyTechnicalGlossary(text, customGlossary = {}) {
  if (!text) return '';

  const defaultGlossary = {
    // SharePoint & Microsoft 365
    'cherpoy': 'SharePoint',
    'sharepo': 'SharePoint',
    'sharepoin': 'SharePoint',
    'charpon': 'SharePoint',
    'es pe fx': 'SPFx',
    'ese pe ef equis': 'SPFx',
    'spfx': 'SPFx',
    'power autonat': 'Power Automate',
    'power automate': 'Power Automate',
    'power aps': 'Power Apps',
    'power ap': 'Power Apps',
    'power bi': 'Power BI',
    'power vi': 'Power BI',
    'tean': 'Teams',
    'tins': 'Teams',
    'site column': 'Site Column',
    'content type': 'Content Type',
    'webpart': 'Web Part',
    'web part': 'Web Part',
    'pe en pe': 'PnP',
    'pnpjs': 'PnPjs',
    'graf api': 'Microsoft Graph API',
    'entra id': 'Entra ID',
    'tenant': 'Tenant',

    // Frontend & Frameworks
    'real': 'React',
    'riac': 'React',
    'riact': 'React',
    'yabascrip': 'JavaScript',
    'llabascript': 'JavaScript',
    'taitscrip': 'TypeScript',
    'taipscrip': 'TypeScript',
    'fluter': 'Flutter',
    'nod': 'Node.js',
    'nodo': 'Node.js',
    'node': 'Node.js',
    'nes j s': 'Next.js',
    'nextjs': 'Next.js',
    'vats': 'Vite',
    'vait': 'Vite',
    'angular': 'Angular',
    'yeison': 'JSON',
    'jason': 'JSON',
    'res api': 'REST API',

    // Cloud & DevOps
    'doker': 'Docker',
    'doquer': 'Docker',
    'piton': 'Python',
    'paiton': 'Python',
    'a doble u ese': 'AWS',
    'a doble v ese': 'AWS',
    'asur': 'Azure',
    'gihub': 'GitHub',
    'llithub': 'GitHub',
    'kubernets': 'Kubernetes',
    'guberne': 'Kubernetes',
    'paip lain': 'Pipeline',
    'paiplain': 'Pipeline'
  };

  const combined = { ...defaultGlossary, ...(customGlossary || {}) };
  let processed = text;

  for (const [misspelled, correct] of Object.entries(combined)) {
    const regex = new RegExp(`\\b${misspelled.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    processed = processed.replace(regex, correct);
  }

  return processed;
}

/**
 * Procesa el texto transcrito y lo envía al motor de traducción seleccionado.
 * La 'direction' viaja hasta content.js, que decide si el audio traducido se
 * inyecta en la llamada (saliente) o solo suena en mis parlantes (entrante).
 */
async function handleTranscription(originalText, isFinal, direction = 'outgoing') {
  try {
    const { src, tgt } = langPairFor(direction);
    const correctedText = applyTechnicalGlossary(originalText, currentSettings.glossary);
    const translatedText = await translateText(
      correctedText,
      src,
      tgt,
      currentSettings.engine,
      currentSettings.ollamaEndpoint
    );

    // Enviar el resultado al Service Worker para su despliegue en la interfaz
    chrome.runtime.sendMessage({
      type: 'TRANSLATION_RESULT',
      originalText: correctedText,
      translatedText,
      isFinal,
      direction
    }).catch(() => { });

  } catch (err) {
    console.error('[MeetTranslate AI Offscreen] Error en pipeline de traducción:', err);
  }
}

/**
 * Módulo de Traducción Extensible:
 * Soporta 'fast' (API rápida) y 'gemma' (TranslateGemma en Ollama/vLLM local) con fallback automático.
 */
async function translateText(text, sourceLang, targetLang, engine, ollamaEndpoint) {
  if (!text || text.trim() === '') return '';

  const cleanText = text.trim();
  const cacheKey = `${sourceLang}_${targetLang}_${engine}_${cleanText}`;

  // 1. Verificación en caché local
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  let srcShort = sourceLang.substring(0, 2);
  let tgtShort = targetLang.substring(0, 2);

  // Modo Bidireccional Automático (Auto ES <-> EN)
  if (sourceLang === 'auto' || targetLang === 'auto') {
    srcShort = detectTextLanguage(cleanText);
    tgtShort = srcShort === 'es' ? 'en' : 'es';
  }

  // Si los idiomas origen y destino son idénticos, devolver el mismo texto
  if (srcShort === tgtShort) {
    return cleanText;
  }

  let resultTranslation = '';

  // 2. Ejecutar motor Gemma (Ollama local) si fue seleccionado
  if (engine === 'gemma') {
    try {
      resultTranslation = await translateWithGemma(cleanText, srcShort, tgtShort, ollamaEndpoint);
    } catch (gemmaErr) {
      console.warn('[MeetTranslate AI Offscreen] Gemma indisponible, ejecutando fallback a motor Fast API:', gemmaErr.message);
      // Fallback a motor rápido en caso de error o desconexión de Ollama
      resultTranslation = await translateWithFastAPI(cleanText, srcShort, tgtShort);
    }
  } else {
    // 3. Ejecutar motor Fast API por defecto
    resultTranslation = await translateWithFastAPI(cleanText, srcShort, tgtShort);
  }

  // Guardar en caché si el resultado es válido
  if (resultTranslation) {
    if (translationCache.size > MAX_CACHE_SIZE) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, resultTranslation);
  }

  return resultTranslation || cleanText;
}

/**
 * Motor Fast API: Servicio REST ultra-rápido de Google Translate para traducción continua.
 */
async function translateWithFastAPI(text, srcLang, tgtLang) {
  try {
    const sanitizedText = (text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!sanitizedText) return '';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcLang}&tl=${tgtLang}&dt=t&q=${encodeURIComponent(sanitizedText)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP Error status: ${response.status}`);
    }
    const data = await response.json();
    if (data && Array.isArray(data[0])) {
      const translated = data[0].map(chunk => chunk[0]).filter(Boolean).join('');
      if (translated && translated.trim().length > 0) {
        return translated.trim();
      }
    }
    return sanitizedText;
  } catch (err) {
    console.warn('[MeetTranslate AI Offscreen] Error en Google Translate API, probando fallback:', err);
    return await translateWithFallback(text, srcLang, tgtLang);
  }
}

/**
 * Fallback de traducción en caso de error de red secundario.
 */
async function translateWithFallback(text, srcLang, tgtLang) {
  try {
    const sanitizedText = (text || '').replace(/[\r\n]+/g, ' ').trim();
    if (!sanitizedText) return '';
    const url = `https://ftapi.pythonanywhere.com/translate?sl=${srcLang}&dl=${tgtLang}&text=${encodeURIComponent(sanitizedText)}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data && data['destination-text']) {
        return data['destination-text'];
      }
    }
  } catch (e) { }
  return text;
}

/**
 * Motor TranslateGemma: Integración con Ollama/vLLM en localhost:11434
 */
async function translateWithGemma(text, srcLang, tgtLang, endpoint) {
  const baseUrl = (endpoint || 'http://localhost:11434').replace(/\/$/, '');
  const apiUrl = `${baseUrl}/api/generate`;

  const srcFull = srcLang === 'es' ? 'Spanish' : 'English';
  const tgtFull = tgtLang === 'en' ? 'English' : 'Spanish';

  const prompt = `You are a professional real-time speech translator. Translate the following speech excerpt directly from ${srcFull} to ${tgtFull}. Return ONLY the direct translated text. Do not add quotes, markdown formatting, explanations, or introductory text.\n\nText: "${text}"`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500); // Timeout de 3.5 segundos para baja latencia

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gemma2', // O 'translategemma' si está disponible
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          top_p: 0.9
        }
      })
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama respondió con código ${response.status}`);
    }

    const data = await response.json();
    if (data && data.response) {
      return data.response.trim().replace(/^["']|["']$/g, '');
    }

    throw new Error('Respuesta inválida del servidor Ollama.');
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

/**
 * Limpieza exhaustiva de recursos de audio y habla.
 */
async function stopAudioCaptureAndSTT() {
  console.log('[MeetTranslate AI Offscreen] Deteniendo procesamiento de audio y liberación de recursos...');

  isListening = false;

  // 1. Detener reconocedores de voz y grabadores de audio
  if (micMediaRecorder) {
    try {
      if (micMediaRecorder.state !== 'inactive') micMediaRecorder.stop();
    } catch (e) { }
    micMediaRecorder = null;
  }

  if (micStream) {
    try {
      micStream.getTracks().forEach(t => t.stop());
    } catch (e) { }
    micStream = null;
  }

  if (mediaRecorderSTT) {
    try {
      if (mediaRecorderSTT.state !== 'inactive') {
        mediaRecorderSTT.stop();
      }
    } catch (e) { }
    mediaRecorderSTT = null;
  }

  if (speechRecognizer) {
    try {
      speechRecognizer.onend = null;
      speechRecognizer.onerror = null;
      speechRecognizer.stop();
    } catch (e) {
      console.warn('[MeetTranslate AI Offscreen] Excepción al detener speechRecognizer:', e);
    }
    speechRecognizer = null;
  }

  // 2. Cerrar AudioContext
  if (audioContext) {
    try {
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    } catch (e) {
      console.warn('[MeetTranslate AI Offscreen] Excepción cerrando audioContext:', e);
    }
    audioContext = null;
  }

  // 3. Detener todos los tracks de MediaStream
  if (currentStream) {
    try {
      currentStream.getTracks().forEach(track => {
        track.stop();
        console.log(`[MeetTranslate AI Offscreen] Track de audio ${track.label} detenido.`);
      });
    } catch (e) {
      console.warn('[MeetTranslate AI Offscreen] Excepción al detener tracks:', e);
    }
    currentStream = null;
  }

  console.log('[MeetTranslate AI Offscreen] Recursos liberados y limpieza completada.');
}
