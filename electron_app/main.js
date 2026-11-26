/**
 * main.js - Proceso Principal de Electron para MeetTranslate Desktop
 * =================================================================
 * Soportado para: Microsoft Teams Desktop, Zoom App y Google Meet
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, desktopCapturer, session, dialog, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { userGlossary } = require('./glossary');
const { loadEnv, applyEnvFallbacks } = require('./env');
const { createTechGlossary } = require('./local-ai/tech-glossary');
const { createCloudTranslator } = require('./cloud-translator');
const { createInterviewer, personaPlexPrompt, haruCardPrompt } = require('./training-interviewer');
const { PersonaPlexClient, PERSONAPLEX_VOICES } = require('./personaplex-client');
const { pickVoiceForSetup } = require('./personaplex-protocol');
const { HARU_DEFAULT_PORT, HARU_LANGUAGES } = require('./haru-protocol');
const { isWhisperHallucination } = require('./audio-utils');
const { defaultLogger } = require('./logger');
const { FishAudioService } = require('./fish-audio-service');
const { createModelStore } = require('./local-ai/model-store');
const { createLocalAiClient } = require('./local-ai/client');
const { createPrepare } = require('./local-ai/prepare');
const { createTraceRecorder } = require('./local-ai/trace-recorder');
const { createAudioDucker } = require('./audio-ducker');

// Cargar variables de entorno desde .env (en desarrollo desde el proyecto; instalada, si existe junto al ejecutable)
const envFilePath = app.isPackaged
  ? path.join(path.dirname(process.execPath), '.env')
  : path.join(__dirname, '.env');
loadEnv({ filePath: envFilePath });

// Inicializar logs en disco
defaultLogger.clear();
defaultLogger.info('SYSTEM', '🚀 Iniciando MeetTranslate Desktop App (Proceso Principal)...');

// Instancia de servicio Fish Audio
const fishAudioService = new FishAudioService({
  apiKey: process.env.FISH_API_KEY || '',
  model: process.env.FISH_MODEL || 's2.1-pro-free'
});

// Configuración de Chromium para optimizar rendimiento y evitar bloqueos de caché en Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// Garantizar una única instancia activa para evitar colisiones de archivos
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  defaultLogger.warn('SYSTEM', '⚠️ Otra instancia de la aplicación ya está en ejecución. Abortando inicio...');
  app.quit();
  process.exit(0);
}

// ── Rutas de Configuración Persistente ──────────────────────────────
const userDataPath = app.getPath('userData');
const settingsFilePath = path.join(userDataPath, 'settings.json');

// ── Motor Local (transcripción y traducción en el equipo, sin red) ──
const modelStore = createModelStore({
  // La variable de entorno solo vale en desarrollo y pruebas: la app instalada usa siempre su carpeta de datos
  dir: (!app.isPackaged && process.env.VIBE_MODELS_DIR) || path.join(userDataPath, 'models')
});

const localAi = createLocalAiClient({
  fork: (workerPath) => utilityProcess.fork(workerPath, [], { serviceName: 'ViBeTranslate Motor Local' }),
  workerPath: path.join(__dirname, 'local-ai', 'worker.js'),
  onEvent: (msg) => {
    if (msg.type === 'error') defaultLogger.warn('LOCAL-AI', msg.message);
    // Sesión de prueba: se guarda el audio de la frase y la traza; el audio no se reenvía a la interfaz
    const { type, samples, ...data } = msg;
    if (type === 'segment' && samples) traceRecorder.saveAudio({ id: msg.id, stream: msg.stream, samples });
    if (['segment', 'segment-text', 'partial', 'echo', 'noise', 'vad', 'error'].includes(type)) traceRecorder.record(type, data);
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('LOCAL_AI_EVENT', { type, ...data });
    }
  }
});

// ── Laboratorio de pruebas: sesiones grabadas con audio, textos y tiempos ──
// En desarrollo las sesiones quedan junto al código; VIBE_SESSIONS_DIR las desvía (pruebas automáticas, para no mezclarlas con las del usuario)
const traceSessionsDir = app.isPackaged
  ? path.join(userDataPath, 'test-sessions')
  : path.resolve(process.env.VIBE_SESSIONS_DIR || path.join(__dirname, 'test-sessions'));
const traceRecorder = createTraceRecorder({ baseDir: traceSessionsDir });

const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  groqApiKey: '',
  fishApiKey: '',
  fishVoiceModelId: 'default',
  fishModel: 's2.1-pro-free',
  huggingfaceApiKey: '',
  fishLatency: 'balanced',
  fishVolume: 95,
  fishSpeed: 1.0,
  ttsEngine: 'fish_audio',
  sttEngine: 'whisper_groq',
  geminiVoice: 'Puck',
  spanishVoice: 'auto',
  spanishVolume: 90,
  noiseThreshold: 15,
  sourceLang: 'es-ES',
  targetLang: 'en',
  virtualCableId: 'default',
  micInputId: 'default',
  speakerOutputId: 'default',
  glossary: {}, // solo lo que añade el usuario: los términos técnicos están en local-ai/tech-terms.js
  subtitleFontSize: 16,
  subtitleOpacity: 92,
  subtitleBgColor: '#000000',
  showOverlay: true,
  translateIncoming: true,
  incomingVoice: false,
  duckLevel: 0.05,
  autoStartListening: false,
  personaplexHost: '127.0.0.1',
  personaplexPort: 8998,
  personaplexVoice: 'auto',
  haruHost: '127.0.0.1',
  haruPort: HARU_DEFAULT_PORT,
  haruLang: 'en',
  haruVoiceRef: '',
  trainingEngine: 'cloud'
};

function broadcastOverlayState(isVisible) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('OVERLAY_STATE_CHANGED', { isVisible });
  }
}

function loadSavedSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, 'utf8');
      const loaded = applyEnvFallbacks({ ...DEFAULT_SETTINGS, ...JSON.parse(data) });
      // Las versiones anteriores guardaban una copia del glosario de fábrica (con 'real' → 'React'): se quita
      loaded.glossary = userGlossary(loaded.glossary);
      defaultLogger.info('CONFIG', 'Configuración cargada correctamente desde disco.');
      return loaded;
    }
  } catch (err) {
    defaultLogger.warn('CONFIG', 'Error leyendo settings.json, usando valores por defecto:', err.message);
  }
  return applyEnvFallbacks(DEFAULT_SETTINGS);
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
    defaultLogger.info('CONFIG', 'Configuración guardada en disco exitosamente.');
  } catch (err) {
    defaultLogger.error('CONFIG', 'Error guardando settings.json:', err.message);
  }
}

const WINDOW_SIZE = { width: 440, height: 820, minWidth: 380, minHeight: 600 };

function createControlWindow() {
  defaultLogger.info('UI', 'Creando Ventana del Panel de Control Principal...');
  // Ventana estrecha y alta: cabe al lado de la reunión
  controlWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    minWidth: WINDOW_SIZE.minWidth,
    minHeight: WINDOW_SIZE.minHeight,
    resizable: true,
    title: 'ViBeTranslate',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  controlWindow.loadFile(path.join(__dirname, 'index.html'));

  controlWindow.on('closed', () => {
    defaultLogger.info('UI', 'Panel de Control cerrado.');
    controlWindow = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  });
}

function createOverlayWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  defaultLogger.info('UI', `Creando Ventana de Subtítulos Flotante (${screenWidth}x${screenHeight})...`);

  overlayWindow = new BrowserWindow({
    width: 760,
    height: 220,
    x: Math.round((screenWidth - 760) / 2),
    y: screenHeight - 260,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.setAlwaysOnTop(true, 'floating');

  const settings = loadSavedSettings();
  if (settings.showOverlay === false) {
    overlayWindow.hide();
  }

  overlayWindow.on('closed', () => {
    defaultLogger.info('UI', 'Ventana de Subtítulos cerrada.');
    overlayWindow = null;
    broadcastOverlayState(false);
  });
}

// ── Ciclo de Vida de la Aplicación ───────────────────────────────────

app.whenReady().then(() => {
  defaultLogger.success('SYSTEM', '✅ Electron app.whenReady disparado.');

  // Configurar permisos automáticos para micrófono y captura de loopback
  if (session.defaultSession) {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return true;
    });
    if (session.defaultSession.setDisplayMediaRequestHandler) {
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
          callback({ video: sources[0], audio: 'loopback' });
        });
      });
    }
  }

  createControlWindow();
  createOverlayWindow();

  app.on('second-instance', () => {
    defaultLogger.info('SYSTEM', 'Se detectó intento de segunda instancia. Enfocando ventana principal...');
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });

  // Registrar Atajos de Teclado Globales
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    defaultLogger.info('SHORTCUT', 'Atajo global Ctrl+Shift+T activado. Alternando visibilidad del overlay.');
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const willShow = !overlayWindow.isVisible();
      if (willShow) overlayWindow.show();
      else overlayWindow.hide();
      broadcastOverlayState(willShow);
    }
  });

  // ── Hot Reload / Watcher Automático de Vistas ──────────────────────
  let reloadTimeout = null;
  fs.watch(__dirname, { recursive: false }, (eventType, filename) => {
    if (!filename || filename.includes('node_modules') || filename.includes('logs') || filename.includes('.git')) return;
    
    clearTimeout(reloadTimeout);
    reloadTimeout = setTimeout(() => {
      if (filename.endsWith('.html') || filename.endsWith('.css') || filename === 'index.js' || filename === 'overlay.js') {
        defaultLogger.info('HOT-RELOAD', `Cambio detectado en ${filename}. Recargando vistas en vivo...`);
        if (controlWindow && !controlWindow.isDestroyed()) {
          controlWindow.webContents.reload();
        }
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.webContents.reload();
        }
      }
    }, 200);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
      createOverlayWindow();
    }
  });
});

app.on('will-quit', () => {
  traceRecorder.stop(); // una sesión de prueba abierta se cierra con su informe
  audioDucker.dispose(); // devuelve su volumen a los demás programas
  localAi.stop();
  defaultLogger.info('SYSTEM', 'Cerrando aplicación y liberando atajos de teclado...');
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ── Manejo de IPC entre Renderers y Proceso Principal ────────────────

ipcMain.handle('GET_SETTINGS', async () => {
  return loadSavedSettings();
});

ipcMain.handle('SAVE_SETTINGS', async (event, newSettings) => {
  const current = loadSavedSettings();
  const merged = { ...current, ...newSettings };
  saveSettings(merged);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('SETTINGS_CHANGED', merged);
  }
  return merged;
});

/**
 * Traducción de texto en la nube, con respaldos:
 * 1. Origen conocido: LLM de Groq y Google a la vez; gana el LLM si responde bien y a tiempo (cloud-translator.js)
 * 2. Origen automático: Google, que además detecta el idioma
 * 3. MyMemory si no responde ninguno
 */
