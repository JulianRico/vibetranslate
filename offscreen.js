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
              } catch (e) {}
              
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
      }).catch(() => {});
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

    // 2. Capturar también el micrófono local del usuario (para lo que ingresa por su micrófono)
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      startMicAudioRecorder(micStream);
      console.log('[MeetTranslate AI Offscreen] Micrófono local del usuario capturado.');
    } catch (micErr) {
      console.warn('[MeetTranslate AI Offscreen] Micrófono local no accesible (usando solo audio de pestaña):', micErr);
    }

    // 3. Iniciar el motor de Speech-to-Text para Audio de Pestaña y Micrófono
    startTabAudioRecorder();
    initSpeechRecognition();

  } catch (error) {
    console.error('[MeetTranslate AI Offscreen] Error obteniendo streams de audio:', error);
    throw error;
  }
}

/**
 * Graba fragmentos del micrófono local del usuario.
 */
let micStream = null;
let micMediaRecorder = null;
let isProcessingMicChunk = false;

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
          await processAudioChunk(event.data);
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
 * Graba fragmentos de audio continuo del stream de la pestaña capturada.
 * Resuelve la limitación de Web Speech API de Chrome que solo escucha el micrófono local.
 */
let mediaRecorderSTT = null;
let isProcessingTabChunk = false;

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
          await processAudioChunk(event.data);
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
 * Transcribe los fragmentos de audio de la pestaña usando Whisper (Groq / OpenAI / Local).
 */
async function processAudioChunk(blob) {
  const sttEngine = currentSettings.sttEngine || 'whisper_groq';
  let transcribedText = '';

  if (sttEngine === 'whisper_groq') {
    transcribedText = await transcribeWithGroq(blob, currentSettings.groqApiKey, currentSettings.sourceLang);
  } else if (sttEngine === 'whisper_openai') {
    transcribedText = await transcribeWithOpenAI(blob, currentSettings.openaiApiKey, currentSettings.sourceLang);
  } else if (sttEngine === 'whisper_local') {
    transcribedText = await transcribeWithLocalWhisper(blob, currentSettings.whisperEndpoint, currentSettings.sourceLang);
  } else {
    // Si hay una API Key de Groq o servidor local configurado por defecto
    if (currentSettings.groqApiKey) {
      transcribedText = await transcribeWithGroq(blob, currentSettings.groqApiKey, currentSettings.sourceLang);
    } else if (currentSettings.whisperEndpoint) {
      transcribedText = await transcribeWithLocalWhisper(blob, currentSettings.whisperEndpoint, currentSettings.sourceLang);
    }
  }

  if (transcribedText && transcribedText.trim().length > 0) {
    console.log('[MeetTranslate AI Offscreen] Voz remota de pestaña transcrita:', transcribedText);
    await handleTranscription(transcribedText.trim(), true);
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
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_ERROR', error: errorMsg }).catch(() => {});
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

  speechRecognizer.onstart = () => {
    isListening = true;
    console.log('[MeetTranslate AI Offscreen] Reconocedor de voz iniciado. Idioma:', speechRecognizer.lang);
  };

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

    // Procesar transcripción final o intermedia significativa
    const textToProcess = (finalTranscript || interimTranscript).trim();
    if (textToProcess.length > 0) {
      const isFinal = finalTranscript.length > 0;
      await handleTranscription(textToProcess, isFinal);
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
            try { speechRecognizer.start(); } catch (err) {}
          }
        }, 200);
      }
    }
  };

  try {
    speechRecognizer.start();
  } catch (err) {
    console.error('[MeetTranslate AI Offscreen] Error al arrancar SpeechRecognition:', err);
  }

  // Timer de vigilancia (Watchdog) para garantizar la reinicialización permanente en segundo plano
  if (!sttWatchdogInterval) {
    sttWatchdogInterval = setInterval(() => {
      if (isListening && speechRecognizer) {
        try {
          speechRecognizer.start();
        } catch (e) {}
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
 * Procesa el texto transcrito y lo envía al motor de traducción seleccionado.
 */
async function handleTranscription(originalText, isFinal) {
  try {
    const translatedText = await translateText(
      originalText,
      currentSettings.sourceLang,
      currentSettings.targetLang,
      currentSettings.engine,
      currentSettings.ollamaEndpoint
    );

    // Enviar el resultado al Service Worker para su despliegue en la interfaz
    chrome.runtime.sendMessage({
      type: 'TRANSLATION_RESULT',
      originalText,
      translatedText,
      isFinal
    }).catch(() => {});

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
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcLang}&tl=${tgtLang}&dt=t&q=${encodeURIComponent(text)}`;
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
    return text;
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
    const url = `https://ftapi.pythonanywhere.com/translate?sl=${srcLang}&dl=${tgtLang}&text=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data && data['destination-text']) {
        return data['destination-text'];
      }
    }
  } catch (e) {}
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
    } catch (e) {}
    micMediaRecorder = null;
  }

  if (micStream) {
    try {
      micStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    micStream = null;
  }

  if (mediaRecorderSTT) {
    try {
      if (mediaRecorderSTT.state !== 'inactive') {
        mediaRecorderSTT.stop();
      }
    } catch (e) {}
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
