/**
 * content.js - Interfaz de Subtítulos Flotantes inyectada en Meet/Zoom/Teams
 * Responsabilidades:
 * 1. Creación e inyección limpia del overlay UI Glassmorphism en la página.
 * 2. Soporte completo de arrastre (drag & drop) y restricciones de viewport.
 * 3. Persistencia de coordenadas de pantalla y preferencias visuales (tamaño de fuente).
 * 4. Actualización en tiempo real de subtítulos transcritos y traducidos.
 * 5. Destrucción limpia del DOM al desactivar la traducción.
 */

(function () {
  // ID único del elemento inyectado en el DOM
  const OVERLAY_ID = 'meet-translate-overlay';

  let overlayElement = null;
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let isMinimized = false;
  let currentFontSize = 18;

  /**
   * Escuchador central de mensajes desde background.js
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'SHOW_OVERLAY':
        createOrShowOverlay(message.settings);
        sendResponse({ success: true });
        break;

      case 'HIDE_OVERLAY':
        removeOverlay();
        sendResponse({ success: true });
        break;

      case 'DISPLAY_SUBTITLE':
        updateSubtitleText(message.originalText, message.translatedText, message.isFinal);
        break;

      case 'SETTINGS_CHANGED':
        if (message.settings) {
          applySettings(message.settings);
        }
        break;

      case 'TRANSLATION_ERROR':
        showErrorToast(message.error);
        break;

      default:
        break;
    }
    return true;
  });

  /**
   * Crea o muestra el contenedor flotante de subtítulos.
   */
  async function createOrShowOverlay(settings = {}) {
    let container = document.getElementById(OVERLAY_ID);

    if (!container) {
      container = document.createElement('div');
      container.id = OVERLAY_ID;
      container.innerHTML = `
        <div class="mt-card" id="mt-card">
          <div class="mt-header" id="mt-header">
            <div class="mt-brand">
              <span class="mt-badge">
                <span class="mt-live-dot"></span>
                LIVE AI
              </span>
              <span id="mt-lang-pair">ES ➔ EN</span>
              <span id="mt-mixer-status" style="font-size:10px;margin-left:6px;opacity:0.7" title="Estado del mixer de audio WebRTC">⏳</span>
            </div>
            <div class="mt-controls">
              <button type="button" class="mt-btn-icon" id="mt-btn-tts" title="Voz Hablada Traducida (TTS) Encendida/Apagada">🔊</button>
              <button type="button" class="mt-btn-icon" id="mt-btn-font-dec" title="Disminuir letra">A-</button>
              <button type="button" class="mt-btn-icon" id="mt-btn-font-inc" title="Aumentar letra">A+</button>
              <button type="button" class="mt-btn-icon" id="mt-btn-minimize" title="Minimizar / Expandir">_</button>
              <button type="button" class="mt-btn-icon mt-btn-close" id="mt-btn-close" title="Cerrar">✕</button>
            </div>
          </div>
          <div class="mt-body">
            <div class="mt-original-text" id="mt-original">Escuchando reunión...</div>
            <div class="mt-translated-text" id="mt-translated">Listening to meeting audio...</div>
          </div>
        </div>
      `;

      document.body.appendChild(container);
      overlayElement = container;

      // Eventos de interacción
      setupDragEvents(container);
      setupButtonEvents(container);

      // Escuchar actualizaciones de estado del mixer (audio-mixer.js en MAIN world)
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'MT_MIXER_STATUS_UPDATE') {
          updateMixerStatusIndicator(event.data.status);
        }
      });
    }

    container.classList.remove('mt-hidden');

    // Cargar configuración de fuente y posición previa
    if (settings) {
      applySettings(settings);
    }
  }

  /**
   * Actualiza el indicador visual del estado del mixer en la cabecera del overlay.
   */
  function updateMixerStatusIndicator(status) {
    const el = document.getElementById('mt-mixer-status');
    if (!el) return;

    const statusMap = {
      'GUM_INTERCEPTED': '🟡',
      'MIXER_ACTIVE':    '🟡',
      'TRACK_REPLACED':  '🟢',
      'STREAM_REPLACED': '🟢',
      'MIC_MUTED':       '🔇',
      'MIC_UNMUTED':     '🎙️',
      'TTS_PLAYING':     '🔊',
      'TTS_FAILED':      '🔴',
      'TTS_ERROR':       '🔴'
    };

    el.textContent = statusMap[status] || '⏳';
    el.title = `Mixer: ${status}`;
  }

  /**
   * Configura los eventos de arrastre (drag and drop) en la cabecera del overlay.
   */
  function setupDragEvents(container) {
    const header = container.querySelector('#mt-header');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      // Ignorar si se hace clic en botones de la cabecera
      if (e.target.closest('.mt-controls')) return;

      isDragging = true;
      const rect = container.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      header.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !overlayElement) return;

      let newLeft = e.clientX - dragOffsetX;
      let newTop = e.clientY - dragOffsetY;

      // Restricciones de viewport para no perder el elemento fuera de la pantalla
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const overlayRect = overlayElement.getBoundingClientRect();

      newLeft = Math.max(10, Math.min(newLeft, viewportWidth - overlayRect.width - 10));
      newTop = Math.max(10, Math.min(newTop, viewportHeight - overlayRect.height - 10));

      overlayElement.style.left = `${newLeft}px`;
      overlayElement.style.top = `${newTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging && overlayElement) {
        isDragging = false;
        const header = overlayElement.querySelector('#mt-header');
        if (header) header.style.cursor = 'grab';

        // Persistir la nueva posición en chrome.storage.local
        const top = parseInt(overlayElement.style.top, 10);
        const left = parseInt(overlayElement.style.left, 10);
        if (!isNaN(top) && !isNaN(left)) {
          savePosition(top, left);
        }
      }
    });
  }

  let ttsEnabled = false;
  let activeTargetLang = 'en';
  let lastSpokenText = '';

  /**
   * Configura los botones de control de la cabecera (A+, A-, TTS, Minimizar, Cerrar).
   */
  function setupButtonEvents(container) {
    const btnTts = container.querySelector('#mt-btn-tts');
    const btnFontInc = container.querySelector('#mt-btn-font-inc');
    const btnFontDec = container.querySelector('#mt-btn-font-dec');
    const btnMinimize = container.querySelector('#mt-btn-minimize');
    const btnClose = container.querySelector('#mt-btn-close');
    const card = container.querySelector('#mt-card');

    if (btnTts) {
      btnTts.addEventListener('click', () => {
        ttsEnabled = !ttsEnabled;
        btnTts.textContent = ttsEnabled ? '🔊' : '🔇';
        btnTts.style.opacity = ttsEnabled ? '1' : '0.5';

        // Silenciar/activar micrófono original en el stream WebRTC
        // Cuando TTS está ON: el remoto solo escucha la traducción en inglés
        // Cuando TTS está OFF: el remoto escucha tu voz directa (sin traducir)
        window.postMessage({
          type: 'MT_SET_MIC_MUTE',
          muted: ttsEnabled
        }, '*');

        if (!ttsEnabled && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      });
    }

    if (btnFontInc) {
      btnFontInc.addEventListener('click', () => {
        changeFontSize(2);
      });
    }

    if (btnFontDec) {
      btnFontDec.addEventListener('click', () => {
        changeFontSize(-2);
      });
    }

    if (btnMinimize) {
      btnMinimize.addEventListener('click', () => {
        isMinimized = !isMinimized;
        card.classList.toggle('mt-minimized', isMinimized);
        btnMinimize.textContent = isMinimized ? '▢' : '_';
      });
    }

    if (btnClose) {
      btnClose.addEventListener('click', () => {
        // Enviar mensaje al SW para desactivar
        chrome.runtime.sendMessage({
          type: 'TOGGLE_TRANSLATION',
          active: false
        }).catch(() => {});
        removeOverlay();
      });
    }
  }

  /**
   * Ajusta dinámicamente el tamaño de fuente y lo persiste.
   */
  function changeFontSize(delta) {
    currentFontSize = Math.max(12, Math.min(32, currentFontSize + delta));
    if (overlayElement) {
      overlayElement.style.setProperty('--mt-font-size', `${currentFontSize}px`);
    }

    // Guardar en settings de la extensión
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { fontSize: currentFontSize }
    }).catch(() => {});
  }

  /**
   * Guarda las coordenadas de posición en el storage local.
   */
  function savePosition(top, left) {
    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings: { position: { top, left } }
    }).catch(() => {});
  }

  /**
   * Aplica la configuración recibida (posición, fuente, par de idiomas).
   */
  function applySettings(settings) {
    if (!overlayElement) return;

    if (settings.targetLang) {
      activeTargetLang = settings.targetLang;
    }

    if (settings.fontSize) {
      currentFontSize = settings.fontSize;
      overlayElement.style.setProperty('--mt-font-size', `${currentFontSize}px`);
    }

    if (settings.bgOpacity !== undefined) {
      overlayElement.style.setProperty('--mt-bg-opacity', settings.bgOpacity);
    }

    if (settings.position && settings.position.top !== undefined) {
      overlayElement.style.top = `${settings.position.top}px`;
      overlayElement.style.left = `${settings.position.left}px`;
    }

    const langBadge = overlayElement.querySelector('#mt-lang-pair');
    if (langBadge && settings.sourceLang && settings.targetLang) {
      const srcStr = settings.sourceLang.substring(0, 2).toUpperCase();
      const tgtStr = settings.targetLang.substring(0, 2).toUpperCase();
      langBadge.textContent = `${srcStr} ➔ ${tgtStr}`;
    }
  }

  /**
   * Actualiza el contenido de los subtítulos en pantalla y reproduce la traducción hablada si está activa.
   */
  function updateSubtitleText(originalText, translatedText, isFinal) {
    if (!overlayElement) return;

    const elOriginal = overlayElement.querySelector('#mt-original');
    const elTranslated = overlayElement.querySelector('#mt-translated');

    if (elOriginal && originalText) {
      elOriginal.textContent = originalText;
    }

    if (elTranslated && translatedText) {
      elTranslated.textContent = translatedText;

      // Si la voz hablada (TTS) está activada, hablar la traducción por el parlante
      if (ttsEnabled && isFinal && translatedText.trim().length > 0) {
        speakTranslation(translatedText, activeTargetLang);
      }
    }
  }

  /**
   * Reproduce la traducción mediante voz sintética (Text-To-Speech).
   * Doble emisión:
   *   1. speechSynthesis → el USUARIO escucha la traducción por sus parlantes.
   *   2. Service Worker descarga TTS MP3 (sin CORS) → content script decodifica →
   *      postMessage al audio-mixer.js (MAIN world) → se inyecta en el stream
   *      WebRTC de la llamada → el PARTICIPANTE REMOTO escucha la traducción.
   */
  async function speakTranslation(text, targetLang) {
    if (!text || text === lastSpokenText) return;
    lastSpokenText = text;

    const lang = targetLang ? targetLang.substring(0, 2) : 'en';
    const cleanText = text.trim().slice(0, 200);

    // 1. Reproducción LOCAL para el usuario (por sus parlantes/auriculares)
    try {
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.lang = lang === 'es' ? 'es-ES' : 'en-US';
        utterance.rate = 0.95;
        utterance.volume = 1.0;
        window.speechSynthesis.speak(utterance);
      }
    } catch (e) {
      console.warn('[MeetTranslate AI] Error en TTS local:', e);
    }

    // 2. Transmisión REMOTA al otro participante vía WebRTC mixer
    //    Ruta: content.js → background.js (fetch sin CORS) → content.js → audio-mixer.js (MAIN)
    try {
      chrome.runtime.sendMessage(
        { type: 'FETCH_TTS_AUDIO', text: cleanText, lang: lang },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[MeetTranslate AI] Error en FETCH_TTS_AUDIO:', chrome.runtime.lastError.message);
            return;
          }
          if (response && response.success && response.audioBase64) {
            // Decodificar base64 a ArrayBuffer
            const binaryStr = atob(response.audioBase64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i);
            }
            // Enviar al audio-mixer.js (mundo MAIN) para inyectarlo en el stream WebRTC
            window.postMessage({
              type: 'MT_PLAY_TTS_INTO_CALL',
              audioData: bytes.buffer
            }, '*');
            console.log('[MeetTranslate AI] ✅ Audio TTS inyectado en la llamada WebRTC');
          }
        }
      );
    } catch (e) {
      console.warn('[MeetTranslate AI] No se pudo enviar TTS a la llamada:', e);
    }
  }

  /**
   * Muestra una alerta rápida en caso de error.
   */
  function showErrorToast(errorText) {
    if (!overlayElement) return;
    const elTranslated = overlayElement.querySelector('#mt-translated');
    if (elTranslated) {
      elTranslated.textContent = `⚠️ Error: ${errorText}`;
      elTranslated.style.color = '#fca5a5';
    }
  }

  /**
   * Elimina completamente el elemento del DOM al desactivar.
   */
  function removeOverlay() {
    // Restaurar micrófono original al desactivar
    window.postMessage({ type: 'MT_SET_MIC_MUTE', muted: false }, '*');
    ttsEnabled = false;

    const container = document.getElementById(OVERLAY_ID);
    if (container) {
      container.remove();
    }
    overlayElement = null;
  }

  // Verificar si la traducción ya está activa al inyectar el content script
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.isActive) {
      createOrShowOverlay(response.settings);
    }
  });

})();