const cloudTranslator = createCloudTranslator({
  getGroqKey: () => (loadSavedSettings().groqApiKey || ''),
  logger: (message) => defaultLogger.warn('TRANSLATE', message)
});

// Practicar entrevistas y reuniones internacionales: genera libreto, conduce en inglés y evalúa (Groq + respaldo Gemini)
const interviewer = createInterviewer({
  getGroqKey: () => (loadSavedSettings().groqApiKey || ''),
  getGeminiKey: () => (loadSavedSettings().geminiApiKey || '')
});

ipcMain.handle('TRAINING_GENERATE_PLAYBOOK', async (event, { setup, refineNote = '' }) => {
  const r = await interviewer.generatePlaybook({ setup, refineNote });
  if (!r.ok) defaultLogger.warn('PRÁCTICA', r.error);
  else defaultLogger.success('PRÁCTICA', `Libreto generado (${r.model}) con ${r.playbook.turns.length} turnos.`);
  return r;
});

ipcMain.handle('TRAINING_NEXT', async (event, { setup, history }) => {
  const r = await interviewer.next({ setup, history });
  if (!r.ok) defaultLogger.warn('PRÁCTICA', r.error);
  return r;
});

ipcMain.handle('TRAINING_EVALUATE', async (event, { setup, history }) => {
  const r = await interviewer.evaluate({ setup, history });
  if (!r.ok) defaultLogger.warn('PRÁCTICA', r.error);
  return r;
});

