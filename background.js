/**
 * background.js - Service Worker principal de MeetTranslate AI (Manifest V3)
 * Responsabilidades:
 * 1. Administración del ciclo de vida del Offscreen Document para procesamiento audio/STT.
 * 2. Bloqueo de concurrencia de captura mediante máquina de estados en storage.session.
 * 3. Enrutamiento de mensajes entre Popup, Offscreen Document y Content Scripts en la pestaña activa.
 */

// Valores por defecto de la extensión
const DEFAULT_SETTINGS = {
  active: false,
  sourceLang: 'es-ES',     // Idioma origen por defecto: Español ('es-ES', 'en-US' o 'auto')
  targetLang: 'en',        // Idioma destino por defecto: Inglés ('en', 'es' o 'auto')
  sttEngine: 'webspeech',  // Motor STT por defecto: Web Speech API (sin necesidad de API Keys)
  groqApiKey: '',
  openaiApiKey: '',
  whisperEndpoint: 'http://localhost:8000',
  engine: 'fast',          // Motor de traducción: Google Translate GTX ultrarrápido
  ollamaEndpoint: 'http://localhost:11434', // Endpoint local para TranslateGemma / vLLM
  fontSize: 18,            // Tamaño de fuente del overlay en px
  bgOpacity: 0.25,         // Translucidez de fondo (25%)
  position: { top: 100, left: 100 }, // Posición guardada del overlay
  glossary: {
    // SharePoint & Microsoft 365
    'cherpoy': 'SharePoint',
    'sharepo': 'SharePoint',
    'sharepoin': 'SharePoint',
    'charpon': 'SharePoint',
    'es pe fx': 'SPFx',
    'ese pe ef equis': 'SPFx',
    'spfx': 'SPFx',
    'power autonat': 'Power Automate',
    'power automate': 'Power Automate',
    'power aps': 'Power Apps',
    'power ap': 'Power Apps',
    'power bi': 'Power BI',
    'power vi': 'Power BI',
    'tean': 'Teams',
    'tins': 'Teams',
    'site column': 'Site Column',
    'content type': 'Content Type',
    'webpart': 'Web Part',
    'web part': 'Web Part',
    'pe en pe': 'PnP',
    'pnpjs': 'PnPjs',
    'graf api': 'Microsoft Graph API',
    'entra id': 'Entra ID',
    'tenant': 'Tenant',

    // Frontend & Frameworks
    'real': 'React',
    'riac': 'React',
    'riact': 'React',
    'yabascrip': 'JavaScript',
    'llabascript': 'JavaScript',
    'taitscrip': 'TypeScript',
    'taipscrip': 'TypeScript',
    'fluter': 'Flutter',
    'nod': 'Node.js',
    'nodo': 'Node.js',
    'node': 'Node.js',
    'nes j s': 'Next.js',
    'nextjs': 'Next.js',
    'vats': 'Vite',
    'vait': 'Vite',
    'angular': 'Angular',
    'yeison': 'JSON',
    'jason': 'JSON',
    'res api': 'REST API',

    // Cloud & DevOps
    'doker': 'Docker',
    'doquer': 'Docker',
    'piton': 'Python',
    'paiton': 'Python',
    'a doble u ese': 'AWS',
    'a doble v ese': 'AWS',
    'asur': 'Azure',
    'gihub': 'GitHub',
    'llithub': 'GitHub',
    'kubernets': 'Kubernetes',
    'guberne': 'Kubernetes',
    'paip lain': 'Pipeline',
    'paiplain': 'Pipeline'
  }
};

// Nombre del archivo Offscreen
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

/**
 * Inicialización al instalar o actualizar la extensión.
 */
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    console.log('[MeetTranslate AI SW] Configuración inicial guardada:', DEFAULT_SETTINGS);
  }
  // Limpiar estado de captura activo
  await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
});

/**
 * Asegura la existencia del Offscreen Document (solo 1 permitido por la especificación V3).
 */
async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  console.log('[MeetTranslate AI SW] Creando Offscreen Document...');
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.AUDIO_PLAYBACK
    ],
    justification: 'Procesamiento de stream de audio de pestaña para transcripción y traducción en tiempo real'
  });
  console.log('[MeetTranslate AI SW] Offscreen Document creado exitosamente.');
}

