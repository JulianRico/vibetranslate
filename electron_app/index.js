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

  const platformBtns = document.querySelectorAll('.platform-btn');

  let speechRecognizer = null;
  let isListeningTest = false;
  let geminiLiveClient = null;

  // ── Cargar Configuración Inicial ──────────────────────────────────
  const settings = await ipcRenderer.invoke('GET_SETTINGS');
  applySettingsToUI(settings);
  await enumerateAudioDevices();

  // ── Event Listeners de UI ─────────────────────────────────────────
  toggleActive.addEventListener('change', async () => {
    const isActive = toggleActive.checked;
    updateStatusBadge(isActive);
    await saveCurrentSettings();
    ipcRenderer.send('TOGGLE_OVERLAY', isActive);
  });

  sttEngineSelect.addEventListener('change', () => {
    updateEngineGroupsVisibility();
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

    } catch (err) {
      console.warn('[Renderer] Error enumerando dispositivos de audio:', err);
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

    if (engine === 'gemini_live' && key.startsWith('AIzaSy')) {
      startGeminiLiveTest(key);
    } else {
      startWebSpeechTest();
    }
  }

  function stopTest() {
    isListeningTest = false;
    btnTestMic.innerHTML = '<span>🎙️ Probar Transcripción y Traducción en Vivo</span>';

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
      return;
    }

    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = true;
    speechRecognizer.interimResults = true;
    speechRecognizer.lang = sourceLangSelect.value === 'auto' ? 'es-ES' : sourceLangSelect.value;

    speechRecognizer.onresult = async (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript.trim()) {
        previewOrig.textContent = `🎙️ ${finalTranscript}`;

        const translation = await ipcRenderer.invoke('TRANSLATE_TEXT', {
          text: finalTranscript,
          sourceLang: sourceLangSelect.value,
          targetLang: targetLangSelect.value
        });

        previewTrans.textContent = `✨ ${translation.translated}`;

        // Enviar resultado al overlay flotante
        ipcRenderer.send('DISPLAY_SUBTITLE', {
          originalText: translation.original,
          translatedText: translation.translated,
          isFinal: true
        });
      }
    };

    speechRecognizer.start();
  }

  function startGeminiLiveTest(apiKey) {
    geminiLiveClient = new GeminiLiveClient({
      apiKey,
      voiceName: geminiVoiceSelect.value,
      onTextReceived: (text) => {
        previewTrans.textContent = `✨ Gemini Live: ${text}`;
        ipcRenderer.send('DISPLAY_SUBTITLE', {
          originalText: '🎙️ Voz en vivo',
          translatedText: text,
          isFinal: true
        });
      },
      onError: (err) => {
        previewOrig.textContent = `⚠️ Error en Gemini Live: ${err.message}`;
      }
    });

    geminiLiveClient.connect();
  }
});