ipcMain.handle('PERSONAPLEX_STATUS', async (event, { host, port, secure = false } = {}) => {
  const saved = loadSavedSettings();
  const client = new PersonaPlexClient({
    host: host || saved.personaplexHost || '127.0.0.1',
    port: Number(port || saved.personaplexPort) || 8998,
    secure: Boolean(secure)
  });
  const health = await client.checkHealth();
  return {
    ...health,
    host: client.host,
    port: client.port,
    voices: health.voices || PERSONAPLEX_VOICES
  };
});

ipcMain.handle('PERSONAPLEX_BUILD_SESSION', async (event, { setup = {} } = {}) => {
  const saved = loadSavedSettings();
  const host = setup.personaplexHost || saved.personaplexHost || '127.0.0.1';
  const port = Number(setup.personaplexPort || saved.personaplexPort) || 8998;
  const voicePrompt = pickVoiceForSetup({
    ...setup,
    personaplexVoice: setup.personaplexVoice || saved.personaplexVoice || 'auto'
  });
  const textPrompt = personaPlexPrompt(setup);
  return {
    ok: true,
    host,
    port,
    voicePrompt,
    textPrompt
  };
});

// ── IPC para Haru-4B Multilingüe Full-Duplex (puerto 8999) ─────────────────
// ¿Por qué reutilizamos PersonaPlexClient aquí?:
// Tanto PersonaPlex como Haru-4B adoptan el protocolo binario de 1 byte de Moshi
// en `/api/chat` (`0x00` handshake, `0x01` audio 24 kHz, `0x02` texto UTF-8, `0x06` ping),
// diferenciándose únicamente en el puerto por defecto (8999 vs 8998) y en que Haru
// recibe una Character Card multilingüe (`haruCardPrompt`) en vez de `<system> ... <system>`.
ipcMain.handle('HARU_STATUS', async (event, { host, port, secure = false } = {}) => {
  const saved = loadSavedSettings();
  const client = new PersonaPlexClient({
    host: host || saved.haruHost || '127.0.0.1',
    port: Number(port || saved.haruPort) || HARU_DEFAULT_PORT,
    secure: Boolean(secure)
  });
  const health = await client.checkHealth();
  return {
    ...health,
    host: client.host,
    port: client.port,
    languages: HARU_LANGUAGES
  };
});

ipcMain.handle('HARU_BUILD_SESSION', async (event, { setup = {} } = {}) => {
  const saved = loadSavedSettings();
  const host = setup.haruHost || saved.haruHost || '127.0.0.1';
  const port = Number(setup.haruPort || saved.haruPort) || HARU_DEFAULT_PORT;
  const lang = setup.haruLang || saved.haruLang || 'en';
  const voicePrompt = setup.haruVoiceRef || saved.haruVoiceRef || 'auto';
  const textPrompt = haruCardPrompt(setup, {
    lang,
    backchannel: setup.haruBackchannel || 'mid'
  });
  return {
    ok: true,
    engine: 'haru',
    host,
    port,
    lang,
    voicePrompt,
    textPrompt,
    rawPrompt: true
  };
});