/**
 * Verifica si el documento Offscreen ya se encuentra activo.
 */
async function hasOffscreenDocument() {
  if ('hasDocument' in chrome.offscreen) {
    return await chrome.offscreen.hasDocument();
  }
  // Fallback para versiones previas de la API
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });
  return contexts.length > 0;
}

/**
 * Cierra el Offscreen Document si existe.
 */
async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    console.log('[MeetTranslate AI SW] Cerrando Offscreen Document...');
    await chrome.offscreen.closeDocument();
  }
}

/**
 * Inicia la captura de audio y flujo de traducción en la pestaña actual.
 */
async function startTranslationFlow(tabId) {
  const { captureState = 'idle' } = await chrome.storage.session.get('captureState');

  // Bloqueo contra clics dobles o ejecuciones concurrentes
  if (captureState === 'starting' || captureState === 'capturing') {
    console.warn('[MeetTranslate AI SW] Intento de inicio ignorado: estado actual es', captureState);
    return;
  }

  await chrome.storage.session.set({ captureState: 'starting' });

  try {
    // 1. Obtener streamId mediante tabCapture
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (!streamId) {
      throw new Error('No se pudo obtener el streamId del audio de la pestaña.');
    }

    // 2. Garantizar que el documento Offscreen esté listo
    await setupOffscreenDocument();

    // 3. Cargar configuración actual
    const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get('settings');

    // 4. Guardar tabId activo en session storage
    await chrome.storage.session.set({ activeTabId: tabId });

    // 5. Enviar mensaje de inicio de captura al Offscreen Document
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START_CAPTURE',
      streamId,
      settings
    });

    // 6. Notificar al Content Script para mostrar el overlay UI
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_OVERLAY',
      settings
    }).catch(err => {
      console.warn('[MeetTranslate AI SW] Error notificando a content script (posible recarga):', err);
    });

    // 7. Actualizar badge a modo activo LIVE
    await chrome.action.setBadgeText({ text: 'LIVE' });
    await chrome.action.setBadgeBackgroundColor({ color: '#10B981' });

    await chrome.storage.session.set({ captureState: 'capturing' });
    console.log('[MeetTranslate AI SW] Captura y traducción iniciadas en tab:', tabId);

  } catch (error) {
    console.error('[MeetTranslate AI SW] Error al iniciar flujo de traducción:', error);
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    await chrome.action.setBadgeText({ text: 'ERR' });
    await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });

    // Notificar error a la pestaña si es posible
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'TRANSLATION_ERROR',
        error: error.message || 'No se pudo capturar el audio de la reunión.'
      }).catch(() => {});
    }
  }
}

/**
 * Detiene la captura de audio y remueve el overlay UI.
 */
async function stopTranslationFlow() {
  const { captureState = 'idle', activeTabId } = await chrome.storage.session.get(['captureState', 'activeTabId']);

  if (captureState === 'stopping' || captureState === 'idle') {
    return;
  }

  await chrome.storage.session.set({ captureState: 'stopping' });

  try {
    // 1. Enviar orden de parada al Offscreen si existe
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'STOP_CAPTURE'
      }).catch(() => {});
    }

    // 2. Cerrar Offscreen Document para liberar recursos completamente
    await closeOffscreenDocument();

    // 3. Notificar al Content Script para ocultar y limpiar el DOM
    if (activeTabId) {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'HIDE_OVERLAY'
      }).catch(() => {});
    }

    // 4. Resetear badge
    await chrome.action.setBadgeText({ text: '' });

  } catch (error) {
    console.error('[MeetTranslate AI SW] Error al detener la traducción:', error);
  } finally {
    await chrome.storage.session.set({ captureState: 'idle', activeTabId: null });
    console.log('[MeetTranslate AI SW] Traducción detenida exitosamente.');
  }
}

