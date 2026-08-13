/**
 * main.js - Proceso Principal de Electron para MeetTranslate Desktop
 * =================================================================
 * Soportado para: Microsoft Teams Desktop, Zoom App y Google Meet
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { applyTechnicalGlossary, DEFAULT_GLOSSARY } = require('./glossary');
const { defaultLogger } = require('./logger');

// Inicializar logs en disco
defaultLogger.clear();
defaultLogger.info('SYSTEM', '🚀 Iniciando MeetTranslate Desktop App (Proceso Principal)...');

// Configuración de Chromium para optimizar rendimiento y evitar bloqueos de caché en Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

// Garantizar una única instancia activa para evitar colisiones de archivos
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  defaultLogger.warn('SYSTEM', 'Se detectó otra instancia en ejecución. Cerrando proceso duplicado...');
  app.quit();
}

let controlWindow = null;
let overlayWindow = null;

// Ruta del archivo de configuración guardado
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
defaultLogger.info('CONFIG', `Ruta del archivo de configuración: ${settingsFilePath}`);

const DEFAULT_SETTINGS = {
  active: false,
  sourceLang: 'es-ES',
  targetLang: 'en',
  sttEngine: 'gemini_live',
  geminiApiKey: '',
  geminiVoice: 'Puck',
  groqApiKey: '',
  noiseGateThreshold: 0.016,
  engine: 'fast',
  fontSize: 18,
  position: { top: 100, left: 100 },
  glossary: DEFAULT_GLOSSARY
};

function loadSavedSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, 'utf8');
      const loaded = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      defaultLogger.info('CONFIG', 'Configuración cargada correctamente desde disco.');
      return loaded;
    }
  } catch (err) {
    defaultLogger.warn('CONFIG', 'Error leyendo settings.json, usando valores por defecto:', err.message);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
    defaultLogger.info('CONFIG', 'Configuración guardada en disco exitosamente.');
  } catch (err) {
    defaultLogger.error('CONFIG', 'Error guardando settings.json:', err.message);
  }
}

function createControlWindow() {
  defaultLogger.info('UI', 'Creando Ventana del Panel de Control Principal...');
  controlWindow = new BrowserWindow({
    width: 520,
    height: 840,
    resizable: true,
    title: 'MeetTranslate Desktop AI',
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
    height: 160,
    x: Math.round((screenWidth - 760) / 2),
    y: screenHeight - 200,
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

  overlayWindow.on('closed', () => {
    defaultLogger.info('UI', 'Overlay Flotante cerrado.');
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  defaultLogger.success('SYSTEM', '✅ Electron app.whenReady disparado.');
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
    if (overlayWindow) {
      if (overlayWindow.isVisible()) overlayWindow.hide();
      else overlayWindow.show();
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

ipcMain.handle('TRANSLATE_TEXT', async (event, { text, sourceLang, targetLang }) => {
  if (!text || !text.trim()) return '';

  const cleanText = text.trim();
  const settings = loadSavedSettings();
  const correctedText = applyTechnicalGlossary(cleanText, settings.glossary);

  let srcShort = (sourceLang || 'es-ES').substring(0, 2);
  let tgtShort = (targetLang || 'en').substring(0, 2);

  if (srcShort === tgtShort && targetLang !== 'auto') {
    tgtShort = srcShort === 'es' ? 'en' : 'es';
  }

  const startTime = Date.now();
  defaultLogger.info('TRANSLATE', `Solicitando traducción (${srcShort} ➔ ${tgtShort}): "${cleanText}"`);

  return new Promise((resolve) => {
    const sanitizedText = correctedText.replace(/[\r\n]+/g, ' ').trim();
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcShort}&tl=${tgtShort}&dt=t&q=${encodeURIComponent(sanitizedText)}`;

    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        try {
          const data = JSON.parse(body);
          if (data && Array.isArray(data[0])) {
            const translated = data[0].map(chunk => chunk[0]).filter(Boolean).join('');
            if (translated && translated.trim()) {
              defaultLogger.success('TRANSLATE', `Traducción completada en ${elapsed}ms: "${translated.trim()}"`);
              return resolve({ original: correctedText, translated: translated.trim() });
            }
          }
          defaultLogger.warn('TRANSLATE', `Respuesta vacía o no estructurada en ${elapsed}ms. Devolviendo texto corregido.`);
          resolve({ original: correctedText, translated: correctedText });
        } catch (e) {
          defaultLogger.error('TRANSLATE', `Excepción procesando respuesta JSON de Google Translate: ${e.message}`);
          resolve({ original: correctedText, translated: correctedText });
        }
      });
    }).on('error', (err) => {
      defaultLogger.error('TRANSLATE', `Error en petición HTTP a Google Translate: ${err.message}`);
      resolve({ original: correctedText, translated: correctedText });
    });
  });
});

ipcMain.handle('TRANSCRIBE_GROQ', async (event, { audioBase64, apiKey, language, format = 'wav' }) => {
  if (!apiKey || !apiKey.trim()) {
    defaultLogger.warn('GROQ', 'Groq API Key no configurada en la aplicación.');
    return { text: '' };
  }

  try {
    const buffer = Buffer.from(audioBase64, 'base64');
    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/webm';
    const fileName = format === 'wav' ? 'audio.wav' : 'audio.webm';
    const blob = new Blob([buffer], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    if (language && language !== 'auto') {
      formData.append('language', language);
    }

    const startTime = Date.now();
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: formData
    });

    const elapsed = Date.now() - startTime;
    if (!response.ok) {
      const errText = await response.text();
      defaultLogger.error('GROQ', `Error HTTP ${response.status} en Groq Whisper (${elapsed}ms): ${errText}`);
      return { text: '' };
    }

    const data = await response.json();
    defaultLogger.success('GROQ', `Transcripción Groq Whisper completada en ${elapsed}ms: "${data.text}"`);
    return { text: data.text || '' };

  } catch (err) {
    defaultLogger.error('GROQ', `Excepción en llamada a Groq Whisper: ${err.message}`);
    return { text: '' };
  }
});

ipcMain.on('DISPLAY_SUBTITLE', (event, payload) => {
  defaultLogger.info('SUBTITLE', `Actualizando subtítulo: [${payload.originalText || ''}] ➔ [${payload.translatedText || ''}]`);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('DISPLAY_SUBTITLE', payload);
  }
});

ipcMain.on('TOGGLE_OVERLAY', (event, show) => {
  defaultLogger.info('UI', `Toggle overlay solicitado: ${show ? 'MOSTRAR' : 'OCULTAR'}`);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (show) overlayWindow.show();
    else overlayWindow.hide();
  }
});

ipcMain.on('OPEN_DEVTOOLS', () => {
  defaultLogger.info('DEVTOOLS', 'Abriendo Developer Tools de Chromium...');
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.on('LOG_CLIENT_EVENT', (event, { category, message, type }) => {
  defaultLogger.log(category, message);
});

ipcMain.on('OPEN_EXTERNAL_URL', (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
});

