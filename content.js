/**
 * content.js - Interfaz de Subtítulos Flotantes inyectada en Meet/Zoom/Teams
 * Responsabilidades:
 * 1. Creación e inyección limpia del overlay UI Glassmorphism en la página.
 * 2. Soporte completo de arrastre (drag & drop) y restricciones de viewport.
 * 3. Persistencia de coordenadas de pantalla y preferencias visuales (tamaño de fuente).
 * 4. Actualización en tiempo real de subtítulos transcritos y traducidos.
 * 5. Enrutamiento del audio TTS según la dirección de la conversación:
 *      - 'outgoing' (yo hablo en español) ➔ inglés inyectado en WebRTC al receptor.
 *      - 'incoming' (el receptor habla en inglés) ➔ español SOLO en mis parlantes.
 * 6. Herramientas de diagnóstico del camino de audio WebRTC (tono de prueba + reporte).
 *
 * NOTA: audio-mixer.js se carga UNA sola vez, desde el manifest, en el MAIN world
 * a document_start. No debe inyectarse también desde aquí: dos instancias anidan
 * dos mixers y el micGain=0.0 del mixer exterior silencia el TTS del interior.
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

  let ttsEnabled = false;
  let activeTargetLang = 'en';
  let lastSpokenText = '';

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
        updateSubtitleText(
          message.originalText,
          message.translatedText,
          message.isFinal,
          message.direction || 'outgoing'
        );
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

  // Escuchar al mixer (MAIN world) una sola vez, exista o no el overlay
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'MT_MIXER_STATUS_UPDATE') {
      updateMixerStatusIndicator(event.data.status);
    }

    if (event.data.type === 'MT_MIXER_DIAG_RESULT') {
      renderDiagnosticReport(event.data.report);
    }
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
              <button type="button" class="mt-btn-icon" id="mt-btn-tone" title="Tono de prueba: el receptor debe oír un beep de 1 segundo">🧪</button>
              <button type="button" class="mt-btn-icon" id="mt-btn-diag" title="Diagnóstico del camino de audio WebRTC">🩺</button>
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
    }

    container.classList.remove('mt-hidden');

    // Cargar configuración de fuente y posición previa
    if (settings) {
      applySettings(settings);
    }

    // Sincronizar el estado de silenciamiento con el mixer
    window.postMessage({
      type: 'MT_SET_MIC_MUTE',
      muted: ttsEnabled
    }, '*');
  }

  // Vigilancia: mantener el silenciamiento del español mientras TTS está encendido.
  // (El mixer ignora los mensajes que no cambian el estado, así que no genera ruido.)
  setInterval(() => {
    if (overlayElement && !overlayElement.classList.contains('mt-hidden') && ttsEnabled) {
      window.postMessage({
        type: 'MT_SET_MIC_MUTE',
        muted: true
      }, '*');
    }
  }, 2500);

  /**
   * Actualiza el indicador visual del estado del mixer en la cabecera del overlay.
   */
  function updateMixerStatusIndicator(status) {
    const el = document.getElementById('mt-mixer-status');
    if (!el) return;

    const statusMap = {
      'MIXER_READY':              '🟡',
      'VIRTUAL_STREAM_DELIVERED': '🟢',
      'VIRTUAL_STREAM_FAILED':    '🔴',
      'TRACK_REPLACED':           '🟢',
      'MIC_MUTED':                '🔇',
      'MIC_UNMUTED':              '🎙️',
      'TTS_PLAYING':              '🔊',
      'TTS_FAILED':               '🔴',
      'TTS_ERROR':                '🔴',
      'SELFTEST_TONE':            '🧪'
    };

    el.textContent = statusMap[status] || '⏳';
    el.title = `Mixer: ${status}`;
  }

  /**
   * Vuelca en consola y en el overlay el estado real del camino de audio WebRTC.
   */
  function renderDiagnosticReport(report) {
    console.log('%c[MeetTranslate AI] DIAGNÓSTICO DEL CAMINO DE AUDIO', 'font-weight:bold;color:#10B981');
    console.table({
      'AudioContext': report.audioContext,
      'Track del mixer': report.mixerTrack ? report.mixerTrack.readyState : 'INEXISTENTE',
      'Micrófono físico': report.microfonoFisico || 'no conectado',
      'micGain (voz española)': report.micGain,
      'ttsGain (voz inglesa)': report.ttsGain,
      'Nivel de audio actual': report.nivelActual + '%',
      'PeerConnections': report.peerConnections,
      'Senders de audio': report.sendersDeAudio,
      'Senders con nuestro mixer': report.sendersConNuestroMixer,
      'Senders habilitados': report.sendersHabilitados,
      'Meet muteado': report.meetMuteado
    });
    console.log('Contadores del mixer:', report.contadores);

    let veredicto;
    if (!report.mixerTrack) {
      veredicto = '🔴 El mixer no tiene track. audio-mixer.js no llegó a construirse.';
    } else if (report.sendersDeAudio === 0) {
      veredicto = '🔴 La llamada no tiene ningún sender de audio todavía. ¿Ya entraste a la reunión?';
    } else if (report.sendersConNuestroMixer === 0) {
      veredicto = '🔴 Hay senders de audio pero NINGUNO lleva nuestro mixer. Meet nos sacó del camino WebRTC.';
    } else if (report.meetMuteado) {
      veredicto = '🟠 El mixer está en el sender, pero Meet tiene tu micrófono MUTEADO. Actívalo en Meet: el receptor no oirá nada mientras esté en mute.';
    } else {
      veredicto = '🟢 El mixer está conectado y habilitado en ' + report.sendersConNuestroMixer +
        ' sender(s). Si el receptor no oye nada, prueba el tono 🧪.';
    }

    console.log('%c' + veredicto, 'font-weight:bold');

    const elTranslated = overlayElement && overlayElement.querySelector('#mt-translated');
    if (elTranslated) {
      elTranslated.textContent = veredicto;
    }
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

  /**
   * Configura los botones de control de la cabecera.
   */
  function setupButtonEvents(container) {
    const btnTts = container.querySelector('#mt-btn-tts');
    const btnTone = container.querySelector('#mt-btn-tone');
    const btnDiag = container.querySelector('#mt-btn-diag');
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

    if (btnTone) {
      btnTone.addEventListener('click', () => {
        window.postMessage({ type: 'MT_MIXER_SELFTEST' }, '*');
        const elTranslated = container.querySelector('#mt-translated');
        if (elTranslated) {
          elTranslated.textContent = '🧪 Beep enviado. Pregúntale al receptor si lo escuchó.';
        }
      });
    }

    if (btnDiag) {
      btnDiag.addEventListener('click', () => {
        window.postMessage({ type: 'MT_MIXER_DIAG' }, '*');
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
   * Actualiza los subtítulos y enruta el audio según la dirección.
   */
  function updateSubtitleText(originalText, translatedText, isFinal, direction) {
    if (!overlayElement) return;

    const elOriginal = overlayElement.querySelector('#mt-original');
    const elTranslated = overlayElement.querySelector('#mt-translated');

    if (elOriginal && originalText) {
      elOriginal.textContent = (direction === 'incoming' ? '👤 ' : '🎙️ ') + originalText;
    }

    if (!elTranslated || !translatedText || !translatedText.trim()) return;
    elTranslated.textContent = translatedText;

    if (!isFinal) return;

    if (direction === 'incoming') {
      // El receptor habló en inglés ➔ su traducción al español suena SOLO en
      // mis parlantes. Nunca se inyecta de vuelta en la llamada.
      speakLocally(translatedText, 'es');
      return;
    }

    // Yo hablé en español ➔ la traducción en inglés viaja al receptor
    if (ttsEnabled) {
      speakTranslation(translatedText, activeTargetLang);
    }
  }

  /**
   * Reproduce texto por los parlantes locales (no toca la llamada).
   */
  function speakLocally(text, lang) {
    try {
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang === 'es' ? 'es-ES' : 'en-US';
      utterance.rate = 0.95;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[MeetTranslate AI] Error en TTS local:', e);
    }
  }

  /**
   * Traducción hablada hacia el PARTICIPANTE REMOTO.
   * Ruta: content.js → background.js (fetch sin CORS, fragmentado) → content.js
   *       → postMessage → audio-mixer.js (MAIN) → ttsGain → WebRTC.
   *
   * Los fragmentos se envían en UNA sola lista para que el mixer los agende
   * secuencialmente por duración. Enviarlos con offsets fijos los solapaba y
   * el receptor escuchaba varias voces encimadas.
   */
  async function speakTranslation(text, targetLang) {
    if (!text || text === lastSpokenText) return;
    lastSpokenText = text;

    const lang = targetLang ? targetLang.substring(0, 2) : 'en';

    // 1. Reproducción LOCAL para el usuario (confirmación por sus parlantes)
    speakLocally(text, lang);

    // 2. Transmisión REMOTA al otro participante vía WebRTC mixer
    try {
      chrome.runtime.sendMessage(
        { type: 'FETCH_TTS_AUDIO', text: text.trim(), lang: lang },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[MeetTranslate AI] ❌ FETCH_TTS_AUDIO falló:', chrome.runtime.lastError.message);
            updateMixerStatusIndicator('TTS_FAILED');
            return;
          }

          if (!response || !response.success) {
            const reason = response ? response.error : 'sin respuesta del service worker';
            console.warn('[MeetTranslate AI] ❌ No se descargó audio TTS:', reason);
            updateMixerStatusIndicator('TTS_FAILED');
            return;
          }

          const list = response.audioBase64List || (response.audioBase64 ? [response.audioBase64] : []);
          const buffers = [];

          for (const base64Str of list) {
            try {
              const binaryStr = atob(base64Str);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              buffers.push(bytes.buffer);
            } catch (e) {
              console.warn('[MeetTranslate AI] Fragmento TTS corrupto, se descarta:', e);
            }
          }

          if (buffers.length === 0) {
            console.warn('[MeetTranslate AI] ❌ Ningún fragmento TTS pudo decodificarse a ArrayBuffer');
            updateMixerStatusIndicator('TTS_FAILED');
            return;
          }

          window.postMessage({
            type: 'MT_PLAY_TTS_INTO_CALL',
            audioDataList: buffers
          }, '*');

          console.log('[MeetTranslate AI] ✅ ' + buffers.length +
            ' fragmento(s) TTS enviados al mixer WebRTC (' +
            buffers.reduce((n, b) => n + b.byteLength, 0) + ' bytes)');
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
