/**
 * popup.js - Lógica del Panel de Control de la Extensión
 * Responsabilidades:
 * 1. Cargar y reflejar el estado actual de la extensión y su configuración.
 * 2. Enviar comandos de encendido/apagado al Service Worker.
 * 3. Actualizar dinámicamente parámetros (idioma, motor, fuente, endpoint Ollama).
 */

document.addEventListener('DOMContentLoaded', async () => {
  const toggleActive = document.getElementById('toggle-active');
  const sourceLangSelect = document.getElementById('source-lang');
  const targetLangSelect = document.getElementById('target-lang');
  const engineSelect = document.getElementById('engine-select');
  const ollamaGroup = document.getElementById('ollama-group');
  const ollamaEndpointInput = document.getElementById('ollama-endpoint');
  const sttEngineSelect = document.getElementById('stt-engine-select');
  const groqKeyGroup = document.getElementById('groq-key-group');
  const groqApiKeyInput = document.getElementById('groq-api-key');
  const whisperEndpointGroup = document.getElementById('whisper-endpoint-group');
  const whisperEndpointInput = document.getElementById('whisper-endpoint');
  const fontSizeRange = document.getElementById('font-size-range');
  const fontSizeVal = document.getElementById('font-size-val');
  const opacityRange = document.getElementById('opacity-range');
  const opacityVal = document.getElementById('opacity-val');
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');

  const btnRequestPerm = document.getElementById('btn-request-perm');

  /**
   * Comprueba si el usuario ya concedió acceso al micrófono y muestra u oculta el banner.
   */
  async function checkMicrophonePermission() {
    const { micPermissionGranted = false } = await chrome.storage.local.get('micPermissionGranted');
    const permBanner = document.getElementById('perm-banner');

    if (micPermissionGranted) {
      if (permBanner) permBanner.style.display = 'none';
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      await chrome.storage.local.set({ micPermissionGranted: true });
      if (permBanner) permBanner.style.display = 'none';
      return true;
    } catch (err) {
      if (permBanner) permBanner.style.display = 'flex';
      return false;
    }
  }

  if (btnRequestPerm) {
    btnRequestPerm.addEventListener('click', () => {
      // Chrome bloquea solicitudes de micrófono dentro de ventanas emergentes (popup).
      // Abrimos la pestaña dedicada permissions.html que despliega el diálogo nativo de Chrome.
      chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html') });
    });
  }

  /**
   * Cargar el estado actual de la extensión desde el Service Worker
   */
  async function loadInitialState() {
    await checkMicrophonePermission();
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          console.warn('[MeetTranslate AI Popup] No se pudo obtener respuesta del Service Worker.');
          return;
        }

        const { isActive, settings } = response;

        // Actualizar Toggle y estado
        toggleActive.checked = !!isActive;
        updateStatusUI(!!isActive);

        if (settings) {
          sourceLangSelect.value = settings.sourceLang || 'es-ES';
          targetLangSelect.value = settings.targetLang || 'en';
          sttEngineSelect.value = settings.sttEngine || 'webspeech';
          groqApiKeyInput.value = settings.groqApiKey || '';
          whisperEndpointInput.value = settings.whisperEndpoint || 'http://localhost:8000';
          engineSelect.value = settings.engine || 'fast';
          ollamaEndpointInput.value = settings.ollamaEndpoint || 'http://localhost:11434';
          fontSizeRange.value = settings.fontSize || 18;
          fontSizeVal.textContent = `${fontSizeRange.value}px`;

          const opVal = settings.bgOpacity !== undefined ? settings.bgOpacity : 0.25;
          opacityRange.value = opVal;
          opacityVal.textContent = `${Math.round(opVal * 100)}%`;

          toggleOllamaVisibility(engineSelect.value);
          toggleSttVisibility(sttEngineSelect.value);
        }
      });
    } catch (err) {
      console.error('[MeetTranslate AI Popup] Error cargando estado inicial:', err);
    }
  }

  /**
   * Actualiza el pill visual de estado (LIVE / OFF)
   */
  function updateStatusUI(isActive) {
    if (isActive) {
      statusPill.classList.add('active');
      statusText.textContent = 'LIVE';
    } else {
      statusPill.classList.remove('active');
      statusText.textContent = 'OFF';
    }
  }

  /**
   * Muestra u oculta la entrada para el endpoint de Ollama según el motor
   */
  function toggleOllamaVisibility(engine) {
    if (engine === 'gemma') {
      ollamaGroup.style.display = 'block';
    } else {
      ollamaGroup.style.display = 'none';
    }
  }

  /**
   * Muestra u oculta las entradas de API Key / Endpoint de STT según el motor elegido
   */
  function toggleSttVisibility(sttEngine) {
    groqKeyGroup.style.display = (sttEngine === 'whisper_groq') ? 'block' : 'none';
    whisperEndpointGroup.style.display = (sttEngine === 'whisper_local') ? 'block' : 'none';
  }

  /**
   * Envía la nueva configuración al Service Worker
   */
  function saveSettings() {
    const settings = {
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      sttEngine: sttEngineSelect.value,
      groqApiKey: groqApiKeyInput.value.trim(),
      whisperEndpoint: whisperEndpointInput.value.trim(),
      engine: engineSelect.value,
      ollamaEndpoint: ollamaEndpointInput.value.trim(),
      fontSize: parseInt(fontSizeRange.value, 10),
      bgOpacity: parseFloat(opacityRange.value)
    };

    chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      settings
    }).catch(err => {
      console.warn('[MeetTranslate AI Popup] Error guardando settings:', err);
    });
  }

  /* ==========================================================================
     EVENTOS DE INTERACCIÓN DE USUARIO
     ========================================================================== */

  // Toggle Activar / Desactivar
  toggleActive.addEventListener('change', async () => {
    const active = toggleActive.checked;
    updateStatusUI(active);

    // Obtener la pestaña activa actual en la ventana
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = currentTab ? currentTab.id : null;

    chrome.runtime.sendMessage({
      type: 'TOGGLE_TRANSLATION',
      active,
      tabId
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[MeetTranslate AI Popup] Error al togglear traducción:', chrome.runtime.lastError);
        toggleActive.checked = !active;
        updateStatusUI(!active);
      }
    });
  });

  // Cambio de Idioma Origen
  sourceLangSelect.addEventListener('change', () => {
    // Ajustar automáticamente el idioma destino sugerido
    if (sourceLangSelect.value === 'es-ES') {
      targetLangSelect.value = 'en';
    } else if (sourceLangSelect.value === 'en-US') {
      targetLangSelect.value = 'es';
    } else if (sourceLangSelect.value === 'auto') {
      targetLangSelect.value = 'auto';
    }
    saveSettings();
  });

  // Cambio de Idioma Destino
  targetLangSelect.addEventListener('change', () => {
    saveSettings();
  });

  // Cambio de Motor STT
  sttEngineSelect.addEventListener('change', () => {
    toggleSttVisibility(sttEngineSelect.value);
    saveSettings();
  });

  // Cambio de Groq API Key
  groqApiKeyInput.addEventListener('change', () => {
    saveSettings();
  });

  // Cambio de Whisper Endpoint
  whisperEndpointInput.addEventListener('change', () => {
    saveSettings();
  });

  // Cambio de Motor de Traducción
  engineSelect.addEventListener('change', () => {
    toggleOllamaVisibility(engineSelect.value);
    saveSettings();
  });

  // Cambio de Endpoint Ollama
  ollamaEndpointInput.addEventListener('change', () => {
    saveSettings();
  });

  // Slider de Tamaño de Fuente
  fontSizeRange.addEventListener('input', () => {
    fontSizeVal.textContent = `${fontSizeRange.value}px`;
    saveSettings();
  });

  // Slider de Opacidad del Fondo
  opacityRange.addEventListener('input', () => {
    opacityVal.textContent = `${Math.round(parseFloat(opacityRange.value) * 100)}%`;
    saveSettings();
  });

  /* ==========================================================================
     PROBADOR INTERACTIVO DE MICRÓFONO Y PARLANTES (SANDBOX)
     ========================================================================== */
  const btnTestMic = document.getElementById('btn-test-mic');
  const testBtnLabel = document.getElementById('test-btn-label');
  const testResults = document.getElementById('test-results');
  const testOriginal = document.getElementById('test-original');
  const testTranslated = document.getElementById('test-translated');

  let testRecognition = null;
  let isTesting = false;

  if (btnTestMic) {
    btnTestMic.addEventListener('click', () => {
      if (isTesting) {
        stopTest();
      } else {
        startTest();
      }
    });
  }

  function startTest() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Tu navegador no soporta reconocimiento directo de voz en la ventana flotante.');
      return;
    }

    testRecognition = new SpeechRecognition();
    testRecognition.continuous = false;
    testRecognition.interimResults = true;

    // Idioma origen seleccionado
    let srcLang = sourceLangSelect.value;
    if (srcLang === 'auto') srcLang = 'es-ES';
    testRecognition.lang = srcLang;

    testRecognition.onstart = () => {
      isTesting = true;
      btnTestMic.classList.add('listening');
      testBtnLabel.textContent = '🔴 Detener (Habla por tu mic...)';
      testResults.style.display = 'block';
      testOriginal.textContent = 'Escuchando tu voz...';
      testTranslated.textContent = 'Traduciendo...';
    };

    testRecognition.onresult = async (event) => {
      let transcript = '';
      let isFinal = false;

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) isFinal = true;
      }

      if (transcript.trim()) {
        testOriginal.textContent = transcript;

        const src = srcLang.substring(0, 2);
        let tgt = targetLangSelect.value;
        if (tgt === 'auto') tgt = (src === 'es' ? 'en' : 'es');
        else tgt = tgt.substring(0, 2);

        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(transcript)}`;
          const response = await fetch(url);
          const data = await response.json();
          let translatedText = transcript;
          if (data && Array.isArray(data[0])) {
            translatedText = data[0].map(c => c[0]).filter(Boolean).join('');
          }

          testTranslated.textContent = translatedText;

          // Reproducir por parlantes al ser frase final
          if (isFinal) {
            speakTestTranslation(translatedText, tgt);
          }
        } catch (e) {
          console.error('Error traduciendo prueba:', e);
        }
      }
    };

    testRecognition.onerror = (e) => {
      console.warn('Error en prueba de voz:', e.error);
      if (e.error === 'not-allowed') {
        alert('Por favor concede acceso a tu micrófono en Chrome para probar.');
      }
      stopTest();
    };

    testRecognition.onend = () => {
      stopTest();
    };

    try {
      testRecognition.start();
    } catch (e) {
      stopTest();
    }
  }

  function stopTest() {
    isTesting = false;
    if (btnTestMic) btnTestMic.classList.remove('listening');
    if (testBtnLabel) testBtnLabel.textContent = '🎙️ Iniciar Prueba de Voz';
    if (testRecognition) {
      try {
        testRecognition.onend = null;
        testRecognition.stop();
      } catch (e) {}
      testRecognition = null;
    }
  }

  function speakTestTranslation(text, targetLang) {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = targetLang === 'es' ? 'es-ES' : 'en-US';
      utterance.rate = 1.0;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (e) {}
  }

  // Carga inicial
  await loadInitialState();
});
