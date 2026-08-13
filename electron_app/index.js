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

  let isListeningTest = false;
  let geminiLiveClient = null;
  let micMediaStream = null;
  let audioContext = null;
  let scriptProcessor = null;
  let mediaRecorder = null;

  // ── Sistema de Logs en Pantalla ───────────────────────────────────
  function appendLog(category, message, type = 'system') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;

    ipcRenderer.send('LOG_CLIENT_EVENT', { category, message, type });
  }

  if (btnClearLogs) {
    btnClearLogs.addEventListener('click', () => {
      logContainer.innerHTML = '<div class="log-entry system">[SISTEMA] Consola limpiada por el usuario.</div>';
    });
  }

  if (btnOpenDevTools) {
    btnOpenDevTools.addEventListener('click', () => {
      appendLog('DEVTOOLS', 'Abriendo Developer Tools de Chromium...');
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
    sttEngineSelect.value = s.sttEngine || 'gemini_live';
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
      appendLog('AUDIO', 'Detectando dispositivos de audio del sistema...');
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

  // ── Lógica de Prueba de Voz y Pipelines ────────────────────────────
  async function startTest() {
    isListeningTest = true;
    btnTestMic.innerHTML = '<span>🛑 Detener Prueba</span>';
    previewBox.style.display = 'flex';
    previewOrig.textContent = 'Escuchando tu voz por el micrófono...';
    previewTrans.textContent = 'Traduciendo en tiempo real...';

    const engine = sttEngineSelect.value;
    const geminiKey = geminiKeyInput.value.trim();
    const groqKey = groqKeyInput.value.trim();

    appendLog('TEST', `Iniciando prueba de voz con motor: ${engine}`);

    if (engine === 'gemini_live') {
      if (geminiKey && geminiKey.length > 5) {
        await startGeminiLivePipeline(geminiKey);
      } else {
        appendLog('GEMINI', '⚠️ Ingresa una API Key en el campo de Gemini.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Gemini en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave en: aistudio.google.com/app/apikey';
      }
    } else if (engine === 'whisper_groq') {
      if (groqKey && groqKey.length > 5) {
        await startGroqWhisperPipeline(groqKey);
      } else {
        appendLog('GROQ', '⚠️ Ingresa tu Groq API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Groq en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: console.groq.com/keys';
      }
    }
  }

  function stopTest() {
    isListeningTest = false;
    btnTestMic.innerHTML = '<span>🎙️ Probar Transcripción y Traducción en Vivo</span>';
    appendLog('TEST', 'Prueba de voz finalizada.');

    if (micMediaStream) {
      micMediaStream.getTracks().forEach(t => t.stop());
      micMediaStream = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch (e) {}
      audioContext = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) {}
      mediaRecorder = null;
    }
    if (geminiLiveClient) {
      geminiLiveClient.disconnect();
      geminiLiveClient = null;
    }
  }

  async function startGeminiLivePipeline(apiKey) {
    try {
      appendLog('GEMINI', 'Conectando WebSocket a Google Gemini Live...', 'gemini');

      geminiLiveClient = new GeminiLiveClient({
        apiKey,
        voiceName: geminiVoiceSelect.value,
        onOpen: () => {
          appendLog('GEMINI', '🟢 Conexión con Gemini Live establecida con éxito.', 'gemini');
        },
        onTextReceived: (text) => {
          appendLog('GEMINI', `Traducción recibida: "${text}"`, 'translate');
          previewTrans.textContent = `✨ ${text}`;
          ipcRenderer.send('DISPLAY_SUBTITLE', {
            originalText: '🎙️ Mi voz en vivo',
            translatedText: text,
            isFinal: true
          });
        },
        onError: (err) => {
          appendLog('GEMINI', `Error: ${err.message}`, 'error');
          previewOrig.textContent = `⚠️ Error en Gemini Live: ${err.message}`;
        },
        onClose: ({ code, reason }) => {
          appendLog('GEMINI', `Conexión cerrada por el servidor (Código: ${code} - Razón: ${reason || 'Sin detalles'}).`, 'warn');
        }
      });

      geminiLiveClient.connect();

      micMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micInputSelect.value ? { exact: micInputSelect.value } : undefined,
          channelCount: 1,
          sampleRate: 16000
        }
      });

      appendLog('AUDIO', 'Microfono capturado y transmitiendo en PCM 16kHz.', 'audio');

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(micMediaStream);
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

      scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        if (!geminiLiveClient || !geminiLiveClient.isConnected) return;
        const inputBuffer = audioProcessingEvent.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        const pcm16Buffer = floatTo16BitPCM(inputData);
        const base64Data = arrayBufferToBase64(pcm16Buffer);
        geminiLiveClient.sendRealtimeAudioChunk(base64Data);
      };

      source.connect(scriptProcessor);
      scriptProcessor.connect(audioContext.destination);

    } catch (err) {
      appendLog('AUDIO', `Error capturando audio del micrófono: ${err.message}`, 'error');
    }
  }

  async function startGroqWhisperPipeline(apiKey) {
    try {
      micMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micInputSelect.value ? { exact: micInputSelect.value } : undefined
        }
      });

      appendLog('AUDIO', 'Micrófono capturado para Groq Whisper AI.', 'audio');

      mediaRecorder = new MediaRecorder(micMediaStream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 2000 && isListeningTest) {
          appendLog('AUDIO', `Enviando fragmento de voz (${e.data.size} bytes)...`, 'audio');
          const arrayBuffer = await e.data.arrayBuffer();
          const base64 = arrayBufferToBase64(arrayBuffer);

          const result = await ipcRenderer.invoke('TRANSCRIBE_GROQ', {
            audioBase64: base64,
            apiKey: apiKey || '',
            language: sourceLangSelect.value.substring(0, 2)
          });

          if (result && result.text && result.text.trim()) {
            appendLog('VOICE', `Reconocido (Groq): "${result.text.trim()}"`, 'audio');
            previewOrig.textContent = `🎙️ ${result.text.trim()}`;

            const translation = await ipcRenderer.invoke('TRANSLATE_TEXT', {
              text: result.text.trim(),
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
        }
      };

      mediaRecorder.start(2500);
      appendLog('GROQ', 'Reconocimiento Groq Whisper activo (intervalo de 2.5s)', 'gemini');

    } catch (err) {
      appendLog('AUDIO', `Error en captura de audio para Groq Whisper: ${err.message}`, 'error');
    }
  }
});