async function translateWithGoogleDict(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
    const data = await res.json();
    const detected = (data && data[2]) ? data[2] : sl;
    if (data && Array.isArray(data[0])) {
      const translated = data[0].map(chunk => chunk[0]).filter(Boolean).join('');
      if (translated && translated.trim()) {
        return { translated: translated.trim(), detected };
      }
    }
    throw new Error('Respuesta vacía de Google Translate');
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithMyMemory(text, sl, tl) {
  const source = sl === 'auto' ? 'es' : sl;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${tl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.responseData && data.responseData.translatedText) {
      const trans = data.responseData.translatedText.trim();
      if (trans && !trans.includes('MYMEMORY WARNING')) {
        return { translated: trans, detected: sl };
      }
    }
    throw new Error('Respuesta inválida de MyMemory');
  } finally {
    clearTimeout(timer);
  }
}

/** Términos técnicos para el texto que llega de los motores en la nube: solo formas exactas, más las pistas. */
let cloudGlossary = { key: null, glossary: null };
function termGlossary(user) {
  const key = JSON.stringify(user || {});
  if (cloudGlossary.key !== key) cloudGlossary = { key, glossary: createTechGlossary({ user, fuzzy: false }) };
  return cloudGlossary.glossary;
}

ipcMain.handle('TRANSLATE_TEXT', async (event, { text, sourceLang, targetLang, googleOnly = false, hints = null }) => {
  if (!text || !text.trim()) return { original: '', translated: '', detectedLang: 'es', targetLang: 'en' };

  const cleanText = text.trim();
  const settings = loadSavedSettings();

  let srcShort = (sourceLang || 'auto').substring(0, 2).toLowerCase();
  // El motor local ya corrigió su texto; el de los motores en la nube pasa por las formas exactas del diccionario
  const terms = termGlossary(settings.glossary).correct(cleanText, srcShort === 'en' ? 'en' : 'es');
  const correctedText = terms.text;
  const termHints = Array.isArray(hints) ? hints : terms.hints;
  let tgtShort = (targetLang || 'auto').substring(0, 2).toLowerCase();

  const isAutoSource = (srcShort === 'au' || !srcShort);
  const isAutoTarget = (tgtShort === 'au' || !tgtShort);

  const sanitizedText = correctedText.replace(/[\r\n]+/g, ' ').trim();
  let slParam = isAutoSource ? 'auto' : (srcShort || 'es');
  let tlParam = isAutoTarget ? (slParam === 'es' ? 'en' : 'es') : (tgtShort || 'en');
  if (isAutoTarget && slParam === tlParam) {
    tlParam = (slParam === 'es') ? 'en' : 'es';
  }

  const startTime = Date.now();

  if (!isAutoSource && !googleOnly) {
    try {
      const res = await cloudTranslator.translate(sanitizedText, slParam, tlParam, { hints: termHints });
      const label = res.engine === 'groq' ? `Groq ${res.model}` : 'Google';
      defaultLogger.success('TRANSLATE', `Traducción completada (${label}) (${slParam} ➔ ${tlParam}) en ${res.elapsedMs}ms: "${res.translated}"`);
      return { original: correctedText, translated: res.translated, detectedLang: slParam, targetLang: tlParam, elapsedMs: res.elapsedMs, engine: res.engine };
    } catch (err) {
      defaultLogger.warn('TRANSLATE', `Aviso en la nube (${err.message}). Probando fallback MyMemory...`);
    }
  } else {
    // Google (dict-chrome-ex): además detecta el idioma de origen
    try {
      const resGoogle = await translateWithGoogleDict(sanitizedText, slParam, tlParam);
      const elapsed = Date.now() - startTime;
      const detected = resGoogle.detected || slParam;

      if (isAutoSource && isAutoTarget && detected === tlParam) {
        const altTl = (detected === 'en') ? 'es' : 'en';
        const resAlt = await translateWithGoogleDict(sanitizedText, detected, altTl);
        const totalElapsed = Date.now() - startTime;
        defaultLogger.success('TRANSLATE', `Auto-traducción bidireccional (Google) (${detected} ➔ ${altTl}) en ${totalElapsed}ms: "${resAlt.translated}"`);
        return { original: correctedText, translated: resAlt.translated, detectedLang: detected, targetLang: altTl, elapsedMs: totalElapsed, engine: 'google' };
      }

      defaultLogger.success('TRANSLATE', `Traducción completada (Google) (${slParam} ➔ ${tlParam}) en ${elapsed}ms: "${resGoogle.translated}"`);
      return { original: correctedText, translated: resGoogle.translated, detectedLang: detected, targetLang: tlParam, elapsedMs: elapsed, engine: 'google' };
    } catch (errGoogle) {
      if (googleOnly) {
        // El motor local traducirá esta frase: no se esperan los demás niveles de la nube
        defaultLogger.warn('TRANSLATE', `Aviso en Google Translate (${errGoogle.message}). Se usará el motor local.`);
        return { original: correctedText, translated: '', detectedLang: slParam, targetLang: tlParam, elapsedMs: Date.now() - startTime, engine: 'none', error: 'No respondió ningún traductor' };
      }
      defaultLogger.warn('TRANSLATE', `Aviso en Google Translate (${errGoogle.message}). Probando fallback MyMemory...`);
    }
  }

  // Último recurso: MyMemory API
  try {
    const resMyMem = await translateWithMyMemory(sanitizedText, slParam, tlParam);
    const elapsed = Date.now() - startTime;
    defaultLogger.success('TRANSLATE', `Traducción completada (MyMemory) (${slParam} ➔ ${tlParam}) en ${elapsed}ms: "${resMyMem.translated}"`);
    return { original: correctedText, translated: resMyMem.translated, detectedLang: slParam, targetLang: tlParam, elapsedMs: elapsed, engine: 'mymemory' };
  } catch (errMyMem) {
    defaultLogger.error('TRANSLATE', `Fallo en todos los motores de traducción (${errMyMem.message}).`);
  }

  // Sin traducción: nunca se devuelve el texto original como si lo fuera
  return { original: correctedText, translated: '', detectedLang: slParam, targetLang: tlParam, elapsedMs: Date.now() - startTime, engine: 'none', error: 'No respondió ningún traductor' };
});

