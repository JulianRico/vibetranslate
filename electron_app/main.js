/**
 * main.js - Proceso Principal de Electron para MeetTranslate Desktop
 * =================================================================
 * Soportado para: Microsoft Teams Desktop, Zoom App y Google Meet
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, desktopCapturer, session, dialog } = require('electron');
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

const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  groqApiKey: '',
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
  glossary: DEFAULT_GLOSSARY,
  subtitleFontSize: 16,
  subtitleOpacity: 92,
  subtitleBgColor: '#000000',
  translateIncoming: true,
  autoStartListening: false
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
    width: 1060,
    height: 880,
    minWidth: 860,
    minHeight: 640,
    resizable: true,
    title: 'ViBeTranslate Pro Studio',
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
    defaultLogger.info('UI', 'Ventana de Subtítulos cerrada.');
    overlayWindow = null;
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
  if (!text || !text.trim()) return { original: '', translated: '', detectedLang: 'es', targetLang: 'en' };

  const cleanText = text.trim();
  const settings = loadSavedSettings();
  const correctedText = applyTechnicalGlossary(cleanText, settings.glossary);

  let srcShort = (sourceLang || 'auto').substring(0, 2);
  let tgtShort = (targetLang || 'auto').substring(0, 2);

  const startTime = Date.now();

  return new Promise((resolve) => {
    const sanitizedText = correctedText.replace(/[\r\n]+/g, ' ').trim();
    const slParam = (srcShort === 'es' || srcShort === 'en') ? srcShort : 'auto';
    const tlParam = (tgtShort === 'es' || tgtShort === 'en') ? tgtShort : (slParam === 'es' ? 'en' : 'es');

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tlParam}&dt=t&q=${encodeURIComponent(sanitizedText)}`;

    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        const elapsed = Date.now() - startTime;
        try {
          const data = JSON.parse(body);
          const detected = (data && data[2]) ? data[2] : (slParam !== 'auto' ? slParam : 'es');

          // Si el texto hablado está en inglés y el destino era inglés, auto-traducir a español
          if (detected === 'en' && tlParam === 'en') {
            const urlEs = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(sanitizedText)}`;
            https.get(urlEs, (resEs) => {
              let bodyEs = '';
              resEs.on('data', (c) => bodyEs += c);
              resEs.on('end', () => {
                try {
                  const dataEs = JSON.parse(bodyEs);
                  const translated = dataEs[0].map(chunk => chunk[0]).filter(Boolean).join('');
                  defaultLogger.success('TRANSLATE', `Auto-traducción bidireccional (EN ➔ ES) en ${elapsed}ms: "${translated.trim()}"`);
                  resolve({ original: correctedText, translated: translated.trim(), detectedLang: 'en', targetLang: 'es' });
                } catch (e) {
                  resolve({ original: correctedText, translated: correctedText, detectedLang: 'en', targetLang: 'es' });
                }
              });
            });
            return;
          }

          if (data && Array.isArray(data[0])) {
            const translated = data[0].map(chunk => chunk[0]).filter(Boolean).join('');
            if (translated && translated.trim()) {
              defaultLogger.success('TRANSLATE', `Traducción completada (${detected} ➔ ${tlParam}) en ${elapsed}ms: "${translated.trim()}"`);
              return resolve({ original: correctedText, translated: translated.trim(), detectedLang: detected, targetLang: tlParam });
            }
          }
          resolve({ original: correctedText, translated: correctedText, detectedLang: detected, targetLang: tlParam });
        } catch (e) {
          resolve({ original: correctedText, translated: correctedText, detectedLang: 'es', targetLang: 'en' });
        }
      });
    }).on('error', (err) => {
      resolve({ original: correctedText, translated: correctedText, detectedLang: 'es', targetLang: 'en' });
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

ipcMain.on('DISPLAY_SPEECH_STATE', (event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('DISPLAY_SPEECH_STATE', payload);
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
    if (previousBounds) {
      controlWindow.setBounds(previousBounds);
    } else {
      controlWindow.setSize(1060, 880);
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
    const pipWidth = 460;
    const pipHeight = 360;
    const pipX = screenWidth - pipWidth - 24;
    const pipY = screenHeight - pipHeight - 24;

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



