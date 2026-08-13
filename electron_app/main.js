/**
 * main.js - Proceso Principal de Electron para MeetTranslate Desktop
 * =================================================================
 * Soportado para: Microsoft Teams Desktop, Zoom App y Google Meet
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { applyTechnicalGlossary, DEFAULT_GLOSSARY } = require('./glossary');

// Configuración de Chromium para optimizar rendimiento y evitar bloqueos de caché en Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

// Garantizar una única instancia activa para evitar colisiones de archivos
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let controlWindow = null;
let overlayWindow = null;

// Ruta del archivo de configuración guardado
const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  active: false,
  sourceLang: 'es-ES',
  targetLang: 'en',
  sttEngine: 'webspeech',
  geminiApiKey: '',
  geminiVoice: 'Puck',
  groqApiKey: '',
  engine: 'fast',
  fontSize: 18,
  position: { top: 100, left: 100 },
  glossary: DEFAULT_GLOSSARY
};

function loadSavedSettings() {
  try {
    if (fs.existsSync(settingsFilePath)) {
      const data = fs.readFileSync(settingsFilePath, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    }
  } catch (err) {
    console.warn('[Main Process] Error leyendo settings.json:', err);
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[Main Process] Error guardando settings.json:', err);
  }
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 480,
    height: 760,
    resizable: true,
    title: 'MeetTranslate Desktop AI',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  controlWindow.loadFile(path.join(__dirname, 'index.html'));

  controlWindow.on('closed', () => {
    controlWindow = null;
    if (overlayWindow) overlayWindow.close();
  });
}

function createOverlayWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

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

  // Permitir arrastrar la ventana manteniendo siempre la visibilidad superior
  overlayWindow.setAlwaysOnTop(true, 'floating');

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

app.whenReady().then(() => {
  createControlWindow();
  createOverlayWindow();

  app.on('second-instance', () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });

  // Registrar Atajos de Teclado Globales
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (overlayWindow) {
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.show();
      }
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
      createOverlayWindow();
    }
  });
});

app.on('will-quit', () => {
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

  // Notificar al overlay los cambios de fuente/idioma
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

  return new Promise((resolve) => {
    const sanitizedText = correctedText.replace(/[\r\n]+/g, ' ').trim();
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${srcShort}&tl=${tgtShort}&dt=t&q=${encodeURIComponent(sanitizedText)}`;

    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && Array.isArray(data[0])) {
            const translated = data[0].map(chunk => chunk[0]).filter(Boolean).join('');
            if (translated && translated.trim()) {
              return resolve({ original: correctedText, translated: translated.trim() });
            }
          }
          resolve({ original: correctedText, translated: correctedText });
        } catch (e) {
          resolve({ original: correctedText, translated: correctedText });
        }
      });
    }).on('error', () => {
      resolve({ original: correctedText, translated: correctedText });
    });
  });
});

ipcMain.on('DISPLAY_SUBTITLE', (event, payload) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('DISPLAY_SUBTITLE', payload);
  }
});

ipcMain.on('TOGGLE_OVERLAY', (event, show) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (show) overlayWindow.show();
    else overlayWindow.hide();
  }
});