ipcMain.handle('TRANSCRIBE_GROQ', async (event, { audioBase64, apiKey, language, format = 'wav', prompt }) => {
  if (!apiKey || !apiKey.trim()) {
    defaultLogger.warn('GROQ', 'Groq API Key no configurada en la aplicación.');
    return { text: '' };
  }

  const cleanKey = apiKey.trim();

  // Función interna con timeout y reintento
  const doFetchTranscription = async (attempt = 1) => {
    const buffer = Buffer.from(audioBase64, 'base64');
    if (!buffer || buffer.length < 1000) {
      return { text: '' };
    }

    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/webm';
    const fileName = format === 'wav' ? 'audio.wav' : 'audio.webm';
    const blob = new Blob([buffer], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    
    const defaultPrompt = (language === 'en')
      ? 'Live conversational English in a business meeting. Transcribe complete, coherent sentences with proper punctuation.'
      : 'Conversación fluida en vivo en español. Transcribir oraciones completas y coherentes con puntuación adecuada.';
    formData.append('prompt', prompt || defaultPrompt);

    if (language && language !== 'auto') {
      formData.append('language', language);
    }

    const startTime = Date.now();
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(10000)
    });

    const elapsed = Date.now() - startTime;
    if (!response.ok) {
      const errText = await response.text();
      defaultLogger.error('GROQ', `Error HTTP ${response.status} en Groq Whisper (${elapsed}ms): ${errText}`);
      return { text: '' };
    }

    const data = await response.json();
    const rawText = data.text || '';

    if (isWhisperHallucination(rawText)) {
      defaultLogger.info('GROQ', `🔇 Alucinación de silencio/ruido filtrada ("${rawText.trim()}") en ${elapsed}ms`);
      return { text: '' };
    }

    defaultLogger.success('GROQ', `Transcripción Groq Whisper completada en ${elapsed}ms: "${rawText}"`);
    return { text: rawText, elapsedMs: elapsed, model: 'whisper-large-v3-turbo' };
  };

  try {
    return await doFetchTranscription(1);
  } catch (err) {
    const causeDetail = err.cause ? (err.cause.code || err.cause.message || JSON.stringify(err.cause)) : '';
    defaultLogger.warn('GROQ', `Aviso en intento 1 a Groq Whisper: ${err.message} ${causeDetail ? `(${causeDetail})` : ''}. Reintentando...`);

    // Reintento único tras 350ms
    try {
      await new Promise(r => setTimeout(r, 350));
      return await doFetchTranscription(2);
    } catch (retryErr) {
      const retryCause = retryErr.cause ? (retryErr.cause.code || retryErr.cause.message || JSON.stringify(retryErr.cause)) : '';
      defaultLogger.error('GROQ', `Excepción en llamada a Groq Whisper: ${retryErr.message} ${retryCause ? `(${retryCause})` : ''}`);
      return { text: '', elapsedMs: 0 };
    }
  }
});

ipcMain.handle('TRANSCRIBE_GEMINI_35', async (event, { audioBase64, apiKey, language, format = 'wav', customVocabulary }) => {
  if (!apiKey || !apiKey.trim()) {
    defaultLogger.warn('GEMINI', 'Gemini API Key no configurada.');
    return { text: '', elapsedMs: 0 };
  }

  const cleanKey = apiKey.trim();
  const buffer = Buffer.from(audioBase64, 'base64');
  if (!buffer || buffer.length < 1000) {
    return { text: '', elapsedMs: 0 };
  }

  const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mp3';
  const startTime = Date.now();
  const vocab = Array.isArray(customVocabulary) && customVocabulary.length > 0
    ? `Custom technical vocabulary to recognize accurately: ${customVocabulary.join(', ')}.`
    : '';

  const systemInstruction = `You are an intelligent, precise speech-to-text transcriber (Gemini 3.5 Transcribe).
Transcribe the audio accurately. Clean up filler words (um, uh, eh, este) and resolve self-corrections into smooth text.
${vocab}
Output ONLY the final transcribed text without quotes, notes, markdown or explanations.`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemInstruction },
          {
            inlineData: {
              mimeType: mimeType,
              data: audioBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 200
    }
  };

  const modelsToTry = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3-flash-preview',
    'gemini-3.5-transcribe'
  ];

  for (const model of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(9000)
      });

      if (!response.ok) {
        const errTxt = await response.text();
        defaultLogger.warn('GEMINI', `Aviso ${model} HTTP ${response.status}: ${errTxt.substring(0, 100)}`);
        // Clave inválida o sin saldo en la cuenta: los demás modelos compartirían el mismo fallo
        if (response.status === 401 || response.status === 402 || response.status === 403) break;
        continue;
      }

      const data = await response.json();
      let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('«') && text.endsWith('»'))) {
        text = text.slice(1, -1).trim();
      }

      if (text && text.length > 0 && text !== '[SILENCE]') {
        const elapsed = Date.now() - startTime;
        defaultLogger.success('GEMINI', `Transcripción Gemini (${model}) completada en ${elapsed}ms: "${text}"`);
        return { text, elapsedMs: elapsed, model };
      }
    } catch (err) {
      defaultLogger.warn('GEMINI', `Aviso en intento con ${model}: ${err.message}`);
    }
  }

  const elapsed = Date.now() - startTime;
  defaultLogger.error('GEMINI', `No se pudo obtener transcripción con Gemini 3.5 tras ${elapsed}ms.`);
  return { text: '', elapsedMs: elapsed };
});

