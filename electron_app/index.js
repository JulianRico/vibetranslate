/**
 * index.js - Lógica del Renderer para la Ventana Principal de Control
 */

const { ipcRenderer } = require('electron');
const GeminiLiveClient = require('./gemini-live-client');
const { floatTo16BitPCM, resampleTo16kHZ, arrayBufferToBase64 } = require('./audio-utils');

document.addEventListener('DOMContentLoaded', async () => {
  const toggleActive = document.getElementById('toggle-active');
  const liveBadge = document.getElementById('live-badge');
  const statusText = document.getElementById('status-text');

  const sourceLangSelect = document.getElementById('source-lang');
  const targetLangSelect = document.getElementById('target-lang');
  const sttEngineSelect = document.getElementById('stt-engine');

  const geminiKeyGroup = document.getElementById('gemini-key-group');
  const geminiKeyInput = document.getElementById('gemini-key');
  const geminiVoiceGroup = document.getElementById('gemini-voice-group');
  const geminiVoiceSelect = document.getElementById('gemini-voice');

  const groqKeyGroup = document.getElementById('groq-key-group');
  const groqKeyInput = document.getElementById('groq-key');

  const micInputSelect = document.getElementById('mic-input-select');
  const virtualCableSelect = document.getElementById('virtual-cable-select');

  const btnTestMic = document.getElementById('btn-test-mic');
  const previewBox = document.getElementById('preview-box');
  const previewOrig = document.getElementById('preview-orig');
  const previewTrans = document.getElementById('preview-trans');

  const logContainer = document.getElementById('log-container');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnOpenDevTools = document.getElementById('btn-open-devtools');

  const platformBtns = document.querySelectorAll('.platform-btn');

  let speechRecognizer = null;
  let isListeningTest = false;
  let geminiLiveClient = null;

  // ── Sistema de Logs en Pantalla ───────────────────────────────────
  function appendLog(category, message, type = 'system') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;

    // Reenviar al archivo en disco a través del proceso principal
    ipcRenderer.send('LOG_CLIENT_EVENT', { category, message, type });
  }

  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      logContainer.innerHTML = '<div class="log-entry system">[SISTEMA] Consola limpiada por el usuario.</div>';
    });
  }

  if (btnOpenDevTools) {
    btnOpenDevTools.addEventListener('click', () => {
      appendLog('DEVTOOLS', 'Solicitando apertura de Chromium Developer Tools...');
      ipcRenderer.send('OPEN_DEVTOOLS');
    });
  }

  // ── Cargar Configuración Inicial ──────────────────────────────────
  appendLog('CONFIG', 'Cargando preferencias del usuario...');
  const settings = await ipcRenderer.invoke('GET_SETTINGS');
  applySettingsToUI(settings);
  await enumerateAudioDevices();

  // ── Event Listeners de UI ─────────────────────────────────────────
  toggleActive.addEventListener('change', async () => {
    const isActive = toggleActive.checked;
    updateStatusBadge(isActive);
    appendLog('CONTROL', `Traducción en vivo ${isActive ? 'ACTIVADA 🟢' : 'DESACTIVADA ⚪'}`);
    await saveCurrentSettings();
    ipcRenderer.send('TOGGLE_OVERLAY', isActive);
  });

  sttEngineSelect.addEventListener('change', () => {
    updateEngineGroupsVisibility();
    appendLog('ENGINE', `Motor STT cambiado a: ${sttEngineSelect.value}`);
    saveCurrentSettings();
  });

  [sourceLangSelect, targetLangSelect, geminiKeyInput, geminiVoiceSelect, groqKeyInput, micInputSelect, virtualCableSelect].forEach(el => {
    el.addEventListener('change', saveCurrentSettings);
    if (el.tagName === 'INPUT') el.addEventListener('input', saveCurrentSettings);
  });

  platformBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      platformBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const platform = btn.getAttribute('data-platform');
      appendLog('PLATFORM', `Plataforma seleccionada: ${platform.toUpperCase()}`);
    });
  });

  // ── Probador de Micrófono y Traducción ─────────────────────────────
  btnTestMic.addEventListener('click', async () => {
    if (isListeningTest) {
      stopTest();
    } else {
      await startTest();
    }
  });

  function updateEngineGroupsVisibility() {
    const engine = sttEngineSelect.value;
    geminiKeyGroup.style.display = (engine === 'gemini_live') ? 'flex' : 'none';
    geminiVoiceGroup.style.display = (engine === 'gemini_live') ? 'flex' : 'none';
    groqKeyGroup.style.display = (engine === 'whisper_groq') ? 'flex' : 'none';
  }

  function applySettingsToUI(s) {
    toggleActive.checked = !!s.active;
    updateStatusBadge(!!s.active);
    sourceLangSelect.value = s.sourceLang || 'es-ES';
    targetLangSelect.value = s.targetLang || 'en';
    sttEngineSelect.value = s.sttEngine || 'webspeech';
    geminiKeyInput.value = s.geminiApiKey || '';
    geminiVoiceSelect.value = s.geminiVoice || 'Puck';
    groqKeyInput.value = s.groqApiKey || '';

    updateEngineGroupsVisibility();
  }

  async function saveCurrentSettings() {
    const newSettings = {
      active: toggleActive.checked,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      sttEngine: sttEngineSelect.value,
      geminiApiKey: geminiKeyInput.value.trim(),
      geminiVoice: geminiVoiceSelect.value,
      groqApiKey: groqKeyInput.value.trim(),
      micDeviceId: micInputSelect.value,
      virtualCableDeviceId: virtualCableSelect.value
    };
    await ipcRenderer.invoke('SAVE_SETTINGS', newSettings);
  }

  function updateStatusBadge(active) {
    if (active) {
      liveBadge.classList.add('active');
      statusText.textContent = 'ACTIVO (LIVE)';
    } else {
      liveBadge.classList.remove('active');
      statusText.textContent = 'DESACTIVADO';
    }
  }

  async function enumerateAudioDevices() {
    try {
      appendLog('AUDIO', 'Detectando dispositivos de entrada y salida del sistema...');
      const devices = await navigator.mediaDevices.enumerateDevices();
      micInputSelect.innerHTML = '';
      virtualCableSelect.innerHTML = '';

      const audioInputs = devices.filter(d => d.kind === 'audioinput');
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

      audioInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Micrófono ${index + 1}`;
        micInputSelect.appendChild(option);
      });

      audioOutputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Dispositivo Salida ${index + 1}`;
        if (device.label.toLowerCase().includes('cable') || device.label.toLowerCase().includes('virtual')) {
          option.selected = true;
        }
        virtualCableSelect.appendChild(option);
      });

      appendLog('AUDIO', `Encontrados: ${audioInputs.length} micrófonos, ${audioOutputs.length} salidas de audio.`, 'audio');

    } catch (err) {
      appendLog('AUDIO', `Error enumerando dispositivos: ${err.message}`, 'error');
    }
  }

  // ── Lógica de Prueba de Voz ────────────────────────────────────────
  async function startTest() {
    isListeningTest = true;
    btnTestMic.innerHTML = '<span>🛑 Detener Prueba</span>';
    previewBox.style.display = 'flex';
    previewOrig.textContent = 'Escuchando tu voz por el micrófono...';
    previewTrans.textContent = 'Traduciendo en tiempo real...';

    const engine = sttEngineSelect.value;
    const key = geminiKeyInput.value.trim();

    appendLog('TEST', `Iniciando prueba de voz con motor: ${engine}`);

    if (engine === 'gemini_live') {
      if (key.startsWith('AIzaSy')) {
        startGeminiLiveTest(key);
      } else {
        appendLog('GEMINI', 'API Key de Gemini no válida (debe empezar con AIzaSy...). Fallback a WebSpeech.', 'warn');
        startWebSpeechTest();
      }
    } else {
      startWebSpeechTest();
    }
  }

  function stopTest() {
    isListeningTest = false;
    btnTestMic.innerHTML = '<span>🎙️ Probar Transcripción y Traducción en Vivo</span>';
    appendLog('TEST', 'Prueba de voz finalizada por el usuario.');

    if (speechRecognizer) {
      try { speechRecognizer.stop(); } catch (e) {}
      speechRecognizer = null;
    }
    if (geminiLiveClient) {
      geminiLiveClient.disconnect();
      geminiLiveClient = null;
    }
  }

  function startWebSpeechTest() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      previewOrig.textContent = '⚠️ Web Speech API no soportada en este entorno.';
      appendLog('WEBSPEECH', 'Web Speech API no disponible en Chromium Renderer.', 'error');
      return;
    }

    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = true;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = sourceLangSelect.value === 'auto' ? 'es-ES' : sourceLangSelect.value;

    appendLog('WEBSPEECH', `Reconocedor de voz iniciado en idioma: ${speechRecognizer.lang}`, 'audio');

    speechRecognizer.onresult = async (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript.trim()) {
        appendLog('VOICE', `Reconocido: "${finalTranscript.trim()}"`, 'audio');
        previewOrig.textContent = `🎙️ ${finalTranscript}`;

        const translation = await ipcRenderer.invoke('TRANSLATE_TEXT', {
          text: finalTranscript,
          sourceLang: sourceLangSelect.value,
          targetLang: targetLangSelect.value
        });

        appendLog('TRANSLATE', `Traducido: "${translation.translated}"`, 'translate');
        previewTrans.textContent = `✨ ${translation.translated}`;

        ipcRenderer.send('DISPLAY_SUBTITLE', {
          originalText: translation.original,
          translatedText: translation.translated,
          isFinal: true
        });
      }
    };

    speechRecognizer.onerror = (err) => {
      appendLog('WEBSPEECH', `Error en reconocimiento: ${err.error}`, 'error');
    };

    speechRecognizer.start();
  }

  function startGeminiLiveTest(apiKey) {
    appendLog('GEMINI', 'Conectando a Google Gemini Live WebSockets...', 'gemini');

    geminiLiveClient = new GeminiLiveClient({
      apiKey,
      voiceName: geminiVoiceSelect.value,
      onOpen: () => {
        appendLog('GEMINI', '🟢 Conexión con Gemini Live establecida con éxito.', 'gemini');
      },
      onTextReceived: (text) => {
        appendLog('GEMINI', `Texto recibido: "${text}"`, 'gemini');
        previewTrans.textContent = `✨ Gemini Live: ${text}`;
        ipcRenderer.send('DISPLAY_SUBTITLE', {
          originalText: '🎙️ Voz en vivo',
          translatedText: text,
          isFinal: true
        });
      },
      onError: (err) => {
        appendLog('GEMINI', `Error en Gemini Live: ${err.message}`, 'error');
        previewOrig.textContent = `⚠️ Error en Gemini Live: ${err.message}`;
      }
    });

    geminiLiveClient.connect();
  }
});