/**
 * Manejo central de mensajes entre Popup, Offscreen y Content Scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ejecutar función asíncrona dentro del listener
  (async () => {
    try {
      const { type } = message;

      switch (type) {
        case 'GET_STATUS': {
          const { captureState = 'idle', activeTabId } = await chrome.storage.session.get(['captureState', 'activeTabId']);
          const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get('settings');
          sendResponse({
            isActive: captureState === 'capturing',
            captureState,
            activeTabId,
            settings
          });
          break;
        }

        case 'TOGGLE_TRANSLATION': {
          const { active, tabId } = message;
          const targetTabId = tabId || (sender.tab ? sender.tab.id : null);

          // Actualizar estado en settings
          const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get('settings');
          settings.active = active;
          await chrome.storage.local.set({ settings });

          if (active) {
            if (!targetTabId) {
              const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (currentTab) await startTranslationFlow(currentTab.id);
            } else {
              await startTranslationFlow(targetTabId);
            }
          } else {
            await stopTranslationFlow();
          }
          sendResponse({ success: true, active: settings.active });
          break;
        }

        case 'UPDATE_SETTINGS': {
          const { settings: newSettings } = message;
          const { settings: currentSettings = DEFAULT_SETTINGS } = await chrome.storage.local.get('settings');
          const merged = { ...currentSettings, ...newSettings };
          await chrome.storage.local.set({ settings: merged });

          // Notificar a Offscreen si está capturando
          if (await hasOffscreenDocument()) {
            chrome.runtime.sendMessage({
              target: 'offscreen',
              type: 'SETTINGS_CHANGED',
              settings: merged
            }).catch(() => {});
          }

          // Notificar a Content Script en la pestaña activa
          const { activeTabId } = await chrome.storage.session.get('activeTabId');
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, {
              type: 'SETTINGS_CHANGED',
              settings: merged
            }).catch(() => {});
          }

          sendResponse({ success: true, settings: merged });
          break;
        }

        case 'TRANSLATION_RESULT': {
          // Mensaje enviado desde offscreen.js con el texto transcrito y traducido
          const { activeTabId } = await chrome.storage.session.get('activeTabId');
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, {
              type: 'DISPLAY_SUBTITLE',
              originalText: message.originalText,
              translatedText: message.translatedText,
              isFinal: message.isFinal
            }).catch(() => {});
          }
          break;
        }

        case 'OFFSCREEN_ERROR': {
          console.error('[MeetTranslate AI SW] Error reportado por Offscreen:', message.error);
          await stopTranslationFlow();
          sendResponse({ acknowledged: true });
          break;
        }

        case 'FETCH_TTS_AUDIO': {
          // El content script NO puede hacer fetch cross-origin a translate.google.com
          // por restricciones CORS de la página. El Service Worker SÍ puede.
          try {
            const { text, lang } = message;

            // Fragmentar texto largo en trozos de máximo 140 caracteres para evitar HTTP 400 en Google TTS
            const words = (text || '').split(' ');
            const chunks = [];
            let cur = '';
            for (const w of words) {
              if ((cur + ' ' + w).trim().length <= 140) {
                cur = (cur + ' ' + w).trim();
              } else {
                if (cur) chunks.push(cur);
                cur = w;
              }
            }
            if (cur) chunks.push(cur);

            const audioBase64List = [];

            for (const chunk of chunks) {
              const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&client=tw-ob`;
              const response = await fetch(ttsUrl);

              if (response.ok) {
                const arrayBuffer = await response.arrayBuffer();
                const bytes = new Uint8Array(arrayBuffer);
                let binary = '';
                for (let i = 0; i < bytes.byteLength; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                audioBase64List.push(btoa(binary));
              } else {
                console.warn('[MeetTranslate AI SW] HTTP ' + response.status + ' descargando chunk TTS:', chunk);
              }
            }

            if (audioBase64List.length > 0) {
              sendResponse({ success: true, audioBase64List });
              console.log('[MeetTranslate AI SW] ' + audioBase64List.length + ' fragmentos de TTS MP3 descargados con éxito.');
            } else {
              sendResponse({ success: false, error: 'No se pudo descargar ningún fragmento de audio' });
            }
          } catch (err) {
            console.warn('[MeetTranslate AI SW] Error descargando TTS audio:', err);
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[MeetTranslate AI SW] Error procesando mensaje:', err);
    }
  })();

  // Retornar true para mantener abierto el canal de respuesta asíncrona
  return true;
});