// ── Handlers IPC para el Motor Local ────────────────────────────────
ipcMain.handle('LOCAL_AI_STATUS', async () => modelStore.status());

const localPrepare = createPrepare({
  store: modelStore,
  client: localAi,
  onProgress: (progress) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('LOCAL_AI_EVENT', { type: 'progress', ...progress });
    }
  }
});

ipcMain.handle('LOCAL_AI_PREPARE', async (event, { vadThreshold = 0.5 } = {}) => {
  const pending = modelStore.status();
  if (!pending.ready) {
    defaultLogger.info('LOCAL-AI', `Descargando modelos (${(pending.missingBytes / 1e6).toFixed(0)} MB)...`);
  }
  const result = await localPrepare.prepare({ vadThreshold, captureAudio: traceRecorder.savesAudio(), glossary: loadSavedSettings().glossary });
  if (result.ok) defaultLogger.success('LOCAL-AI', `Motor local listo en ${result.loadMs}ms.`);
  else if (!result.cancelled) defaultLogger.error('LOCAL-AI', `No se pudo preparar el motor local: ${result.error}`);
  return result;
});

ipcMain.on('LOCAL_AI_AUDIO', (event, { stream, lang, samples, target, at, partial }) => {
  localAi.send({ type: 'audio', stream, lang, samples, target, at, partial });
});

