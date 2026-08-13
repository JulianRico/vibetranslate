/**
 * overlay.js - Lógica del Renderer para la Ventana de Subtítulos Flotante
 */

const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
  const elOriginal = document.getElementById('sub-original');
  const elTranslated = document.getElementById('sub-translated');
  const langBadge = document.getElementById('lang-pair');
  const overlayCard = document.getElementById('overlay-card');

  const btnFontDec = document.getElementById('btn-font-dec');
  const btnFontInc = document.getElementById('btn-font-inc');
  const btnMinimize = document.getElementById('btn-minimize');

  let currentFontSize = 18;
  let isMinimized = false;

  // ── Escuchar mensajes desde el Proceso Principal ──────────────────
  ipcRenderer.on('DISPLAY_SUBTITLE', (event, payload) => {
    const { originalText, translatedText, direction } = payload;

    if (elOriginal && originalText) {
      elOriginal.textContent = (direction === 'incoming' ? '👤 ' : '🎙️ ') + originalText;
    }

    if (elTranslated && translatedText) {
      elTranslated.textContent = translatedText;
    }
  });

  ipcRenderer.on('SETTINGS_CHANGED', (event, settings) => {
    if (settings.fontSize) {
      currentFontSize = settings.fontSize;
      document.documentElement.style.setProperty('--mt-font-size', `${currentFontSize}px`);
    }

    if (settings.sourceLang && settings.targetLang && langBadge) {
      const srcStr = settings.sourceLang.substring(0, 2).toUpperCase();
      const tgtStr = settings.targetLang.substring(0, 2).toUpperCase();
      langBadge.textContent = `${srcStr} ➔ ${tgtStr}`;
    }
  });

  // ── Ajustes de Fuente y Minimizado ────────────────────────────────
  btnFontInc.addEventListener('click', () => {
    currentFontSize = Math.min(32, currentFontSize + 2);
    document.documentElement.style.setProperty('--mt-font-size', `${currentFontSize}px`);
    ipcRenderer.invoke('SAVE_SETTINGS', { fontSize: currentFontSize });
  });

  btnFontDec.addEventListener('click', () => {
    currentFontSize = Math.max(12, currentFontSize - 2);
    document.documentElement.style.setProperty('--mt-font-size', `${currentFontSize}px`);
    ipcRenderer.invoke('SAVE_SETTINGS', { fontSize: currentFontSize });
  });

  btnMinimize.addEventListener('click', () => {
    isMinimized = !isMinimized;
    if (isMinimized) {
      elOriginal.style.display = 'none';
      btnMinimize.textContent = '▢';
    } else {
      elOriginal.style.display = 'block';
      btnMinimize.textContent = '_';
    }
  });
});
