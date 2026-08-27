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

  const statusBadgeText = document.querySelector('.status-badge span:last-child');
  const statusDot = document.querySelector('.status-dot');

  ipcRenderer.on('DISPLAY_SPEECH_STATE', (event, { speaking }) => {
    if (statusBadgeText && statusDot) {
      if (speaking) {
        statusBadgeText.textContent = '🟡 RECEPTOR HABLANDO (Espera...)';
        statusDot.style.background = '#f59e0b';
        statusDot.style.boxShadow = '0 0 6px #f59e0b';
      } else {
        statusBadgeText.textContent = '🟢 LIBRE (Tu turno para hablar)';
        statusDot.style.background = '#10b981';
        statusDot.style.boxShadow = '0 0 6px #10b981';
      }
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

  const btnCloseOverlay = document.getElementById('btn-close-overlay');
  if (btnCloseOverlay) {
    btnCloseOverlay.addEventListener('click', () => {
      ipcRenderer.send('TOGGLE_OVERLAY', false);
    });
  }
});