ipcMain.handle('LOCAL_AI_TRANSLATE', async (event, { text, source, target, segmentId }) => {
  try {
    const result = await localAi.translate({ text, source, target, segmentId });
    defaultLogger.success('TRANSLATE', `Traducción completada (Motor local) en ${result.ms}ms: "${result.text}"`);
    return { ok: true, translated: result.text, elapsedMs: result.ms };
  } catch (err) {
    defaultLogger.warn('TRANSLATE', `Aviso en traducción local: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.on('LOCAL_AI_FLUSH', (event, { stream } = {}) => {
  localAi.send({ type: 'flush', stream });
});

ipcMain.on('LOCAL_AI_CONFIG', (event, { stream, vadThreshold }) => {
  localAi.configure({ stream, vadThreshold });
});

ipcMain.on('LOCAL_AI_STOP', () => {
  localPrepare.cancel();
});

// ── Atenuación del audio original mientras se lee la traducción ─────
const audioDucker = createAudioDucker({
  spawn: require('child_process').spawn,
  // PowerShell no puede ejecutar un guion desde dentro del asar
  scriptPath: path.join(__dirname, 'audio-ducker.ps1').replace('app.asar', 'app.asar.unpacked'),
  keepProcessName: path.basename(process.execPath, '.exe')
});

// Un cierre a la fuerza anterior pudo dejar a los demás programas atenuados: se restauran al arrancar
audioDucker.recover(fs.existsSync(path.join(require('os').tmpdir(), 'vibetranslate-ducker-state.txt')))
  .then((recovered) => { if (recovered) defaultLogger.info('AUDIO', 'Se restauró el volumen de los programas que quedaron atenuados.'); });

ipcMain.handle('AUDIO_DUCK', async (event, { level } = {}) => {
  const result = await audioDucker.duck(Number(level));
  defaultLogger.info('AUDIO', result.active
    ? `Los demás programas suenan al ${Math.round(result.level * 100)} % mientras se lee la traducción.`
    : 'No se pudo atenuar el audio de los demás programas.');
  return result;
});

ipcMain.handle('AUDIO_UNDUCK', async () => {
  await audioDucker.restore();
  return true;
});

// ── Handlers IPC para el Laboratorio de pruebas ─────────────────────
ipcMain.handle('TRACE_START', async (event, { meta = {}, saveAudio = true } = {}) => {
  const os = require('os');
  const started = traceRecorder.start({
    saveAudio,
    meta: {
      ...meta,
      procesador: os.cpus()[0] ? os.cpus()[0].model : 'desconocido',
      nucleos: os.cpus().length,
      memoriaGB: (os.totalmem() / (1024 ** 3)).toFixed(1),
      version: app.getVersion()
    }
  });
  localAi.send({ type: 'capture', enabled: saveAudio });
  defaultLogger.info('LAB', `Sesión de prueba iniciada: ${started.dir}`);
  return started;
});

ipcMain.handle('TRACE_STOP', async () => {
  localAi.send({ type: 'capture', enabled: false });
  const result = traceRecorder.stop();
  if (result) defaultLogger.info('LAB', `Sesión de prueba terminada: ${result.dir}`);
  return result;
});

ipcMain.on('TRACE_EVENT', (event, { type, data } = {}) => {
  if (typeof type === 'string') traceRecorder.record(type, data || {});
});

ipcMain.handle('TRACE_FLAG', async (event, note) => traceRecorder.flag(String(note || '').slice(0, 500)));

ipcMain.on('TRACE_OPEN', (event, dir) => {
  // Solo se abren carpetas de sesiones, no rutas arbitrarias
  const resolved = path.resolve(String(dir || traceSessionsDir));
  if (resolved === traceSessionsDir || resolved.startsWith(traceSessionsDir + path.sep)) {
    fs.mkdirSync(traceSessionsDir, { recursive: true });
    shell.openPath(resolved);
  }
});

// ── Handlers IPC para Fish Audio AI (Clonación de Voz y TTS) ────────
ipcMain.handle('FISH_AUDIO_SYNTHESIZE', async (event, { text, voiceModelId, model, format = 'mp3', latency = 'balanced', apiKey = null }) => {
  try {
    const settings = loadSavedSettings();
    const effectiveKey = apiKey || settings.fishApiKey || '';
    fishAudioService.setApiKey(effectiveKey);

    const activeModel = model || settings.fishModel || 's2.1-pro-free';
    const activeVoice = voiceModelId || settings.fishVoiceModelId || null;

    const result = await fishAudioService.synthesizeTTS({
      text,
      voiceModelId: activeVoice,
      model: activeModel,
      format,
      latency
    });

    if (result && result.audioBuffer) {
      return {
        success: true,
        audioBase64: result.audioBuffer.toString('base64'),
        format: result.format,
        model: result.model,
        elapsedMs: result.elapsedMs
      };
    }
    return { success: false, error: 'No se obtuvo buffer de audio' };
  } catch (err) {
    defaultLogger.error('FISH-AUDIO', `Error en síntesis IPC: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('FISH_AUDIO_LIST_MODELS', async (event, { apiKey = null, selfOnly = false, pageSize = 30 } = {}) => {
  try {
    const settings = loadSavedSettings();
    const effectiveKey = apiKey || settings.fishApiKey || '';
    fishAudioService.setApiKey(effectiveKey);

    if (selfOnly) {
      return await fishAudioService.listVoiceModels({ selfOnly: true, pageSize });
    }

    // Combinar primero los modelos propios (self=true) y después las voces de estudio del catálogo público
    const [ownData, publicData] = await Promise.all([
      fishAudioService.listVoiceModels({ selfOnly: true, pageSize: 30 }),
      fishAudioService.listVoiceModels({ selfOnly: false, pageSize })
    ]);
    const ownItems = (ownData && Array.isArray(ownData.items) ? ownData.items : []).map((m) => ({ ...m, isSelf: true }));
    const seen = new Set(ownItems.map((m) => m._id || m.id).filter(Boolean));
    const pubItems = (publicData && Array.isArray(publicData.items) ? publicData.items : []).filter((m) => !seen.has(m._id || m.id));
    return {
      total: ownItems.length + (publicData?.total || pubItems.length),
      items: [...ownItems, ...pubItems]
    };
  } catch (err) {
    defaultLogger.error('FISH-AUDIO', `Error en listado de modelos IPC: ${err.message}`);
    return { total: 0, items: [] };
  }
});

ipcMain.handle('FISH_AUDIO_CREATE_MODEL', async (event, { title, audioBase64, audioMimeType = 'audio/wav', sampleText = '', description = '', visibility = 'private', apiKey = null }) => {
  try {
    const settings = loadSavedSettings();
    const effectiveKey = apiKey || settings.fishApiKey || '';
    fishAudioService.setApiKey(effectiveKey);

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const result = await fishAudioService.createVoiceClone({
      title,
      audioBuffer,
      audioMimeType,
      sampleText,
      description,
      visibility
    });

    return result;
  } catch (err) {
    defaultLogger.error('FISH-AUDIO', `Error en creación de modelo IPC: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('FISH_AUDIO_TEST_KEY', async (event, { apiKey = null } = {}) => {
  try {
    const settings = loadSavedSettings();
    const effectiveKey = apiKey || settings.fishApiKey;
    return await fishAudioService.testConnection(effectiveKey);
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.on('DISPLAY_SUBTITLE', (event, payload) => {
  defaultLogger.info('SUBTITLE', `Actualizando subtítulo: [${payload.originalText || ''}] ➔ [${payload.translatedText || ''}]`);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('DISPLAY_SUBTITLE', payload);
  }
});

ipcMain.on('DISPLAY_SPEECH_STATE', (event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('DISPLAY_SPEECH_STATE', payload);
  }
});

ipcMain.on('TOGGLE_OVERLAY', (event, show) => {
  defaultLogger.info('UI', `Toggle overlay solicitado: ${show ? 'MOSTRAR' : 'OCULTAR'}`);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (show) {
      overlayWindow.show();
      broadcastOverlayState(true);
    } else {
      overlayWindow.hide();
      broadcastOverlayState(false);
    }
  }
});

ipcMain.handle('GET_OVERLAY_STATE', async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return { isVisible: overlayWindow.isVisible() };
  }
  return { isVisible: false };
});

ipcMain.on('OPEN_DEVTOOLS', () => {
  defaultLogger.info('DEVTOOLS', 'Abriendo Developer Tools de Chromium...');
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.on('LOG_CLIENT_EVENT', (event, { category, message, type }) => {
  defaultLogger.log(category, message);
  traceRecorder.record('log', { category, message });
});

ipcMain.on('OPEN_EXTERNAL_URL', (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('GET_DESKTOP_AUDIO_SOURCE', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    if (sources && sources.length > 0) {
      defaultLogger.info('AUDIO', `Fuente de audio de sistema capturada: ${sources[0].id} (${sources[0].name})`);
      return sources[0].id;
    }
  } catch (err) {
    defaultLogger.error('AUDIO', `Error obteniendo fuentes de desktopCapturer: ${err.message}`);
  }
  return null;
});

ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event, opts = { types: ['screen', 'window'] }) => {
  try {
    const sources = await desktopCapturer.getSources(opts);
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    defaultLogger.error('AUDIO', `Error en DESKTOP_CAPTURER_GET_SOURCES: ${err.message}`);
    return [];
  }
});

// ── Diagnóstico y Validación de Hardware ─────────────────────────────
ipcMain.handle('CHECK_HARDWARE', async () => {
  const os = require('os');
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePct = Math.round((usedMem / totalMem) * 100);

  let gpuFeatureStatus = {};
  let gpuInfo = {};
  try {
    gpuFeatureStatus = app.getGPUFeatureStatus();
    gpuInfo = await app.getGPUInfo('basic');
  } catch (e) {
    gpuFeatureStatus = { error: e.message };
  }

  // Medir latencia a endpoints clave
  const startPing = Date.now();
  let networkPing = -1;
  try {
    await new Promise((resolve) => {
      const req = https.get('https://translate.google.com/', { timeout: 2500 }, (res) => {
        networkPing = Date.now() - startPing;
        res.resume();
        resolve();
      });
      req.on('error', () => { networkPing = -1; resolve(); });
      req.on('timeout', () => { req.destroy(); networkPing = -1; resolve(); });
    });
  } catch (e) {
    networkPing = -1;
  }

  return {
    cpu: {
      model: cpus[0]?.model || 'Procesador estándar',
      cores: cpus.length,
      speed: cpus[0]?.speed || 0,
      arch: os.arch()
    },
    memory: {
      totalGB: (totalMem / (1024 ** 3)).toFixed(1),
      freeGB: (freeMem / (1024 ** 3)).toFixed(1),
      usedGB: (usedMem / (1024 ** 3)).toFixed(1),
      usagePct: memUsagePct
    },
    os: {
      platform: os.platform(),
      release: os.release(),
      type: os.type(),
      uptimeHours: (os.uptime() / 3600).toFixed(1)
    },
    gpu: {
      features: gpuFeatureStatus,
      info: gpuInfo
    },
    network: {
      pingMs: networkPing,
      online: networkPing > 0
    },
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  };
});

// ── Handlers para Acciones de Cabecera (PiP y Exportación) ─────────
let isPipMode = false;
let previousBounds = null;

ipcMain.handle('TOGGLE_PIP_MODE', async () => {
  if (!controlWindow || controlWindow.isDestroyed()) return false;
  
  if (isPipMode) {
    controlWindow.setMinimumSize(WINDOW_SIZE.minWidth, WINDOW_SIZE.minHeight);
    if (previousBounds) {
      controlWindow.setBounds(previousBounds);
    } else {
      controlWindow.setSize(WINDOW_SIZE.width, WINDOW_SIZE.height);
      controlWindow.center();
    }
    controlWindow.setAlwaysOnTop(false);
    controlWindow.setResizable(true);
    isPipMode = false;
    defaultLogger.info('WINDOW', 'Ventana restaurada a modo Estudio.');
  } else {
    previousBounds = controlWindow.getBounds();
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;
    const pipWidth = 360;
    const pipHeight = 340;
    const pipX = screenWidth - pipWidth - 24;
    const pipY = screenHeight - pipHeight - 24;

    // Sin bajar antes el tamaño mínimo de la ventana, Windows no la deja tan pequeña
    controlWindow.setMinimumSize(320, 260);
    controlWindow.setBounds({ x: pipX, y: pipY, width: pipWidth, height: pipHeight });
    controlWindow.setAlwaysOnTop(true, 'screen-saver');
    isPipMode = true;
    defaultLogger.info('WINDOW', 'Ventana configurada en modo Mini-Player Flotante (PiP).');
  }
  return isPipMode;
});

ipcMain.handle('EXPORT_SESSION_REPORT', async (event, { content, format = 'txt' }) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultFilename = `ViBeTranslate_Report_${timestamp}.${format}`;
    const result = await dialog.showSaveDialog(controlWindow, {
      title: 'Guardar Reporte y Transcripción de Sesión',
      defaultPath: path.join(app.getPath('downloads'), defaultFilename),
      filters: [
        { name: 'Documento de Texto', extensions: ['txt', 'md', 'json'] },
        { name: 'Todos los Archivos', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, content, 'utf8');
      defaultLogger.success('EXPORT', `Reporte exportado exitosamente a: ${result.filePath}`);
      return { success: true, filePath: result.filePath };
    }
    return { success: false, canceled: true };
  } catch (err) {
    defaultLogger.error('EXPORT', `Error al exportar reporte: ${err.message}`);
    return { success: false, error: err.message };
  }
});



