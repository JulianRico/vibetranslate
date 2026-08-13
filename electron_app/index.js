/**
 * index.js - Lógica del Renderer para la Ventana Principal de Control
 * Optimizado para Ultra-Baja Latencia, Cero Congelamiento y Filtro de Ruido Inteligente
 */

const { ipcRenderer } = require('electron');
const GeminiLiveClient = require('./gemini-live-client');
const { floatTo16BitPCM, arrayBufferToBase64, encodeWAV } = require('./audio-utils');

// ── Reproductor de Flujo PCM Continuo (Única Instancia AudioContext) ──
class PcmStreamPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.audioCtx = null;
    this.gainNode = null;
    this.nextStartTime = 0;
    this.sinkDeviceId = '';
    this.isPlaying = false;
  }

  async init(sinkDeviceId = '') {
    this.sinkDeviceId = sinkDeviceId;
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: this.sampleRate });
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);
      this.nextStartTime = this.audioCtx.currentTime;

      if (sinkDeviceId && typeof this.audioCtx.setSinkId === 'function') {
        try {
          await this.audioCtx.setSinkId(sinkDeviceId);
        } catch (err) {
          console.warn('[PcmStreamPlayer] Error asignando dispositivo de salida:', err);
        }
      }
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  feedPcm(rawBytes) {
    if (!this.audioCtx || this.audioCtx.state === 'closed' || !rawBytes || rawBytes.length === 0) return;

    try {
      const int16Array = new Int16Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength / 2);
      const float32 = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const now = this.audioCtx.currentTime;
      if (this.nextStartTime < now) {
        this.nextStartTime = now + 0.015; // 15ms lead buffer para evitar chasquidos
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.isPlaying = true;
    } catch (e) {
      console.warn('[PcmStreamPlayer] Error reproduciendo buffer PCM:', e);
    }
  }

  clearQueue() {
    if (this.audioCtx) {
      this.nextStartTime = this.audioCtx.currentTime;
    }
    this.isPlaying = false;
  }

  stop() {
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
    this.nextStartTime = 0;
    this.isPlaying = false;
  }
}

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
  const noiseGateSelect = document.getElementById('noise-gate-select');

  const vadBadge = document.getElementById('vad-badge');
  const vuBar = document.getElementById('vu-bar');
  const vuValText = document.getElementById('vu-val-text');
  const vuThresholdLine = document.getElementById('vu-threshold-line');

  const btnTestMic = document.getElementById('btn-test-mic');
  const previewBox = document.getElementById('preview-box');
  const previewOrig = document.getElementById('preview-orig');
  const previewTrans = document.getElementById('preview-trans');

  const logContainer = document.getElementById('log-container');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnOpenDevTools = document.getElementById('btn-open-devtools');

  const platformBtns = document.querySelectorAll('.platform-btn');

  let isPipelineRunning = false;
  let geminiLiveClient = null;
  let pcmPlayer = new PcmStreamPlayer(24000);

  let micMediaStream = null;
  let audioContext = null;
  let scriptProcessor = null;

  // Estado VAD / Filtro de Ruido
  let currentNoiseThreshold = parseFloat(noiseGateSelect.value) || 0.016;
  let speechHoldFrames = 0;
  let lastAudioLogTime = 0;

  // ── Sistema de Logs en Pantalla y Throttling ───────────────────────
  function appendLog(category, message, type = 'system') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
    logContainer.appendChild(entry);

    if (logContainer.children.length > 100) {
      logContainer.removeChild(logContainer.firstChild);
    }
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

  function updateThresholdLine() {
    currentNoiseThreshold = parseFloat(noiseGateSelect.value) || 0.016;
    const pct = Math.min(100, Math.max(5, Math.round(currentNoiseThreshold * 1200)));
    if (vuThresholdLine) {
      vuThresholdLine.style.left = `${pct}%`;
    }
  }

  function speakText(text, lang = 'en-US') {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 1.05;

      // Seleccionar voz nativa estadounidense de alta calidad
      const voices = window.speechSynthesis.getVoices();
      if (voices && voices.length > 0) {
        const preferredVoice = voices.find(v => 
          (v.lang === 'en-US' || v.lang === 'en_US') && 
          (v.name.includes('Natural') || v.name.includes('David') || v.name.includes('Zira') || v.name.includes('Jenny') || v.name.includes('Guy') || v.name.includes('Google') || v.name.includes('Aria'))
        ) || voices.find(v => (v.lang === 'en-US' || v.lang === 'en_US') && !v.name.toLowerCase().includes('india') && !v.name.toLowerCase().includes('ravi'))
          || voices.find(v => v.lang.startsWith('en') && !v.name.toLowerCase().includes('india'));

        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
      }

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[TTS] Error sintetizando voz:', e);
    }
  }

  // ── Cargar Preferencias Iniciales ─────────────────────────────────
  appendLog('CONFIG', 'Iniciando sistema y cargando configuración...');
  const settings = await ipcRenderer.invoke('GET_SETTINGS');
  applySettingsToUI(settings);
  await enumerateAudioDevices();
  updateThresholdLine();

  // ── Event Listeners de UI ─────────────────────────────────────────
  toggleActive.addEventListener('change', async () => {
    const isActive = toggleActive.checked;
    updateStatusBadge(isActive);
    appendLog('CONTROL', `Traducción en vivo ${isActive ? 'ACTIVADA 🟢' : 'DESACTIVADA ⚪'}`);
    await saveCurrentSettings();
    ipcRenderer.send('TOGGLE_OVERLAY', isActive);

    if (isActive && !isPipelineRunning) {
      await startTranslationSession();
    } else if (!isActive && isPipelineRunning) {
      stopTranslationSession();
    }
  });

  sttEngineSelect.addEventListener('change', () => {
    updateEngineGroupsVisibility();
    appendLog('ENGINE', `Motor STT cambiado a: ${sttEngineSelect.value}`);
    saveCurrentSettings();
  });

  noiseGateSelect.addEventListener('change', () => {
    updateThresholdLine();
    appendLog('VAD', `Umbral de filtro de ruido actualizado a: ${currentNoiseThreshold}`);
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

  btnTestMic.addEventListener('click', async () => {
    if (isPipelineRunning) {
      stopTranslationSession();
    } else {
      await startTranslationSession();
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
    if (s.noiseGateThreshold) {
      noiseGateSelect.value = s.noiseGateThreshold;
    }

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
      noiseGateThreshold: parseFloat(noiseGateSelect.value) || 0.016,
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

      appendLog('AUDIO', `Detectados: ${audioInputs.length} micrófonos, ${audioOutputs.length} salidas.`, 'audio');
    } catch (err) {
      appendLog('AUDIO', `Error enumerando dispositivos: ${err.message}`, 'error');
    }
  }

  // ── Controlador Unificado de Sesión de Traducción ─────────────────
  async function startTranslationSession() {
    isPipelineRunning = true;
    btnTestMic.innerHTML = '<span>🛑 Detener Traducción en Vivo</span>';
    previewBox.style.display = 'flex';
    previewOrig.textContent = '🎙️ Escuchando tu voz con filtro de ruido activo...';
    previewTrans.textContent = '⚡ Traducción simultánea lista...';

    const engine = sttEngineSelect.value;
    const geminiKey = geminiKeyInput.value.trim();
    const groqKey = groqKeyInput.value.trim();

    appendLog('PIPELINE', `Iniciando motor: ${engine.toUpperCase()}`);

    if (engine === 'gemini_live') {
      if (!geminiKey || geminiKey.length < 5) {
        appendLog('GEMINI', '⚠️ Ingresa tu Gemini API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Gemini en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: aistudio.google.com/app/apikey';
        return;
      }
      await startUnifiedAudioPipeline('gemini_live', geminiKey);
    } else if (engine === 'whisper_groq') {
      if (!groqKey || groqKey.length < 5) {
        appendLog('GROQ', '⚠️ Ingresa tu Groq API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Groq en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: console.groq.com/keys';
        return;
      }
      await startUnifiedAudioPipeline('whisper_groq', groqKey);
    }
  }

  function stopTranslationSession() {
    isPipelineRunning = false;
    btnTestMic.innerHTML = '<span>🎙️ Probar Transcripción y Traducción en Vivo</span>';
    appendLog('PIPELINE', 'Pipeline de voz detenido.');

    if (vadBadge) {
      vadBadge.className = 'vad-badge';
      vadBadge.textContent = '⚪ SILENCIO';
    }
    if (vuBar) vuBar.style.width = '0%';
    if (vuValText) vuValText.textContent = '0%';

    if (micMediaStream) {
      micMediaStream.getTracks().forEach(t => t.stop());
      micMediaStream = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch (e) {}
      audioContext = null;
    }
    if (geminiLiveClient) {
      geminiLiveClient.disconnect();
      geminiLiveClient = null;
    }
    if (pcmPlayer) {
      pcmPlayer.stop();
    }
  }

  // ── Pipeline Unificado con VAD, Filtrado de Ruido y Soporte Dual ──
  async function startUnifiedAudioPipeline(engine, apiKey) {
    try {
      // 1. Inicializar WebSocket para Gemini Live si aplica
      if (engine === 'gemini_live') {
        await pcmPlayer.init(virtualCableSelect.value);

        geminiLiveClient = new GeminiLiveClient({
          apiKey,
          voiceName: geminiVoiceSelect.value,
          sourceLang: sourceLangSelect.value,
          targetLang: targetLangSelect.value,
          onOpen: () => {
            appendLog('GEMINI', '🟢 Conexión con Gemini Live establecida con éxito.', 'gemini');
          },
          onInterrupted: () => {
            appendLog('GEMINI', '⚡ Voz simultánea detectada en flujo continuo...', 'gemini');
          },
          onAudioReceived: (rawBytes) => {
            pcmPlayer.feedPcm(rawBytes);
            const now = Date.now();
            if (now - lastAudioLogTime > 2000) {
              lastAudioLogTime = now;
              appendLog('AUDIO', `Reproduciendo voz traducida en tiempo real (PCM 24kHz)...`, 'audio');
            }
            previewTrans.textContent = '🔊 Reproduciendo voz traducida al inglés en vivo...';
          },
          onTextReceived: (text) => {
            appendLog('GEMINI', `Traducción: "${text}"`, 'translate');
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
            appendLog('GEMINI', `Conexión cerrada (Código: ${code} - ${reason || 'Normal'}).`, 'warn');
          }
        });

        geminiLiveClient.connect();
      }

      // 2. Captura de audio del micrófono con DSP WebRTC nativo
      const micDeviceId = micInputSelect.value;
      micMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: (micDeviceId && micDeviceId !== 'default') ? { exact: micDeviceId } : undefined,
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      appendLog('AUDIO', `Micrófono capturado con Supresión de Ruido y Cancelación de Eco (${engine.toUpperCase()}).`, 'audio');

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(micMediaStream);
      scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

      // Nodo de silencio para que onaudioprocess se ejecute SIN reproducir el micro en los parlantes
      const muteGain = audioContext.createGain();
      muteGain.gain.value = 0;
      scriptProcessor.connect(muteGain);
      muteGain.connect(audioContext.destination);

      // Buffers para Groq Whisper
      let speechSamplesBuffer = [];
      let continuousSpeechFrames = 0;
      let isTranscribingGroq = false;

      scriptProcessor.onaudioprocess = async (audioProcessingEvent) => {
        if (!isPipelineRunning) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);

        // 1. Cálculo de Energía RMS (Root Mean Square)
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);

        // 2. Actualización de Barra VU Meter en UI
        const levelPct = Math.min(100, Math.round(rms * 900));
        if (vuBar) vuBar.style.width = `${levelPct}%`;
        if (vuValText) vuValText.textContent = `${levelPct}%`;

        // 3. Lógica de Puerta de Ruido (Noise Gate / VAD)
        const threshold = currentNoiseThreshold;

        if (rms >= threshold) {
          speechHoldFrames = 2; // 2 frames (~256ms) de retención
          continuousSpeechFrames++;

          if (vadBadge) {
            vadBadge.className = 'vad-badge speaking';
            vadBadge.textContent = '🟢 VOZ DETECTADA';
          }
        } else {
          if (speechHoldFrames > 0) {
            speechHoldFrames--;
          } else {
            continuousSpeechFrames = 0;
            if (vadBadge) {
              if (rms > threshold * 0.35) {
                vadBadge.className = 'vad-badge noise';
                vadBadge.textContent = '🟡 RUIDO FILTRADO';
              } else {
                vadBadge.className = 'vad-badge';
                vadBadge.textContent = '⚪ SILENCIO';
              }
            }
          }
        }

        // 4. Procesamiento según el motor seleccionado
        if (engine === 'gemini_live') {
          // Solo enviar a Gemini Live si hay voz activa
          if (speechHoldFrames > 0) {
            if (geminiLiveClient && geminiLiveClient.isConnected) {
              if (continuousSpeechFrames > 14) {
                continuousSpeechFrames = 0;
                speechHoldFrames = 0; // Micro-pausa para forzar traducción
              } else {
                const pcm16Buffer = floatTo16BitPCM(inputData);
                const base64Data = arrayBufferToBase64(pcm16Buffer);
                geminiLiveClient.sendRealtimeAudioChunk(base64Data);
              }
            }
          }
        } else if (engine === 'whisper_groq') {
          // Acumular muestras SOLO mientras hay voz
          if (speechHoldFrames > 0) {
            for (let i = 0; i < inputData.length; i++) {
              speechSamplesBuffer.push(inputData[i]);
            }
          }

          // Si el usuario pausó O se alcanzó ~1.8s de habla continua (28000 muestras)
          const shouldProcessGroq = (speechHoldFrames === 0 && speechSamplesBuffer.length > 8000) || (speechSamplesBuffer.length > 28000);

          if (shouldProcessGroq && !isTranscribingGroq) {
            const samplesToSend = new Float32Array(speechSamplesBuffer);
            speechSamplesBuffer = [];
            continuousSpeechFrames = 0;
            isTranscribingGroq = true;

            try {
              const wavBuffer = encodeWAV(samplesToSend, 16000);
              const wavBase64 = arrayBufferToBase64(wavBuffer);

              const result = await ipcRenderer.invoke('TRANSCRIBE_GROQ', {
                audioBase64: wavBase64,
                apiKey,
                language: sourceLangSelect.value.substring(0, 2),
                format: 'wav'
              });

              if (result && result.text && result.text.trim()) {
                const recognizedText = result.text.trim();
                // Descartar alucinaciones típicas de Whisper en susurros
                if (!recognizedText.match(/^(gracias|subtítulos|thank you|you|\.)$/i) || recognizedText.length > 3) {
                  appendLog('VOICE', `Reconocido (Groq): "${recognizedText}"`, 'audio');
                  previewOrig.textContent = `🎙️ ${recognizedText}`;

                  const translation = await ipcRenderer.invoke('TRANSLATE_TEXT', {
                    text: recognizedText,
                    sourceLang: sourceLangSelect.value,
                    targetLang: targetLangSelect.value
                  });

                  if (translation && translation.translated && translation.translated.trim()) {
                    const translatedText = translation.translated.trim();
                    appendLog('TRANSLATE', `Traducido: "${translatedText}"`, 'translate');
                    previewTrans.textContent = `✨ ${translatedText}`;

                    ipcRenderer.send('DISPLAY_SUBTITLE', {
                      originalText: translation.original,
                      translatedText: translatedText,
                      isFinal: true
                    });

                    speakText(translatedText, targetLangSelect.value === 'es' ? 'es-ES' : 'en-US');
                  }
                }
              }
            } catch (err) {
              console.warn('[Groq Unified] Error:', err);
            } finally {
              isTranscribingGroq = false;
            }
          }
        }
      };

      source.connect(scriptProcessor);

    } catch (err) {
      appendLog('AUDIO', `Error en captura de audio: ${err.message}`, 'error');
    }
  }
});


