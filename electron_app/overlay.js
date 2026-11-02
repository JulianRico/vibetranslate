/**
 * overlay.js - Lógica del Renderer para la Ventana de Subtítulos Flotante
 */

const { ipcRenderer } = require('electron');
const { createSubtitleLines } = require('./subtitle-lines');

document.addEventListener('DOMContentLoaded', () => {
  const elOriginal = document.getElementById('sub-original');
  const elTranslated = document.getElementById('sub-translated');
  const elHistory = document.getElementById('sub-history');
  const langBadge = document.getElementById('lang-pair');
  const overlayCard = document.getElementById('overlay-card');

  const btnFontDec = document.getElementById('btn-font-dec');
  const btnFontInc = document.getElementById('btn-font-inc');
  const btnMinimize = document.getElementById('btn-minimize');

  let currentFontSize = 18;
  let isMinimized = false;

  const lines = createSubtitleLines({ history: 2 });

  function render() {
    if (elHistory) {
      elHistory.replaceChildren(...lines.history().map((line) => {
        const el = document.createElement('div');
        el.className = 'sub-history-line';
        el.textContent = `${line.icon} ${line.text}`;
        return el;
      }));
    }
    const current = lines.current();
    if (!current) return;
    if (elOriginal) elOriginal.textContent = `${current.icon} ${current.original || '…'}`;
    if (elTranslated) elTranslated.textContent = current.provisional ? `${current.text} …` : current.text;
  }

  // ── Escuchar mensajes desde el Proceso Principal ──────────────────
  ipcRenderer.on('DISPLAY_SUBTITLE', (event, payload) => {
    const { originalText, translatedText, direction } = payload;

    // Quién habla, con las mismas palabras que la conversación de la ventana principal
    const icon = direction === 'incoming' ? 'Reunión:' : 'Tú:';

    // El texto oído puede llegar después de la traducción: solo se completa la línea superior
    if (payload.update) {
      if (elOriginal && originalText) elOriginal.textContent = `${icon} ${originalText}`;
      return;
    }

    if (!translatedText) {
      if (elOriginal && originalText) elOriginal.textContent = `${icon} ${originalText}`;
      return;
    }
    // La frase terminada que estaba en pantalla pasa al historial; un texto provisional simplemente se reemplaza.
    // Con `replace`, la línea de esa frase se reescribe donde esté (resto de la frase o traducción de la nube).
    lines.apply({
      lineId: payload.lineId ?? null,
      replace: !!payload.replace,
      grows: !!payload.grows,
      icon,
      original: originalText,
      text: translatedText,
      provisional: payload.isFinal === false
    });
    render();
  });

  const statusBadgeText = document.querySelector('.status-badge span:last-child');
  const statusDot = document.querySelector('.status-dot');

  ipcRenderer.on('DISPLAY_SPEECH_STATE', (event, { speaking }) => {
    if (statusBadgeText && statusDot) {
      if (speaking) {
        statusBadgeText.textContent = 'Hablan en la reunión';
        statusDot.style.background = '#ffd27a';
      } else {
        statusBadgeText.textContent = 'Tu turno';
        statusDot.style.background = '#6ccb5f';
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
      if (elHistory) elHistory.style.display = 'none';
      btnMinimize.textContent = '▢';
    } else {
      elOriginal.style.display = 'block';
      if (elHistory) elHistory.style.display = 'flex';
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
