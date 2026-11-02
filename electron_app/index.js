/**
 * index.js - Lógica del Renderer para la Ventana Principal de Control
 * Optimizado para Ultra-Baja Latencia, Cero Congelamiento y Filtro de Ruido Inteligente
 */

const { ipcRenderer } = require('electron');
const GeminiLiveClient = require('./gemini-live-client');
const { floatTo16BitPCM, arrayBufferToBase64, base64ToArrayBuffer, encodeWAV, isWhisperHallucination } = require('./audio-utils');
const { createOutputQueue } = require('./output-queue');
const { createConversationLog } = require('./conversation-log');
const { createLevelCompensator } = require('./level-compensator');
const { resolvePair } = require('./local-ai/languages');
const { thresholdFromNoiseGate } = require('./local-ai/segmenter');
const { createTranslateRouter } = require('./local-ai/translate-route');
const { createSlowDetector } = require('./local-ai/slow-detector');

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
    if (this.audioCtx && this.gainNode) {
      try {
        this.gainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.connect(this.audioCtx.destination);
      } catch (e) { }
      this.nextStartTime = this.audioCtx.currentTime;
    }
    this.isPlaying = false;
  }

  stop() {
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) { }
      this.audioCtx = null;
    }
    this.nextStartTime = 0;
    this.isPlaying = false;
  }
}

// ── Reproductor Secuencial para Cable Virtual (Cero Superposición de Audio) ──
class VirtualCablePlayer {
  constructor() {
    this.audioCtx = null;
    this.gainNode = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.currentSource = null;
  }

  async init(sinkDeviceId = '') {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);

      if (sinkDeviceId && sinkDeviceId !== 'default' && typeof this.audioCtx.setSinkId === 'function') {
        try {
          await this.audioCtx.setSinkId(sinkDeviceId);
        } catch (err) {
          console.warn('[VirtualCablePlayer] Error en setSinkId:', err);
        }
      }
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  async enqueue(arrayBuffer, sinkDeviceId = '') {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;
    this.audioQueue.push({ arrayBuffer, sinkDeviceId });
    if (!this.isPlaying) {
      this._playNext();
    }
  }

  async _playNext() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      return;
    }

    this.isPlaying = true;
    const item = this.audioQueue.shift();

    try {
      await this.init(item.sinkDeviceId);
      const decodedBuffer = await this.audioCtx.decodeAudioData(item.arrayBuffer.slice(0));

      const source = this.audioCtx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(this.gainNode);
      this.currentSource = source;

      source.onended = () => {
        this.currentSource = null;
        this._playNext();
      };

      source.start(0);
    } catch (err) {
      console.warn('[VirtualCablePlayer] Error reproduciendo audio secuencial:', err);
      this.currentSource = null;
      this._playNext();
    }
  }

  stop() {
    this.audioQueue = [];
    this.isPlaying = false;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (e) { }
      this.currentSource = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch (e) { }
      this.audioCtx = null;
    }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const toggleActive = document.getElementById('toggle-active');
  const toggleOverlay = document.getElementById('toggle-overlay');
  const btnToggleOverlayHeader = document.getElementById('btn-toggle-overlay-header');
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

  // ── Elementos de Fish Audio AI ─────────────────────────────────────
  const ttsEngineSelect = document.getElementById('tts-engine-select');
  const ttsEngineBadge = document.getElementById('tts-engine-badge');
  const fishAudioPanel = document.getElementById('fish-audio-panel');
  const fishApiKeyInput = document.getElementById('fish-api-key');
  const btnToggleFishKey = document.getElementById('btn-toggle-fish-key');
  const btnVerifyFishKey = document.getElementById('btn-verify-fish-key');
  const fishStatusPill = document.getElementById('fish-status-pill');
  const fishVoiceSelect = document.getElementById('fish-voice-select');
  const btnRefreshFishVoices = document.getElementById('btn-refresh-fish-voices');
  const fishCustomVoiceGroup = document.getElementById('fish-custom-voice-group');
  const fishVoiceIdInput = document.getElementById('fish-voice-id-input');
  const btnOpenCloneStudio = document.getElementById('btn-open-clone-studio');
  const btnTestFishVoice = document.getElementById('btn-test-fish-voice');
  const fishModelTier = document.getElementById('fish-model-tier');
  const fishLatencyMode = document.getElementById('fish-latency-mode');

  // ── Elementos del Modal de Clonación de Voz ────────────────────────
  const voiceCloneModal = document.getElementById('voice-clone-modal');
  const btnCloseCloneModal = document.getElementById('btn-close-clone-modal');
  const btnCloseCloneFooter = document.getElementById('btn-close-clone-footer');
  const btnToggleRecord = document.getElementById('btn-toggle-record');
  const btnRecordText = document.getElementById('btn-record-text');
  const recordStatusDot = document.getElementById('record-status-dot');
  const recordStatusLabel = document.getElementById('record-status-label');
  const recordTimerBadge = document.getElementById('record-timer-badge');
  const voiceWaveContainer = document.getElementById('voice-wave-container');
  const btnPlayPreview = document.getElementById('btn-play-preview');
  const btnDiscardRecord = document.getElementById('btn-discard-record');
  const clonePreviewAudio = document.getElementById('clone-preview-audio');
  const cloneModelTitle = document.getElementById('clone-model-title');
  const cloneVisibility = document.getElementById('clone-visibility');
  const cloneSampleTranscript = document.getElementById('clone-sample-transcript');
  const trainingStatusBox = document.getElementById('training-status-box');
  const trainingStatusTitle = document.getElementById('training-status-title');
  const trainingStatusDesc = document.getElementById('training-status-desc');
  const trainingSpinner = document.getElementById('training-spinner');
  const trainingStatusIcon = document.getElementById('training-status-icon');
  const trainingBadgeStep = document.getElementById('training-badge-step');
  const trainingProgressFill = document.getElementById('training-progress-fill');
  const btnSubmitVoiceClone = document.getElementById('btn-submit-voice-clone');

  const micInputSelect = document.getElementById('mic-input-select');
  const virtualCableSelect = document.getElementById('virtual-cable-select');
  const noiseGateSelect = document.getElementById('noise-gate-select');
  const localAiGroup = document.getElementById('local-ai-group');
  const incomingVoiceToggle = document.getElementById('incoming-voice-toggle');
  const duckLevelSelect = document.getElementById('duck-level');
  const conversationLogEl = document.getElementById('conversation-log');
  const conversationEmptyEl = document.getElementById('conversation-empty');
  const labToggleBtn = document.getElementById('lab-toggle-btn');
  const labToggleText = document.getElementById('lab-toggle-text');
  const labSaveAudio = document.getElementById('lab-save-audio');
  const labMuteVoice = document.getElementById('lab-mute-voice');
  const labStatus = document.getElementById('lab-status');
  const labNote = document.getElementById('lab-note');
  const labFlagBtn = document.getElementById('lab-flag-btn');
  const labOpenBtn = document.getElementById('lab-open-btn');
  const labSummary = document.getElementById('lab-summary');
  const translationModeSelect = document.getElementById('translation-mode');
  const localAiStatus = document.getElementById('local-ai-status');

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

  const driverMissingBanner = document.getElementById('driver-missing-banner');
  const driverReadyBanner = document.getElementById('driver-ready-banner');
  const btnDownloadVbCable = document.getElementById('btn-download-vbcable');
  const btnRefreshDevices = document.getElementById('btn-refresh-devices');

  const linkVbCableUrl = document.getElementById('link-vbcable-url');
  const linkGetFishKey = document.getElementById('link-get-fish-key');
  const linkGetFishKeyBottom = document.getElementById('link-get-fish-key-bottom');
  const linkGetGroqKey = document.getElementById('link-get-groq-key');
  const linkGetGroqKeyBottom = document.getElementById('link-get-groq-key-bottom');
  const linkGetGeminiKey = document.getElementById('link-get-gemini-key');

  if (linkGetFishKey) {
    linkGetFishKey.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo portal de registro de Fish Audio: https://fish.audio/?aff=SNSVEP4PGIIVI');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://fish.audio/?aff=SNSVEP4PGIIVI');
    });
  }

  if (linkGetFishKeyBottom) {
    linkGetFishKeyBottom.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo portal de registro de Fish Audio: https://fish.audio/?aff=SNSVEP4PGIIVI');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://fish.audio/?aff=SNSVEP4PGIIVI');
    });
  }

  if (linkGetGroqKey) {
    linkGetGroqKey.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo Groq Console para obtener API Key: https://console.groq.com/keys');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://console.groq.com/keys');
    });
  }

  if (linkGetGroqKeyBottom) {
    linkGetGroqKeyBottom.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo Groq Console para obtener API Key: https://console.groq.com/keys');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://console.groq.com/keys');
    });
  }

  if (linkGetGeminiKey) {
    linkGetGeminiKey.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo Google AI Studio para obtener API Key: https://aistudio.google.com/app/apikey');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://aistudio.google.com/app/apikey');
    });
  }

  const linkGetGeminiKeyBottom = document.getElementById('link-get-gemini-key-bottom');
  if (linkGetGeminiKeyBottom) {
    linkGetGeminiKeyBottom.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo Google AI Studio para obtener API Key: https://aistudio.google.com/app/apikey');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://aistudio.google.com/app/apikey');
    });
  }

  if (linkVbCableUrl) {
    linkVbCableUrl.addEventListener('click', (e) => {
      e.preventDefault();
      appendLog('SYSTEM', 'Abriendo enlace de descarga: https://vb-audio.com/Cable/');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://vb-audio.com/Cable/');
    });
  }

  if (btnDownloadVbCable) {
    btnDownloadVbCable.addEventListener('click', () => {
      appendLog('SYSTEM', 'Abriendo sitio oficial de descarga de VB-Audio Virtual Cable...');
      ipcRenderer.send('OPEN_EXTERNAL_URL', 'https://vb-audio.com/Cable/');
    });
  }

  if (btnRefreshDevices) {
    btnRefreshDevices.addEventListener('click', async () => {
      appendLog('AUDIO', 'Re-escaneando dispositivos de audio...');
      await enumerateAudioDevices();
    });
  }

  const btnTestVbCable = document.getElementById('btn-test-vbcable');
  if (btnTestVbCable) {
    btnTestVbCable.addEventListener('click', () => {
      appendLog('AUDIO', 'Emitiendo audio de prueba hacia el Cable Virtual...');
      playAudioToVirtualCableAndSpeakers('Hello, this is a live test of the virtual audio cable output.', 'en');
    });
  }

  const btnHardwareCheck = document.getElementById('btn-hardware-check');
  const btnCloseHwModal = document.getElementById('btn-close-hw-modal');
  const btnCloseHwFooter = document.getElementById('btn-close-hw-footer');
  const btnRetestHw = document.getElementById('btn-retest-hw');
  const btnCopyHwReport = document.getElementById('btn-copy-hw-report');
  const btnHwTestCable = document.getElementById('btn-hw-test-cable');
  const btnHwTestSpeakers = document.getElementById('btn-hw-test-speakers');

  if (btnHardwareCheck) {
    btnHardwareCheck.addEventListener('click', () => {
      openHardwareModal();
    });
  }
  if (btnCloseHwModal) btnCloseHwModal.addEventListener('click', closeHardwareModal);
  if (btnCloseHwFooter) btnCloseHwFooter.addEventListener('click', closeHardwareModal);
  if (btnRetestHw) btnRetestHw.addEventListener('click', runHardwareValidation);
  if (btnCopyHwReport) {
    btnCopyHwReport.addEventListener('click', () => {
      if (latestHwReportText) {
        navigator.clipboard.writeText(latestHwReportText).then(() => {
          btnCopyHwReport.innerHTML = '<span>✅ ¡Reporte Copiado!</span>';
          setTimeout(() => {
            btnCopyHwReport.innerHTML = '<span>📋 Copiar Reporte</span>';
          }, 2000);
        });
      }
    });
  }
  if (btnHwTestCable) {
    btnHwTestCable.addEventListener('click', () => {
      appendLog('AUDIO', 'Emitiendo tono de prueba hacia el Cable Virtual...');
      playAudioToVirtualCableAndSpeakers('Tono de prueba del cable virtual emitido correctamente.', 'es');
    });
  }
  if (btnHwTestSpeakers) {
    btnHwTestSpeakers.addEventListener('click', () => {
      appendLog('AUDIO', 'Probando salida de altavoces locales...');
      speakSpanishToUser('Prueba de sonido en altavoces locales completada.');
    });
  }

  // ── Botones de Cabecera (Tema, Modo PiP, Exportación) ─────────────
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  const btnPipToggle = document.getElementById('btn-pip-toggle');
  const btnExportAll = document.getElementById('btn-export-all');

  // 1. Tema Dark / Light Glass
  let currentTheme = localStorage.getItem('vibetranslate_theme') || 'light';
  if (currentTheme === 'dark') {
    document.body.classList.add('dark-theme');
    if (btnThemeToggle) btnThemeToggle.textContent = '☀️';
  }

  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark-theme');
      const themeName = isDark ? 'dark' : 'light';
      localStorage.setItem('vibetranslate_theme', themeName);
      btnThemeToggle.textContent = isDark ? '☀️' : '🌙';
      btnThemeToggle.title = isDark ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro';
      appendLog('THEME', `Tema cambiado a: ${isDark ? 'Modo Oscuro (Dark Obsidian Glass)' : 'Modo Claro (Liquid Frosted Glass)'}`);
    });
  }

  // 2. Modo Mini-Ventana Flotante (Picture-in-Picture)
  if (btnPipToggle) {
    btnPipToggle.addEventListener('click', async () => {
      try {
        const isPip = await ipcRenderer.invoke('TOGGLE_PIP_MODE');
        if (isPip) {
          document.body.classList.add('pip-mode');
          btnPipToggle.textContent = '🗖';
          btnPipToggle.title = 'Restaurar a Modo Estudio Completo';
          appendLog('WINDOW', 'Modo Mini-Player Flotante (PiP) activado.');
        } else {
          document.body.classList.remove('pip-mode');
          btnPipToggle.textContent = '🗗';
          btnPipToggle.title = 'Modo Mini-Ventana Flotante (PiP)';
          appendLog('WINDOW', 'Ventana restaurada a modo Estudio completo.');
        }
      } catch (err) {
        console.warn('[PiP Toggle] Error:', err);
      }
    });
  }

  // 3. Exportar Historial de Transcripciones y Reporte
  const logHistoryArray = [];
  const conversationLog = createConversationLog();

  if (btnExportAll) {
    btnExportAll.addEventListener('click', async () => {
      appendLog('EXPORT', 'Generando reporte completo de sesión y transcripciones...');

      const now = new Date();
      const exportReport = `=====================================================
   ViBeTranslate Pro Studio - Reporte de Sesión
=====================================================
Fecha y Hora: ${now.toLocaleString()}
Plataforma: ${activePlatform ? activePlatform.toUpperCase() : 'GOOGLE MEET'}
Motor STT: ${sttEngineSelect?.value || 'whisper_groq'}
Idioma Origen: ${sourceLangSelect?.value || 'es'}
Idioma Destino: ${targetLangSelect?.value || 'en'}
Driver VB-Cable: ${isVbCableDriverDetected ? 'CALIBRADO Y ACTIVO 🟢' : 'NO DETECTADO ⚠️'}

--- HISTORIAL DE TRADUCCIÓN SIMULTÁNEA (${conversationLog.size()} frases registradas) ---
${conversationLog.size() > 0
          ? conversationLog.toText()
          : 'No se han registrado frases en esta sesión todavía.'}

--- REGISTRO DE EVENTOS Y TERMINAL DE LOGS (Últimos 40 eventos) ---
${logHistoryArray.length > 0 ? logHistoryArray.slice(-40).join('\n') : 'Logs del sistema no disponibles.'}

=====================================================
Generado automáticamente por ViBeTranslate Desktop
=====================================================`;

      try {
        const res = await ipcRenderer.invoke('EXPORT_SESSION_REPORT', { content: exportReport, format: 'txt' });
        if (res && res.success) {
          btnExportAll.textContent = '✅';
          appendLog('EXPORT', `Archivo guardado exitosamente en: ${res.filePath}`);
          setTimeout(() => { btnExportAll.textContent = '📤'; }, 2500);
        } else if (res && !res.canceled) {
          navigator.clipboard.writeText(exportReport);
          btnExportAll.textContent = '📋';
          appendLog('EXPORT', 'Reporte copiado al portapapeles.');
          setTimeout(() => { btnExportAll.textContent = '📤'; }, 2500);
        }
      } catch (e) {
        navigator.clipboard.writeText(exportReport);
        btnExportAll.textContent = '📋';
        appendLog('EXPORT', 'Reporte copiado al portapapeles.');
        setTimeout(() => { btnExportAll.textContent = '📤'; }, 2500);
      }
    });
  }

  let isPipelineRunning = false;
  let isLiveToggleActive = false;
  let isTestBtnActive = false;
  let geminiLiveClient = null;
  let pcmPlayer = new PcmStreamPlayer(24000);
  let virtualCablePlayer = new VirtualCablePlayer();

  let micMediaStream = null;
  let audioContext = null;
  let scriptProcessor = null;

  // Estado VAD / Filtro de Ruido
  let currentNoiseThreshold = parseFloat(noiseGateSelect.value) || 0.016;
  let speechHoldFrames = 0;
  let lastAudioLogTime = 0;
  let speechBlockStartTime = 0;
  let isSpeakingActive = false;

  // ── Sistema de Logs en Pantalla y Throttling ───────────────────────
  function appendLog(category, message, type = 'system') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const logLine = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
    logHistoryArray.push(logLine);
    if (logHistoryArray.length > 200) logHistoryArray.shift();

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = logLine;
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

  const localMonitorToggle = document.getElementById('local-monitor-toggle');
  const translateIncomingToggle = document.getElementById('translate-incoming-toggle');
  const spanishVoiceSelect = document.getElementById('spanish-voice-select');
  const btnTestSpanishVoice = document.getElementById('btn-test-spanish-voice');

  let incomingMediaStream = null;
  let incomingAudioContext = null;
  let incomingScriptProcessor = null;
  let incomingExcludesOwnAudio = false; // la captura de la reunión no incluye el sonido de esta app
  let incomingLevel = createLevelCompensator({ maxGain: 1 }); // compensa la atenuación: la captura recibe a los demás programas ya bajados

  function populateSpanishVoices() {
    if (!spanishVoiceSelect || !window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    const spanishVoices = voices.filter(v => v.lang.startsWith('es') || v.lang.includes('es-') || v.lang.includes('es_'));

    const currentVal = spanishVoiceSelect.value;
    spanishVoiceSelect.innerHTML = `
      <option value="auto">⚡ Auto (Mejor voz en Español detectada)</option>
      <option value="google_tts">Google Español (Neutro Natural Online)</option>
    `;

    spanishVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      spanishVoiceSelect.appendChild(opt);
    });

    if (currentVal && Array.from(spanishVoiceSelect.options).some(o => o.value === currentVal)) {
      spanishVoiceSelect.value = currentVal;
    }
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = populateSpanishVoices;
    populateSpanishVoices();
  }

  const spanishVolumeSlider = document.getElementById('spanish-volume-slider');
  const spanishVolumeText = document.getElementById('spanish-volume-text');
  const btnPresetVols = document.querySelectorAll('.btn-preset-vol');

  let currentSpanishVolume = 0.90; // 90% por defecto

  if (spanishVolumeSlider) {
    spanishVolumeSlider.addEventListener('input', () => {
      const val = parseInt(spanishVolumeSlider.value, 10) || 90;
      currentSpanishVolume = Math.max(0.1, Math.min(1.0, val / 100));
      if (spanishVolumeText) spanishVolumeText.textContent = `${val}%`;
      saveCurrentSettings();
    });
  }

  btnPresetVols.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = parseInt(btn.getAttribute('data-vol'), 10) || 90;
      if (spanishVolumeSlider) spanishVolumeSlider.value = val;
      if (spanishVolumeText) spanishVolumeText.textContent = `${val}%`;
      currentSpanishVolume = Math.max(0.1, Math.min(1.0, val / 100));
      btnPresetVols.forEach(b => {
        b.style.background = 'rgba(255,255,255,0.06)';
        b.style.borderColor = 'rgba(255,255,255,0.15)';
      });
      btn.style.background = 'rgba(59, 130, 246, 0.25)';
      btn.style.borderColor = 'rgba(59, 130, 246, 0.5)';
      saveCurrentSettings();
    });
  });

  let isAppSpeaking = false;
  let lastAppSpeakingEndTime = 0;

  function markAppSpeakingStart() {
    isAppSpeaking = true;
  }

  function markAppSpeakingEnd(delayMs = 450) {
    setTimeout(() => {
      isAppSpeaking = false;
      lastAppSpeakingEndTime = Date.now();
    }, delayMs);
  }

  async function speakSpanishToUser(text, { inProcessOnly = false, waitForEnd = false } = {}) {
    if (!text || !text.trim()) return { success: false, elapsedMs: 0 };

    const startTtsTime = Date.now();
    const vol = Math.max(0.1, Math.min(1.0, currentSpanishVolume));
    const selectedVoice = spanishVoiceSelect ? spanishVoiceSelect.value : 'auto';

    appendLog('TTS', `🔊 Voz en español: "${text}" (${Math.round(vol * 100)}%)`, 'audio');

    // Intentar primero con Google TTS natural (MP3 de alta fidelidad)
    // inProcessOnly: la voz debe sonar desde esta app (un elemento de audio). La voz del sistema (Web Speech)
    // la reproduce Windows por su cuenta y entraría en la captura de la reunión, creando un bucle.
    if (selectedVoice === 'google_tts' || selectedVoice === 'auto' || inProcessOnly) {
      try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.trim())}&tl=es&client=tw-ob`;
        const audio = new Audio(url);
        audio.volume = vol;
        audio.playbackRate = 1.15; // algo más rápido que el habla normal, para no quedarse atrás
        markAppSpeakingStart();
        if (inProcessOnly || waitForEnd) {
          // Se espera a que termine de sonar: así las frases no se pisan y se sabe cuánta voz hay pendiente
          const finished = new Promise((resolve) => {
            const limit = setTimeout(() => resolve(false), 20000);
            audio.onended = () => { clearTimeout(limit); resolve(true); };
            audio.onerror = () => { clearTimeout(limit); resolve(false); };
          });
          await audio.play();
          const played = await finished;
          markAppSpeakingEnd(played ? 450 : 0);
          if (played || inProcessOnly) return { success: played, elapsedMs: Date.now() - startTtsTime };
          throw new Error('la voz en línea no llegó a sonar');
        }
        audio.onended = () => markAppSpeakingEnd(450);
        audio.onerror = () => {
          fallbackWebSpeech(text, vol, selectedVoice);
        };
        await audio.play();
        const elapsed = Date.now() - startTtsTime;
        return { success: true, elapsedMs: elapsed };
      } catch (e) {
        console.warn('[TTS Google] Intentando fallback Web Speech:', e);
        if (inProcessOnly || waitForEnd) markAppSpeakingEnd(0);
      }
    }

    if (inProcessOnly) {
      appendLog('TTS', '⚠️ No se pudo obtener la voz en línea: esta frase queda solo como subtítulo.', 'warn');
      return { success: false, elapsedMs: Date.now() - startTtsTime };
    }

    fallbackWebSpeech(text, vol, selectedVoice);
    if (waitForEnd) {
      // La voz del sistema no avisa aquí de cuándo acaba: se espera a que deje de hablar para no pisar la frase siguiente
      await new Promise((resolve) => setTimeout(resolve, 300));
      const limit = Date.now() + 20000;
      while (window.speechSynthesis && window.speechSynthesis.speaking && Date.now() < limit) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    const elapsed = Date.now() - startTtsTime;
    return { success: true, elapsedMs: elapsed };
  }

  function fallbackWebSpeech(text, vol, selectedVoice) {
    try {
      window.speechSynthesis.cancel();
      setTimeout(() => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        utterance.rate = 1.05;
        utterance.volume = vol;

        utterance.onstart = () => markAppSpeakingStart();
        utterance.onend = () => markAppSpeakingEnd(450);
        utterance.onerror = () => markAppSpeakingEnd(0);

        const voices = window.speechSynthesis.getVoices();
        if (voices && voices.length > 0) {
          let voiceToUse = null;
          if (selectedVoice && selectedVoice !== 'auto' && selectedVoice !== 'google_tts') {
            voiceToUse = voices.find(v => v.name === selectedVoice);
          }
          if (!voiceToUse) {
            voiceToUse = voices.find(v => (v.lang.startsWith('es') || v.lang.includes('es-')) && (v.name.includes('Natural') || v.name.includes('Helena') || v.name.includes('Sabina') || v.name.includes('Laura') || v.name.includes('Google') || v.name.includes('Microsoft')))
              || voices.find(v => v.lang.startsWith('es') || v.lang.includes('es-'));
          }
          if (voiceToUse) {
            utterance.voice = voiceToUse;
          }
        }

        markAppSpeakingStart();
        window.speechSynthesis.speak(utterance);
      }, 50);
    } catch (e) {
      console.warn('[TTS Web Speech Error]:', e);
      markAppSpeakingEnd(0);
    }
  }

  if (btnTestSpanishVoice) {
    btnTestSpanishVoice.addEventListener('click', () => {
      const pct = Math.round(currentSpanishVolume * 100);
      speakSpanishToUser(`Hola, esta es una prueba de la voz del traductor en español con volumen al ${pct} por ciento.`);
    });
  }

  function speakText(text, lang = 'en-US') {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = 1.05;

      utterance.onstart = () => markAppSpeakingStart();
      utterance.onend = () => markAppSpeakingEnd(450);
      utterance.onerror = () => markAppSpeakingEnd(0);

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

      markAppSpeakingStart();
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[TTS] Error sintetizando voz:', e);
      markAppSpeakingEnd(0);
    }
  }

  async function playAudioToVirtualCableAndSpeakers(text, lang = 'en', forceLocalMonitor = false) {
    if (!text || !text.trim()) return { success: false, elapsedMs: 0 };

    const ttsStartTime = Date.now();
    const targetCode = (lang === 'es' || lang.startsWith('es')) ? 'es' : 'en';
    const activeTtsEngine = ttsEngineSelect ? ttsEngineSelect.value : 'fish_audio';

    try {
      // 1. Si el motor seleccionado es Fish Audio AI (Clon de Voz)
      if (activeTtsEngine === 'fish_audio') {
        const voiceId = (fishVoiceSelect && fishVoiceSelect.value === 'custom')
          ? (fishVoiceIdInput ? fishVoiceIdInput.value.trim() : null)
          : (fishVoiceSelect ? fishVoiceSelect.value : null);

        const modelTier = fishModelTier ? fishModelTier.value : 's2.1-pro-free';
        const latencyMode = fishLatencyMode ? fishLatencyMode.value : 'balanced';

        appendLog('FISH-AUDIO', `🔊 Solicitando síntesis a Fish Audio (${modelTier}, voz: ${voiceId || 'estándar'})...`, 'audio');

        const result = await ipcRenderer.invoke('FISH_AUDIO_SYNTHESIZE', {
          text: text.trim(),
          voiceModelId: voiceId,
          model: modelTier,
          format: 'mp3',
          latency: latencyMode
        });

        const elapsed = (result && result.elapsedMs) || (Date.now() - ttsStartTime);

        if (result && result.success && result.audioBase64) {
          const arrayBuffer = base64ToArrayBuffer(result.audioBase64);
          appendLog('FISH-AUDIO', `✅ Audio generado en ${elapsed}ms. Transmitiendo a Cable Virtual (Google Meet)...`, 'audio');

          // Enviar al cable virtual para Google Meet / Teams / Zoom en paralelo
          if (virtualCablePlayer) {
            virtualCablePlayer.enqueue(arrayBuffer.slice(0), virtualCableSelect ? virtualCableSelect.value : '');
          }

          // Monitoreo local en altavoces/auriculares (siempre en pruebas o si el switch está activo)
          const shouldPlayLocal = forceLocalMonitor || (localMonitorToggle && localMonitorToggle.checked);

          if (shouldPlayLocal) {
            try {
              const blob = new Blob([arrayBuffer.slice(0)], { type: 'audio/mpeg' });
              const blobUrl = URL.createObjectURL(blob);
              const monitorAudio = new Audio(blobUrl);
              monitorAudio.volume = forceLocalMonitor ? 1.0 : Math.max(0.3, Math.min(1.0, currentSpanishVolume));
              markAppSpeakingStart();
              monitorAudio.onended = () => {
                markAppSpeakingEnd(450);
                URL.revokeObjectURL(blobUrl);
              };
              monitorAudio.onerror = (e) => {
                console.warn('[Fish Audio Monitor Local Error]:', e);
                markAppSpeakingEnd(0);
                URL.revokeObjectURL(blobUrl);
              };
              await monitorAudio.play();
            } catch (e) {
              console.warn('[Fish Audio Monitor Local] Fallback speakText:', e);
              if (shouldPlayLocal) {
                speakText(text, targetCode === 'es' ? 'es-ES' : 'en-US');
              }
            }
          }
          return { success: true, elapsedMs: elapsed };
        } else {
          appendLog('FISH-AUDIO', `⚠️ Fallback a Google TTS por: ${result?.error || 'error desconocido'}`, 'error');
        }
      }

      // 2. Google TTS Natural o Fallback
      if (activeTtsEngine === 'google_tts' || activeTtsEngine === 'fish_audio') {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.trim())}&tl=${targetCode}&client=tw-ob`;
        const response = await fetch(ttsUrl);
        const elapsed = Date.now() - ttsStartTime;
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          appendLog('TTS', `✅ Google TTS generado en ${elapsed}ms. Transmitiendo a Cable Virtual...`, 'audio');
          if (virtualCablePlayer) {
            virtualCablePlayer.enqueue(arrayBuffer.slice(0), virtualCableSelect ? virtualCableSelect.value : '');
          }

          if (forceLocalMonitor || (localMonitorToggle && localMonitorToggle.checked)) {
            speakText(text, targetCode === 'es' ? 'es-ES' : 'en-US');
          }
          return { success: true, elapsedMs: elapsed };
        }
      }

      // 3. Fallback Web Speech
      const elapsed = Date.now() - ttsStartTime;
      if (forceLocalMonitor || (localMonitorToggle && localMonitorToggle.checked)) {
        speakText(text, targetCode === 'es' ? 'es-ES' : 'en-US');
      }
      return { success: true, elapsedMs: elapsed };

    } catch (err) {
      console.warn('[Audio Out] Fallback a sintetizador local:', err);
      const elapsed = Date.now() - ttsStartTime;
      if (forceLocalMonitor || (localMonitorToggle && localMonitorToggle.checked)) {
        speakText(text, targetCode === 'es' ? 'es-ES' : 'en-US');
      }
      return { success: false, elapsedMs: elapsed };
    }
  }

  // ── Cargar Preferencias Iniciales ─────────────────────────────────
  appendLog('CONFIG', 'Iniciando sistema y cargando configuración...');
  const settings = await ipcRenderer.invoke('GET_SETTINGS');
  applySettingsToUI(settings);
  await enumerateAudioDevices();
  updateThresholdLine();
  await loadFishVoiceModels(settings.fishVoiceModelId);
  validateFishApiKey(false);

  // ── Event Listeners de UI ─────────────────────────────────────────
  // Control 1: Switch Superior (Traducción Simultánea en Vivo)
  toggleActive.addEventListener('change', async () => {
    isLiveToggleActive = toggleActive.checked;
    updateStatusBadge(isLiveToggleActive);
    await saveCurrentSettings();

    if (isLiveToggleActive) {
      appendLog('CONTROL', 'Traducción Simultánea ACTIVADA desde switch superior 🟢');
      if (!isPipelineRunning) {
        await startTranslationPipeline();
      }
    } else {
      appendLog('CONTROL', 'Switch superior DESACTIVADO ⚪');
      if (!isTestBtnActive && isPipelineRunning) {
        stopTranslationPipeline();
      }
    }
  });

  // Control 2: Switch del Recuadro Flotante de Subtítulos (Encender / Apagar)
  if (toggleOverlay) {
    toggleOverlay.addEventListener('change', async () => {
      const isVisible = toggleOverlay.checked;
      ipcRenderer.send('TOGGLE_OVERLAY', isVisible);
      await saveCurrentSettings();
      appendLog('UI', `Recuadro Flotante de Subtítulos ${isVisible ? 'ENCENDIDO 🟢' : 'APAGADO ⚪'}`);
      if (btnToggleOverlayHeader) {
        btnToggleOverlayHeader.style.color = isVisible ? 'var(--apple-blue)' : 'var(--text-secondary)';
      }
    });
  }

  if (btnToggleOverlayHeader) {
    btnToggleOverlayHeader.addEventListener('click', async () => {
      if (toggleOverlay) {
        toggleOverlay.checked = !toggleOverlay.checked;
        const isVisible = toggleOverlay.checked;
        ipcRenderer.send('TOGGLE_OVERLAY', isVisible);
        await saveCurrentSettings();
        appendLog('UI', `Recuadro Flotante de Subtítulos ${isVisible ? 'ENCENDIDO 🟢' : 'APAGADO ⚪'}`);
        btnToggleOverlayHeader.style.color = isVisible ? 'var(--apple-blue)' : 'var(--text-secondary)';
      }
    });
  }

  ipcRenderer.on('OVERLAY_STATE_CHANGED', (event, { isVisible }) => {
    if (toggleOverlay) {
      toggleOverlay.checked = isVisible;
    }
    if (btnToggleOverlayHeader) {
      btnToggleOverlayHeader.style.color = isVisible ? 'var(--apple-blue)' : 'var(--text-secondary)';
    }
    appendLog('UI', `Estado del Recuadro Flotante sincronizado: ${isVisible ? 'Visible 🟢' : 'Oculto ⚪'}`);
  });

  sttEngineSelect.addEventListener('change', () => {
    updateEngineGroupsVisibility();
    appendLog('ENGINE', `Motor STT cambiado a: ${sttEngineSelect.value}`);
    saveCurrentSettings();
  });

  if (translationModeSelect) {
    translationModeSelect.addEventListener('change', () => {
      saveCurrentSettings();
    });
  }

  if (incomingVoiceToggle) {
    incomingVoiceToggle.addEventListener('change', () => {
      appendLog('CONTROL', incomingVoiceToggle.checked
        ? 'La traducción de la reunión se leerá en voz alta, con el original atenuado.'
        : 'La reunión se muestra solo con subtítulos.');
      saveCurrentSettings();
      updateDucking();
    });
  }

  if (duckLevelSelect) {
    duckLevelSelect.addEventListener('change', () => {
      saveCurrentSettings();
      updateDucking();
    });
  }

  if (ttsEngineSelect) {
    ttsEngineSelect.addEventListener('change', () => {
      const isFish = ttsEngineSelect.value === 'fish_audio';
      if (ttsEngineBadge) {
        ttsEngineBadge.textContent = isFish ? '🐟 FISH AUDIO AI' : (ttsEngineSelect.value === 'google_tts' ? 'GOOGLE TTS' : 'WEB SPEECH');
      }
      if (fishAudioPanel) {
        fishAudioPanel.style.display = isFish ? 'flex' : 'none';
      }
      appendLog('ENGINE', `Motor TTS cambiado a: ${ttsEngineSelect.value}`);
      saveCurrentSettings();
    });
  }

  if (fishVoiceSelect) {
    fishVoiceSelect.addEventListener('change', () => {
      const isCustom = fishVoiceSelect.value === 'custom';
      if (fishCustomVoiceGroup) {
        fishCustomVoiceGroup.style.display = isCustom ? 'block' : 'none';
      }
      saveCurrentSettings();
    });
  }

  if (btnToggleFishKey && fishApiKeyInput) {
    btnToggleFishKey.addEventListener('click', () => {
      if (fishApiKeyInput.type === 'password') {
        fishApiKeyInput.type = 'text';
        btnToggleFishKey.textContent = '🔒 Ocultar';
      } else {
        fishApiKeyInput.type = 'password';
        btnToggleFishKey.textContent = '👁️ Ver';
      }
    });
  }

  if (btnVerifyFishKey) {
    btnVerifyFishKey.addEventListener('click', () => {
      validateFishApiKey(true);
    });
  }

  if (btnRefreshFishVoices) {
    btnRefreshFishVoices.addEventListener('click', async () => {
      appendLog('FISH-AUDIO', 'Actualizando lista de voces y modelos...');
      btnRefreshFishVoices.textContent = '⏳';
      await loadFishVoiceModels();
      btnRefreshFishVoices.textContent = '🔄';
    });
  }

  if (btnTestFishVoice) {
    btnTestFishVoice.addEventListener('click', () => {
      testFishVoice();
    });
  }

  if (btnOpenCloneStudio) {
    btnOpenCloneStudio.addEventListener('click', () => {
      openCloneModal();
    });
  }

  if (btnCloseCloneModal) btnCloseCloneModal.addEventListener('click', closeCloneModal);
  if (btnCloseCloneFooter) btnCloseCloneFooter.addEventListener('click', closeCloneModal);

  noiseGateSelect.addEventListener('change', () => {
    updateThresholdLine();
    appendLog('VAD', `Umbral de filtro de ruido actualizado a: ${currentNoiseThreshold}`);
    if (isPipelineRunning && localPair) {
      ipcRenderer.send('LOCAL_AI_CONFIG', { stream: 'mic', vadThreshold: thresholdFromNoiseGate(noiseGateSelect.value) });
    }
    saveCurrentSettings();
  });

  [sourceLangSelect, targetLangSelect, geminiKeyInput, geminiVoiceSelect, groqKeyInput, micInputSelect, virtualCableSelect, localMonitorToggle, translateIncomingToggle, spanishVoiceSelect, fishApiKeyInput, fishVoiceIdInput, fishModelTier, fishLatencyMode].forEach(el => {
    if (!el) return;
    el.addEventListener('change', saveCurrentSettings);
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('input', saveCurrentSettings);
  });

  platformBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      platformBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const platform = btn.getAttribute('data-platform');
      appendLog('PLATFORM', `Plataforma seleccionada: ${platform.toUpperCase()}`);
    });
  });

  // Control 2: Botón Inferior de Pruebas (Independiente)
  btnTestMic?.addEventListener('click', async () => {
    isTestBtnActive = !isTestBtnActive;

    if (isTestBtnActive) {
      btnTestMic.innerHTML = '<span>🛑 Detener Prueba de Voz</span>';
      btnTestMic.classList.add('active-test');
      appendLog('CONTROL', 'Traducción y transcripción ACTIVADA desde botón de pruebas 🎙️');
      if (!isPipelineRunning) {
        await startTranslationPipeline();
      }
    } else {
      btnTestMic.innerHTML = '<span>🎙️ Probar Transcripción y Traducción en Vivo</span>';
      btnTestMic.classList.remove('active-test');
      appendLog('CONTROL', 'Botón de pruebas DETENIDO ⚪');
      if (!isLiveToggleActive && isPipelineRunning) {
        stopTranslationPipeline();
      }
    }
  });

  /** El motor local no puede seguir: el interruptor vuelve a apagado y así queda guardado. */
  function turnOffAfterLocalFailure() {
    toggleActive.checked = false;
    isLiveToggleActive = false;
    updateStatusBadge(false);
    stopTranslationPipeline();
    saveCurrentSettings();
  }

  async function refreshLocalAiStatus() {
    if (!localAiStatus) return;
    try {
      const status = await ipcRenderer.invoke('LOCAL_AI_STATUS');
      localAiStatus.textContent = status.ready
        ? '✅ Modelos listos en este equipo.'
        : `Se descargarán ${(status.missingBytes / 1e6).toFixed(0)} MB la primera vez que lo actives.`;
    } catch (err) {
      localAiStatus.textContent = `No se pudo comprobar el motor local: ${err.message}`;
    }
  }

  function updateEngineGroupsVisibility() {
    const engine = sttEngineSelect.value;
    geminiKeyGroup.style.display = (engine === 'gemini_live' || engine === 'gemini_35_transcribe') ? 'flex' : 'none';
    geminiVoiceGroup.style.display = (engine === 'gemini_live') ? 'flex' : 'none';
    groqKeyGroup.style.display = (engine === 'whisper_groq') ? 'flex' : 'none';
    if (localAiGroup) localAiGroup.style.display = (engine === 'local') ? 'flex' : 'none';
    if (engine === 'local') refreshLocalAiStatus();
  }

  function applySettingsToUI(s) {
    toggleActive.checked = !!s.active;
    isLiveToggleActive = !!s.active;
    updateStatusBadge(!!s.active);
    if (toggleOverlay) {
      toggleOverlay.checked = (s.showOverlay !== undefined) ? !!s.showOverlay : true;
      if (btnToggleOverlayHeader) {
        btnToggleOverlayHeader.style.color = toggleOverlay.checked ? 'var(--apple-blue)' : 'var(--text-secondary)';
      }
    }
    sourceLangSelect.value = s.sourceLang || 'es-ES';
    targetLangSelect.value = s.targetLang || 'en';
    sttEngineSelect.value = s.sttEngine || 'gemini_35_transcribe';
    if (translationModeSelect) translationModeSelect.value = s.translationMode || 'auto';
    if (incomingVoiceToggle) incomingVoiceToggle.checked = !!s.incomingVoice;
    if (duckLevelSelect) duckLevelSelect.value = String(s.duckLevel || 0.05);
    geminiKeyInput.value = s.geminiApiKey || '';
    geminiVoiceSelect.value = s.geminiVoice || 'Puck';
    groqKeyInput.value = s.groqApiKey || '';

    if (ttsEngineSelect && s.ttsEngine) {
      ttsEngineSelect.value = s.ttsEngine;
      if (ttsEngineBadge) {
        ttsEngineBadge.textContent = s.ttsEngine === 'fish_audio' ? '🐟 FISH AUDIO AI' : (s.ttsEngine === 'google_tts' ? 'GOOGLE TTS' : 'WEB SPEECH');
      }
    }
    if (fishApiKeyInput && s.fishApiKey) {
      fishApiKeyInput.value = s.fishApiKey;
    }
    if (fishModelTier && s.fishModel) {
      fishModelTier.value = s.fishModel;
    }
    if (fishLatencyMode && s.fishLatency) {
      fishLatencyMode.value = s.fishLatency;
    }

    if (s.noiseGateThreshold) {
      noiseGateSelect.value = s.noiseGateThreshold;
    }
    if (s.localMonitor !== undefined && localMonitorToggle) {
      localMonitorToggle.checked = !!s.localMonitor;
    }
    if (s.translateIncoming !== undefined && translateIncomingToggle) {
      translateIncomingToggle.checked = !!s.translateIncoming;
    }
    if (s.spanishVoice && spanishVoiceSelect) {
      spanishVoiceSelect.value = s.spanishVoice;
    }
    if (s.spanishVolume !== undefined && spanishVolumeSlider) {
      const vol = parseInt(s.spanishVolume, 10) || 90;
      spanishVolumeSlider.value = vol;
      currentSpanishVolume = Math.max(0.01, Math.min(1.0, vol / 100));
      if (spanishVolumeText) spanishVolumeText.textContent = `${vol}%`;
    }

    updateEngineGroupsVisibility();
  }

  async function saveCurrentSettings() {
    const selectedVoiceId = (fishVoiceSelect && fishVoiceSelect.value === 'custom')
      ? (fishVoiceIdInput ? fishVoiceIdInput.value.trim() : 'default')
      : (fishVoiceSelect ? fishVoiceSelect.value : 'default');

    const newSettings = {
      active: toggleActive.checked,
      showOverlay: toggleOverlay ? toggleOverlay.checked : true,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
      sttEngine: sttEngineSelect.value,
      translationMode: translationModeSelect ? translationModeSelect.value : 'auto',
      incomingVoice: incomingVoiceToggle ? incomingVoiceToggle.checked : false,
      duckLevel: duckLevelSelect ? parseFloat(duckLevelSelect.value) || 0.05 : 0.05,
      ttsEngine: ttsEngineSelect ? ttsEngineSelect.value : 'fish_audio',
      geminiApiKey: geminiKeyInput.value.trim(),
      geminiVoice: geminiVoiceSelect.value,
      groqApiKey: groqKeyInput.value.trim(),
      fishApiKey: fishApiKeyInput ? fishApiKeyInput.value.trim() : '',
      fishVoiceModelId: selectedVoiceId,
      fishModel: fishModelTier ? fishModelTier.value : 's2.1-pro-free',
      fishLatency: fishLatencyMode ? fishLatencyMode.value : 'balanced',
      noiseGateThreshold: parseFloat(noiseGateSelect.value) || 0.016,
      localMonitor: localMonitorToggle ? localMonitorToggle.checked : true,
      translateIncoming: translateIncomingToggle ? translateIncomingToggle.checked : true,
      spanishVoice: spanishVoiceSelect ? spanishVoiceSelect.value : 'auto',
      spanishVolume: spanishVolumeSlider ? parseInt(spanishVolumeSlider.value, 10) : 90,
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

      let hasVirtualCable = false;

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
          hasVirtualCable = true;
        }
        virtualCableSelect.appendChild(option);
      });

      if (hasVirtualCable) {
        if (driverMissingBanner) driverMissingBanner.style.display = 'none';
        if (driverReadyBanner) driverReadyBanner.style.display = 'block';
      } else {
        if (driverMissingBanner) driverMissingBanner.style.display = 'block';
        if (driverReadyBanner) driverReadyBanner.style.display = 'none';
      }

      appendLog('AUDIO', `Detectados: ${audioInputs.length} micrófonos, ${audioOutputs.length} salidas. (Driver VB-Cable: ${hasVirtualCable ? 'LISTO 🟢' : 'NO DETECTADO ⚠️'})`, 'audio');
    } catch (err) {
      appendLog('AUDIO', `Error enumerando dispositivos: ${err.message}`, 'error');
    }
  }

  // ── Controlador Unificado de Sesión de Traducción ─────────────────
  async function startTranslationPipeline() {
    const session = ++pipelineSession;
    isPipelineRunning = true;
    previewBox.style.display = 'flex';
    previewOrig.textContent = '🎙️ Escuchando tu voz con filtro de ruido activo...';
    previewTrans.textContent = '⚡ Traducción simultánea en vivo lista...';

    const engine = sttEngineSelect.value;
    const geminiKey = geminiKeyInput.value.trim();
    const groqKey = groqKeyInput.value.trim();

    appendLog('PIPELINE', `Iniciando motor de traducción: ${engine.toUpperCase()}`);

    if (engine === 'gemini_35_transcribe') {
      if (!geminiKey || geminiKey.length < 5) {
        appendLog('GEMINI', '⚠️ Ingresa tu Gemini API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Gemini en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: aistudio.google.com/app/apikey';
        stopTranslationPipeline();
        return;
      }
      await startUnifiedAudioPipeline('gemini_35_transcribe', geminiKey);
      if (groqKey && groqKey.length > 5) {
        await startIncomingAudioPipeline(groqKey);
      }
    } else if (engine === 'gemini_live') {
      if (!geminiKey || geminiKey.length < 5) {
        appendLog('GEMINI', '⚠️ Ingresa tu Gemini API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Gemini en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: aistudio.google.com/app/apikey';
        stopTranslationPipeline();
        return;
      }
      await startUnifiedAudioPipeline('gemini_live', geminiKey);
      if (groqKey && groqKey.length > 5) {
        await startIncomingAudioPipeline(groqKey);
      }
    } else if (engine === 'whisper_groq') {
      if (!groqKey || groqKey.length < 5) {
        appendLog('GROQ', '⚠️ Ingresa tu Groq API Key en el campo de configuración.', 'warn');
        previewOrig.textContent = '⚠️ Ingresa tu clave de Groq en el campo superior.';
        previewTrans.textContent = 'Obtén tu clave gratis en: console.groq.com/keys';
        stopTranslationPipeline();
        return;
      }
      await startUnifiedAudioPipeline('whisper_groq', groqKey);
      await startIncomingAudioPipeline(groqKey);
    } else if (engine === 'local') {
      localPair = resolvePair(sourceLangSelect.value, targetLangSelect.value);
      if (!localPair) {
        appendLog('LOCAL-AI', '⚠️ El motor local necesita un idioma de origen fijo (Español o Inglés), no Auto.', 'warn');
        previewOrig.textContent = '⚠️ Elige Español o Inglés como idioma de origen.';
        previewTrans.textContent = 'El motor local no detecta el idioma automáticamente.';
        turnOffAfterLocalFailure();
        return;
      }
      previewOrig.textContent = '⏳ Preparando el motor local...';
      const prepared = await ipcRenderer.invoke('LOCAL_AI_PREPARE', {
        vadThreshold: thresholdFromNoiseGate(noiseGateSelect.value)
      });
      // El usuario lo detuvo (o lo detuvo y volvió a arrancar) mientras cargaba: esta llamada ya no manda
      if (session !== pipelineSession || prepared.cancelled) return;
      if (!prepared.ok) {
        appendLog('LOCAL-AI', `No se pudo iniciar el motor local: ${prepared.error}`, 'error');
        previewOrig.textContent = '⚠️ No se pudo iniciar el motor local.';
        previewTrans.textContent = prepared.error;
        turnOffAfterLocalFailure();
        return;
      }
      appendLog('LOCAL-AI', `🟢 Motor local listo en ${prepared.loadMs}ms (${localPair.source.toUpperCase()} ➔ ${localPair.target.toUpperCase()}).`, 'gemini');
      previewOrig.textContent = '🎙️ Escuchando tu voz (motor local)...';
      refreshLocalAiStatus();
      slowDetector.reset();
      await startUnifiedAudioPipeline('local', null);
      await startIncomingAudioPipeline(null, 'local');
    }
  }

  function stopTranslationPipeline() {
    isPipelineRunning = false;
    pipelineSession++;
    localPair = null;
    outputQueue.reset();
    ttsQueue.reset();
    shownLines.clear();
    cloudDownUntil = 0;
    ipcRenderer.send('LOCAL_AI_STOP');
    appendLog('PIPELINE', 'Pipeline de voz detenido.');
    refreshLabInputs();

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
      try { audioContext.close(); } catch (e) { }
      audioContext = null;
    }
    stopIncomingCapture();
    updateDucking();
    if (geminiLiveClient) {
      geminiLiveClient.disconnect();
      geminiLiveClient = null;
    }
    if (pcmPlayer) {
      pcmPlayer.stop();
    }
    if (virtualCablePlayer) {
      virtualCablePlayer.stop();
    }
  }

  // ── Cola de Salida: traducir ➔ subtítulo ➔ voz, sin bloquear la captura ──
  const outputQueue = createOutputQueue({
    onError: (err) => console.warn('[Output Queue] Error:', err)
  });
  // La voz va por su propia cola: el subtítulo de una frase nunca espera a la síntesis de la anterior
  const ttsQueue = createOutputQueue({
    onError: (err) => console.warn('[TTS Queue] Error:', err)
  });
  const MAX_TTS_BACKLOG = 2;
  let localPair = null;
  const slowDetector = createSlowDetector();
  let pipelineSession = 0; // cambia en cada arranque y parada: lo que quedó de una sesión anterior se descarta

  // ── Laboratorio de pruebas: sesión grabada con trazas ──────────────
  let labActive = false;
  let labDir = null;
  let labPhrases = 0;
  let cloudSegmentSeq = 0;

  /** Línea de estado del laboratorio: qué entradas se están grabando de verdad. */
  function refreshLabInputs() {
    if (!labActive || !labStatus) return;
    if (!isPipelineRunning) {
      labStatus.textContent = 'Grabando… falta activar la traducción con el interruptor de arriba.';
      return;
    }
    const meeting = isIncomingListening()
      ? 'reunión (audio del equipo) ✓'
      : '⚠️ la reunión NO se está escuchando: marca «Traducción bidireccional»';
    labStatus.textContent = `Grabando… micrófono ✓ · ${meeting}`;
  }

  /** Envía un evento a la traza de la sesión de prueba (no hace nada si no hay sesión). */
  function trace(type, data) {
    if (labActive) ipcRenderer.send('TRACE_EVENT', { type, data });
  }

  function describeSummary(summary) {
    const names = { mic: 'Tu micrófono', incoming: 'Reunión' };
    const lines = [];
    for (const [name, s] of Object.entries(summary.streams)) {
      lines.push(`${names[name] || name}: ${s.phrases} frases, ${(s.audioMs / 1000).toFixed(1)} s de voz`);
      lines.push(`  Transcripción: media ${s.stt.avg} ms (máx. ${s.stt.max} ms)`);
      lines.push(`  Traducción: media ${s.translate.avg} ms (máx. ${s.translate.max} ms)`);
      lines.push(`  Fin de voz ➔ subtítulo: media ${s.endToEnd.avg} ms (máx. ${s.endToEnd.max} ms)`);
      if (s.untranslated > 0) lines.push(`  Sin traducir: ${s.untranslated}`);
    }
    if (lines.length === 0) lines.push('No se oyó ninguna frase.');
    lines.push(`Errores: ${summary.errors} · Frases marcadas: ${summary.flags.length} · Audios guardados: ${summary.audioFiles}`);
    if (summary.echoesDropped > 0) lines.push(`Frases del micrófono descartadas por ser eco de la reunión: ${summary.echoesDropped}`);
    return lines.join('\n');
  }

  async function startLabSession() {
    const started = await ipcRenderer.invoke('TRACE_START', {
      saveAudio: labSaveAudio ? labSaveAudio.checked : true,
      meta: {
        motorSTT: sttEngineSelect.value,
        traduccion: translationModeSelect ? translationModeSelect.value : 'auto',
        idiomaOrigen: sourceLangSelect.value,
        idiomaDestino: targetLangSelect.value,
        traducirReunion: translateIncomingToggle ? translateIncomingToggle.checked : false,
        sensibilidad: noiseGateSelect.value,
        microfono: micInputSelect.selectedOptions[0] ? micInputSelect.selectedOptions[0].textContent : 'predeterminado'
      }
    });
    labActive = true;
    labDir = started.dir;
    labPhrases = 0;
    labToggleText.textContent = '⏹ Terminar sesión y generar informe';
    labToggleBtn.classList.add('recording');
    refreshLabInputs();
    labNote.disabled = false;
    labFlagBtn.disabled = false;
    labSummary.style.display = 'none';
    appendLog('LAB', `🧪 Sesión de prueba iniciada: ${labDir}`, 'control');
  }

  async function stopLabSession() {
    labActive = false;
    const result = await ipcRenderer.invoke('TRACE_STOP');
    labToggleText.textContent = '⏺ Iniciar sesión de prueba';
    labToggleBtn.classList.remove('recording');
    labNote.disabled = true;
    labFlagBtn.disabled = true;
    if (!result) {
      labStatus.textContent = 'Sin sesión en curso.';
      return;
    }
    labStatus.textContent = `Informe guardado en ${result.dir}`;
    labSummary.textContent = describeSummary(result.summary);
    labSummary.style.display = 'block';
    appendLog('LAB', `🧪 Sesión de prueba terminada. Informe: ${result.dir}`, 'control');
  }

  if (labToggleBtn) {
    labToggleBtn.addEventListener('click', async () => {
      labToggleBtn.disabled = true;
      try {
        if (labActive) await stopLabSession(); else await startLabSession();
      } catch (err) {
        labStatus.textContent = `No se pudo cambiar la sesión de prueba: ${err.message}`;
      } finally {
        labToggleBtn.disabled = false;
      }
    });
  }

  if (labFlagBtn) {
    labFlagBtn.addEventListener('click', async () => {
      const flagged = await ipcRenderer.invoke('TRACE_FLAG', labNote.value.trim());
      if (!flagged) return;
      labStatus.textContent = flagged.text ? `🚩 Marcada: «${flagged.text}»` : '🚩 Nota guardada (aún no se había oído ninguna frase).';
      labNote.value = '';
    });
  }

  if (labOpenBtn) {
    labOpenBtn.addEventListener('click', () => ipcRenderer.send('TRACE_OPEN', labDir));
  }

  const MAX_CONVERSATION_ROWS = 200;

  /** Añade la frase al historial y la pinta al final de la lista, sin mover la vista si el usuario está releyendo arriba. */
  function recordConversation({ direction, from, to, original, translated }) {
    const entry = conversationLog.add({ direction, from, to, original, translated });
    if (!entry || !conversationLogEl) return null;
    if (conversationEmptyEl) conversationEmptyEl.remove();

    const atBottom = conversationLogEl.scrollHeight - conversationLogEl.scrollTop - conversationLogEl.clientHeight < 40;
    const row = document.createElement('div');
    row.className = `conversation-row ${entry.direction}`;
    const meta = document.createElement('span');
    meta.className = 'conv-meta';
    meta.textContent = `${entry.time} · ${entry.speaker} · ${entry.from} ➔ ${entry.to}`;
    const translatedEl = document.createElement('span');
    translatedEl.className = 'conv-translated';
    translatedEl.textContent = entry.translated;
    const originalEl = document.createElement('span');
    originalEl.className = 'conv-original';
    originalEl.textContent = entry.original || '…';
    row.append(meta, translatedEl, originalEl);
    conversationLogEl.appendChild(row);

    while (conversationLogEl.children.length > MAX_CONVERSATION_ROWS) conversationLogEl.firstElementChild.remove();
    if (atBottom) conversationLogEl.scrollTop = conversationLogEl.scrollHeight;
    return { entry, originalEl, translatedEl };
  }

  // ── Líneas de subtítulo: una por frase ─────────────────────────────
  // El motor local traduce al instante (Bergamot); si hay red, la nube mejora la línea después, y los trozos de una
  // misma frase la reescriben con la frase entera. Cada línea recuerda qué texto tradujo, para no aplicar tarde una
  // traducción de un texto que ya creció.
  const shownLines = new Map(); // lineId → { n, originalEl, translatedEl, source, direction, prefix }
  const MAX_SHOWN_LINES = 50;
  const VOICE_WAIT_MS = 1500; // lo que la voz espera a la traducción de la nube antes de usar la local
  const CLOUD_RETRY_MS = 30000;
  let cloudDownUntil = 0;

  /** Traducción siempre local o sin red: nada se manda a la nube. */
  function useDirectTranslation() {
    return (translationModeSelect && translationModeSelect.value === 'local') || !navigator.onLine;
  }

  function cloudAllowed() {
    return !useDirectTranslation() && Date.now() >= cloudDownUntil;
  }

  /** Muestra una línea nueva o reescribe la de `lineId` (subtítulo flotante e historial). */
  function showLine({ lineId, replace, grows = false, direction, subtitleDirection, from, to, original, translated, prefix = '' }) {
    const known = lineId !== null && lineId !== undefined ? shownLines.get(lineId) : null;
    if (replace && known) {
      known.source = original;
      conversationLog.update(known.n, { original, translated });
      known.originalEl.textContent = original || '…';
      known.translatedEl.textContent = translated;
    } else {
      const shown = recordConversation({ direction, from, to, original, translated });
      if (shown && lineId !== null && lineId !== undefined) {
        shownLines.set(lineId, { n: shown.entry.n, originalEl: shown.originalEl, translatedEl: shown.translatedEl, source: original, direction: subtitleDirection, prefix });
        while (shownLines.size > MAX_SHOWN_LINES) shownLines.delete(shownLines.keys().next().value);
      }
    }
    ipcRenderer.send('DISPLAY_SUBTITLE', {
      originalText: original ? `${prefix}${original}` : '',
      translatedText: translated,
      direction: subtitleDirection,
      isFinal: true,
      lineId,
      replace: !!(replace && known),
      grows: !!(grows && known)
    });
  }

  /**
   * Pide a la nube (LLM + Google) una traducción mejor de la línea y la aplica si la línea no ha cambiado.
   * Devuelve la traducción de la nube, o null si no llegó.
   */
  async function refineLine({ lineId, source, sourceLang, targetLang, current, segmentId, stream }) {
    const started = Date.now();
    let res = null;
    try {
      res = await ipcRenderer.invoke('TRANSLATE_TEXT', { text: source, sourceLang, targetLang });
    } catch (err) {
      res = null;
    }
    const translated = res && res.engine !== 'none' && res.translated ? res.translated.trim() : '';
    if (!translated) {
      cloudDownUntil = Date.now() + CLOUD_RETRY_MS; // sin nube por ahora: las siguientes frases no la esperan
      return null;
    }
    trace('refine', { segmentId, lineId, stream, engine: res.engine, translateMs: Date.now() - started, original: source, translated });
    const line = shownLines.get(lineId);
    if (translated === current) appendLog('TRANSLATE', `✔️ La nube [${res.engine}] coincide con la traducción local.`, 'translate');
    if (line && line.source === source && translated !== current) {
      showLine({ lineId, replace: true, direction: stream === 'mic' ? 'outgoing' : 'incoming', subtitleDirection: line.direction, original: source, translated, prefix: line.prefix });
      previewTrans.textContent = `✨ ${translated}`;
      appendLog('TRANSLATE', `✨ Mejorada en la nube en ${Date.now() - started}ms [${res.engine}]: "${translated}"`, 'translate');
    }
    return translated;
  }

  /** El texto de la nube si llega antes de `ms`; si no, el local. */
  async function bestWithin(promise, ms, fallback) {
    if (!promise) return fallback;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
    const better = await Promise.race([promise, timeout]);
    return better || fallback;
  }

  /** Frases cuya voz aún no ha terminado de salir: síntesis pendientes más audio en cola del cable virtual. */
  function pendingSpeech() {
    const cable = (virtualCablePlayer && virtualCablePlayer.audioQueue) ? virtualCablePlayer.audioQueue.length : 0;
    return ttsQueue.size() + cable;
  }

  function speakOrSkip(speak, onDone, { meeting = false } = {}) {
    if (!meeting && labActive && labMuteVoice && labMuteVoice.checked) {
      trace('tts', { muted: true });
      onDone(0);
      return;
    }
    const waiting = pendingSpeech();
    if (waiting >= MAX_TTS_BACKLOG) {
      appendLog('TTS', `⏭️ Voz omitida (${waiting} frases por sonar): se muestra solo el subtítulo.`, 'warn');
      trace('tts', { skipped: true, waiting });
      onDone(0);
      return;
    }
    ttsQueue.push(async () => {
      const ttsRes = await speak();
      trace('tts', { ms: (ttsRes && ttsRes.elapsedMs) || 0 });
      onDone((ttsRes && ttsRes.elapsedMs) || 0);
    });
  }

  const translateText = createTranslateRouter({
    cloud: (req) => ipcRenderer.invoke('TRANSLATE_TEXT', req),
    local: (req) => ipcRenderer.invoke('LOCAL_AI_TRANSLATE', req),
    isOnline: () => navigator.onLine,
    getMode: () => (translationModeSelect ? translationModeSelect.value : 'auto')
  });

  /** Traza de una frase ya traducida (o no): con motores en la nube también se registra la frase oída. */
  function traceTranslation({ stream, lang, segmentId, text, sttElapsed, voiceDurationMs, speechStart, translation, transElapsed, line = null }) {
    if (!labActive) return;
    let id = segmentId;
    if (id === null) {
      id = `nube-${++cloudSegmentSeq}`;
      trace('segment', { id, stream, lang, text, durationMs: voiceDurationMs, sttMs: sttElapsed });
    }
    const translated = (translation && translation.translated ? translation.translated.trim() : '');
    trace('translation', {
      segmentId: id,
      stream,
      engine: (translation && translation.engine) || 'nube',
      translateMs: transElapsed,
      endToEndMs: translated ? Math.max(0, Date.now() - (speechStart + voiceDurationMs)) : 0,
      original: text,
      translated,
      error: (translation && translation.error) || null,
      join: line && line.translated ? { lineId: line.lineId, text: line.text, translated: line.translated } : undefined
    });
    labPhrases++;
    if (labStatus) {
      const warning = isIncomingListening() ? '' : ' · ⚠️ la reunión NO se está escuchando';
      labStatus.textContent = `Grabando… ${labPhrases} frases · última traducción ${transElapsed} ms${warning}`;
    }
  }

  /**
   * Qué mostrar de una frase ya traducida: la línea (la frase entera si este trozo continúa otra) y, si hay red,
   * la mejora de la nube. Devuelve la promesa de la nube para que la voz pueda esperarla.
   */
  function presentLine({ stream, segmentId, line, translation, pair, subtitleDirection, from, to, prefix, silent }) {
    const translatedText = translation.translated.trim();
    // Un trozo que continúa una frase reescribe su línea, si el motor tradujo la frase entera
    const joined = !!(line && line.translated);
    const lineId = joined ? line.lineId : segmentId;
    const lineSource = joined ? line.text : translation.original;
    const lineTranslated = joined ? line.translated : translatedText;
    showLine({ lineId, replace: joined, grows: joined, direction: stream === 'mic' ? 'outgoing' : 'incoming', subtitleDirection, from, to, original: lineSource, translated: lineTranslated, prefix });
    previewTrans.textContent = `✨ ${lineTranslated}`;

    // Traducción local con red: la nube mejora la línea (subtítulo) y, si llega a tiempo, la voz
    const local = translation.engine === 'local' && segmentId !== null && pair;
    const refine = local && !silent && cloudAllowed() && lineSource
      ? refineLine({ lineId, source: lineSource, sourceLang: pair.source, targetLang: pair.target, current: lineTranslated, segmentId, stream })
      : null;
    return { joined, refine };
  }

  async function deliverOutgoing({ recognizedText, sttElapsed, voiceDurationMs, userSpeechStart, segmentId = null, pair = null, silent = false, preTranslated = null, line = null }) {
    const transStart = Date.now();
    const translation = preTranslated
      ? { original: recognizedText, translated: preTranslated.text, detectedLang: pair.source, targetLang: pair.target, elapsedMs: preTranslated.ms, engine: 'local' }
      : await translateText({
        text: recognizedText,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value,
        segmentId,
        pair
      });
    const transElapsed = (translation && translation.elapsedMs) || (Date.now() - transStart);
    traceTranslation({
      stream: 'mic', lang: (pair && pair.source) || sourceLangSelect.value.substring(0, 2), segmentId, text: recognizedText,
      sttElapsed, voiceDurationMs, speechStart: userSpeechStart, translation, transElapsed, line
    });
    if (!translation || !translation.translated || !translation.translated.trim()) {
      if (translation && translation.error) appendLog('TRANSLATE', `⚠️ Sin traducción para "${recognizedText}": ${translation.error}`, 'warn');
      return;
    }

    const translatedText = translation.translated.trim();
    const isTargetSpanish = (translation.targetLang === 'es');
    appendLog('TRANSLATE', `Traducido en ${transElapsed}ms [${translation.engine || 'nube'}] (${isTargetSpanish ? 'Inglés ➔ Español' : 'Español ➔ Inglés'}): "${translatedText}"`, 'translate');

    const { joined, refine } = presentLine({
      stream: 'mic', segmentId, line, translation, pair,
      subtitleDirection: isTargetSpanish ? 'incoming' : 'outgoing',
      from: isTargetSpanish ? 'en' : 'es', to: isTargetSpanish ? 'es' : 'en', prefix: '', silent
    });

    if (silent) return; // frase cerrada al detener: solo subtítulo
    speakOrSkip(
      async () => {
        // La voz dice este trozo: la mejora de la nube si llega a tiempo (solo si el trozo es la línea entera)
        const spoken = joined ? translatedText : await bestWithin(refine, VOICE_WAIT_MS, translatedText);
        return isTargetSpanish ? speakSpanishToUser(spoken) : playAudioToVirtualCableAndSpeakers(spoken, 'en');
      },
      (ttsElapsed) => {
        const totalPipelineMs = Date.now() - userSpeechStart;
        appendLog('LATENCIA', `⏱️ Total: ${(totalPipelineMs / 1000).toFixed(2)}s ➔ [Voz: ${voiceDurationMs}ms] [STT: ${sttElapsed}ms] [Trad: ${transElapsed}ms] [TTS: ${ttsElapsed}ms]`, 'control');
      }
    );
  }

  async function deliverIncoming({ text, sttElapsed, voiceDurationMs, speechStartTime, segmentId = null, silent = false, preTranslated = null, line = null }) {
    const transStart = Date.now();
    const translation = preTranslated
      ? { original: text, translated: preTranslated.text, detectedLang: 'en', targetLang: 'es', elapsedMs: preTranslated.ms, engine: 'local' }
      : await translateText({
        text,
        sourceLang: 'en',
        targetLang: 'es',
        segmentId,
        pair: segmentId === null ? null : { source: 'en', target: 'es' }
      });
    const transElapsed = (translation && translation.elapsedMs) || (Date.now() - transStart);
    traceTranslation({
      stream: 'incoming', lang: 'en', segmentId, text,
      sttElapsed, voiceDurationMs, speechStart: speechStartTime, translation, transElapsed, line
    });
    if (!translation || !translation.translated || !translation.translated.trim()) {
      if (translation && translation.error) appendLog('RECEPTOR', `⚠️ Sin traducción para "${text}": ${translation.error}`, 'warn');
      return;
    }

    const translatedText = translation.translated.trim();

    // Si el audio capturado del receptor ya era español (ej. eco de los altavoces), descartar para evitar bucles
    if (translation.detectedLang === 'es' || (text && text.toLowerCase() === translatedText.toLowerCase())) {
      appendLog('RECEPTOR', `🔇 Eco de altavoces filtrado: "${text}"`, 'warn');
      return;
    }

    appendLog('RECEPTOR', `✨ Traducido a Español en ${transElapsed}ms [${translation.engine || 'nube'}]: "${translatedText}"`, 'translate');
    previewOrig.textContent = `👤 Receptor (Inglés): ${(line && line.translated ? line.text : text) || '…'}`;
    const { joined, refine } = presentLine({
      stream: 'incoming', segmentId, line, translation, pair: { source: 'en', target: 'es' },
      subtitleDirection: 'incoming', from: 'en', to: 'es', prefix: 'Receptor: ', silent
    });

    // Por defecto la reunión va solo con subtítulos: sin voz no hay pausas al escuchar ni frases perdidas
    if (silent || !(incomingVoiceToggle && incomingVoiceToggle.checked)) return;
    // Un ruido transcrito como una sílaba no se lee en voz alta
    if (!/[\p{L}\p{N}]{2,}/u.test(text || '')) {
      appendLog('TTS', '⏭️ Voz omitida: no se oyó una frase clara.', 'warn');
      return;
    }
    speakOrSkip(
      async () => {
        const spoken = joined ? translatedText : await bestWithin(refine, VOICE_WAIT_MS, translatedText);
        return speakSpanishToUser(spoken, { inProcessOnly: incomingExcludesOwnAudio, waitForEnd: true });
      },
      (ttsElapsed) => {
        const totalChainMs = Date.now() - speechStartTime;
        appendLog('LATENCIA', `⏱️ Total Receptor: ${(totalChainMs / 1000).toFixed(2)}s ➔ [Voz: ${voiceDurationMs}ms] [STT: ${sttElapsed}ms] [Trad: ${transElapsed}ms] [TTS: ${ttsElapsed}ms]`, 'control');
      },
      { meeting: true }
    );
  }

  ipcRenderer.on('LOCAL_AI_EVENT', (event, msg) => {
    if (msg.type === 'progress') {
      const pct = Math.floor((msg.overallLoaded / msg.overallTotal) * 100);
      const text = `⏬ Descargando modelos del motor local: ${pct}%`;
      if (localAiStatus) localAiStatus.textContent = text;
      if (isPipelineRunning) previewOrig.textContent = text;
      return;
    }
    if (msg.type === 'error') {
      appendLog('LOCAL-AI', msg.message, msg.fatal ? 'error' : 'warn');
      if (msg.fatal && isPipelineRunning) {
        previewOrig.textContent = `⚠️ ${msg.message}`;
        turnOffAfterLocalFailure();
      }
      return;
    }
    if (msg.type === 'echo') {
      appendLog('MIC', `🔇 Descartado: el micrófono oyó la reunión por los parlantes (${msg.durationMs} ms).`, 'warn');
      return;
    }
    if (msg.type === 'noise') {
      appendLog(msg.stream === 'mic' ? 'MIC' : 'RECEPTOR', `🔇 Descartado: ruido oído como «${msg.text}» (${msg.durationMs} ms).`, 'warn');
      return;
    }

    // Tras detener solo se acepta la frase que estaba en curso (llega marcada como tardía)
    if (!isPipelineRunning && !(msg.type === 'segment' && msg.late)) return;

    if (msg.type === 'vad') {
      if (msg.stream === 'incoming') ipcRenderer.send('DISPLAY_SPEECH_STATE', { speaking: msg.speaking });
      return;
    }

    // Texto provisional de lo que la reunión aún está diciendo: se muestra ya y la frase completa lo sustituye
    if (msg.type === 'partial') {
      if (msg.stream !== 'incoming') return;
      if (msg.translated) {
        if (msg.heard) previewOrig.textContent = `👤 Receptor (Inglés): ${msg.heard} …`;
        previewTrans.textContent = `✨ ${msg.text} …`;
        ipcRenderer.send('DISPLAY_SUBTITLE', { originalText: msg.heard ? `Receptor: ${msg.heard}` : '', translatedText: msg.text, direction: 'incoming', isFinal: false });
      } else {
        previewOrig.textContent = `👤 Receptor (Inglés): ${msg.text} …`;
      }
      return;
    }

    if (msg.type === 'segment') {
      const startedAt = Date.now() - msg.durationMs - (msg.sttMs || 0) - (msg.translateMs || 0);
      // El par vigente al oír la frase, no el que haya cuando le toque en la cola; tras detener se deduce del idioma oído
      const pair = localPair || resolvePair(msg.lang, 'auto');
      const silent = !!msg.late;
      const preTranslated = msg.translated ? { text: msg.translated, ms: msg.translateMs } : null;
      const line = msg.join || null;
      if (slowDetector.observe(msg)) {
        appendLog('LOCAL-AI', '⚠️ Este equipo transcribe más lento de lo que hablas y el retraso se irá acumulando. Prueba un motor en la nube.', 'warn');
      }
      if (msg.stream === 'mic') {
        appendLog('VOICE', `Reconocido (Motor local) en ${msg.sttMs}ms: "${msg.text}"`, 'audio');
        previewOrig.textContent = `🎙️ ${line && line.translated ? line.text : msg.text}`;
        outputQueue.push(() => deliverOutgoing({
          recognizedText: msg.text, sttElapsed: msg.sttMs, voiceDurationMs: msg.durationMs,
          userSpeechStart: startedAt, segmentId: msg.id, pair, silent, preTranslated, line
        }));
      } else {
        appendLog('RECEPTOR', `Inglés (Motor local) en ${msg.sttMs}ms: "${msg.text}"`, 'audio');
        outputQueue.push(() => deliverIncoming({
          text: msg.text, sttElapsed: msg.sttMs, voiceDurationMs: msg.durationMs,
          speechStartTime: startedAt, segmentId: msg.id, silent, preTranslated, line
        }));
      }
    }
  });

  function stopIncomingCapture() {
    incomingExcludesOwnAudio = false;
    if (incomingMediaStream) {
      incomingMediaStream.getTracks().forEach(t => t.stop());
      incomingMediaStream = null;
    }
    if (incomingAudioContext) {
      try { incomingAudioContext.close(); } catch (e) { }
      incomingAudioContext = null;
    }
  }

  /**
   * Mientras se lee la traducción en voz alta, los demás programas (la reunión, el vídeo) suenan bajito.
   * Solo si la captura excluye el sonido de esta app: si no, la voz traducida se colaría en lo que se transcribe.
   */
  let duckingRequest = 0;
  async function updateDucking() {
    const request = ++duckingRequest;
    const level = duckLevelSelect ? parseFloat(duckLevelSelect.value) : 0.05;
    const wanted = isPipelineRunning && isIncomingListening() && incomingExcludesOwnAudio
      && incomingVoiceToggle && incomingVoiceToggle.checked && level > 0 && level < 1;
    if (!wanted) {
      incomingLevel = createLevelCompensator({ maxGain: 1 });
      try { await ipcRenderer.invoke('AUDIO_UNDUCK'); } catch (e) { /* proceso principal sin este canal */ }
      return;
    }
    let result = { active: false, level: 1 };
    try {
      result = await ipcRenderer.invoke('AUDIO_DUCK', { level });
    } catch (e) {
      console.warn('[Ducking] No disponible:', e);
    }
    if (request !== duckingRequest) return; // llegó otra orden mientras tanto
    incomingLevel = createLevelCompensator({ maxGain: result.active ? 1 / result.level : 1 });
    appendLog('AUDIO', result.active
      ? `🔉 El audio original suena al ${Math.round(result.level * 100)} % mientras se lee la traducción.`
      : '⚠️ No se pudo bajar el volumen del audio original (solo disponible en Windows).', result.active ? 'audio' : 'warn');
  }

  /** Arranca la escucha de la reunión con el motor que esté en uso (lo mismo que hace el arranque general). */
  async function startIncomingForCurrentEngine() {
    const engine = sttEngineSelect.value;
    const groqKey = groqKeyInput.value.trim();
    if (engine === 'local') {
      await startIncomingAudioPipeline(null, 'local');
    } else if (groqKey && groqKey.length > 5) {
      await startIncomingAudioPipeline(groqKey);
    } else {
      appendLog('AUDIO', '⚠️ Para traducir la reunión con este motor hace falta la clave de Groq.', 'warn');
    }
  }

  /** ¿Se está escuchando el audio de la reunión ahora mismo? */
  function isIncomingListening() {
    return !!incomingMediaStream;
  }

  // La casilla surte efecto al momento: antes solo se leía al activar la traducción
  if (translateIncomingToggle) {
    translateIncomingToggle.addEventListener('change', async () => {
      if (!isPipelineRunning) return;
      if (translateIncomingToggle.checked) {
        if (!isIncomingListening()) await startIncomingForCurrentEngine();
      } else {
        stopIncomingCapture();
        updateDucking();
        ipcRenderer.send('LOCAL_AI_FLUSH', { stream: 'incoming' });
        appendLog('AUDIO', 'Traducción del receptor DETENIDA: ya no se escucha el audio de la reunión.', 'audio');
      }
      refreshLabInputs();
    });
  }

  // ── Pipeline para Traducir la Voz del Receptor (Reunión ➔ Español) ──
  async function startIncomingAudioPipeline(apiKey, engineType = 'groq') {
    if (!translateIncomingToggle || !translateIncomingToggle.checked) {
      appendLog('AUDIO', 'Traducción del receptor desactivada por configuración.');
      if (labActive) appendLog('LAB', '⚠️ La reunión no se está escuchando: marca «Traducción bidireccional» para grabar el audio del equipo.', 'warn');
      refreshLabInputs();
      return;
    }

    try {
      appendLog('AUDIO', `Iniciando captura de audio del receptor (${engineType === 'local' ? 'Motor local' : (engineType === 'gemini_35' ? 'Gemini 3.5 Transcribe' : 'Groq Whisper')})...`, 'audio');

      let sourceId = await ipcRenderer.invoke('GET_DESKTOP_AUDIO_SOURCE');
      if (!sourceId) {
        const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES');
        if (sources && sources.length > 0) {
          sourceId = sources[0].id;
        }
      }
      if (!sourceId) {
        appendLog('AUDIO', 'No se detectó fuente de audio de pantalla/escritorio.', 'warn');
        return;
      }
      // Preferido: el audio del equipo SIN el sonido de esta app, para poder leer la traducción en voz alta
      // sin que la app se oiga a sí misma. Si esta versión de Electron no lo admite, se usa la captura completa.
      incomingMediaStream = null;
      incomingExcludesOwnAudio = false;
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { restrictOwnAudio: true } });
        const audioTrack = display.getAudioTracks()[0];
        if (audioTrack && audioTrack.getSettings().restrictOwnAudio === true) {
          display.getVideoTracks().forEach(t => t.stop()); // solo interesa el audio
          incomingMediaStream = display;
          incomingExcludesOwnAudio = true;
        } else {
          display.getTracks().forEach(t => t.stop());
        }
      } catch (e) {
        console.warn('[Incoming] Captura sin audio propio no disponible:', e);
      }

      if (!incomingMediaStream) {
        incomingMediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          }
        });
      }
      appendLog('AUDIO', incomingExcludesOwnAudio
        ? 'Captura de la reunión sin el sonido de esta app: la traducción puede leerse en voz alta sin pausas.'
        : 'Captura de la reunión con todo el audio del equipo (incluye el de esta app).', 'audio');

      // Mantener activo el stream completo para que Chromium no desactive el loopback de audio del sistema

      incomingAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const incomingSource = incomingAudioContext.createMediaStreamSource(incomingMediaStream);
      incomingScriptProcessor = incomingAudioContext.createScriptProcessor(2048, 1, 1);

      const muteGain = incomingAudioContext.createGain();
      muteGain.gain.value = 0;
      incomingScriptProcessor.connect(muteGain);
      muteGain.connect(incomingAudioContext.destination);

      let incomingSamplesBuffer = [];
      let incomingSpeechHold = 0;
      let isTranscribingIncoming = false;
      let incomingEchoBlocked = false;

      incomingScriptProcessor.onaudioprocess = async (e) => {
        if (!isPipelineRunning) return;

        // Los demás programas están atenuados y así llegan a la captura: se devuelve su nivel antes de transcribir
        const inputData = incomingLevel.process(e.inputBuffer.getChannelData(0));

        if (engineType === 'local') {
          // Si la captura incluye el sonido de esta app, la voz en español entraría y crearía un bucle: se pausa
          if (!incomingExcludesOwnAudio && (isAppSpeaking || (Date.now() - lastAppSpeakingEndTime < 450))) {
            if (!incomingEchoBlocked) {
              incomingEchoBlocked = true;
              ipcRenderer.send('LOCAL_AI_FLUSH', { stream: 'incoming' });
            }
            return;
          }
          incomingEchoBlocked = false;
          ipcRenderer.send('LOCAL_AI_AUDIO', {
            stream: 'incoming',
            lang: 'en',
            target: 'es',
            partial: true,
            at: Date.now(),
            samples: new Float32Array(inputData)
          });
          return;
        }

        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);

        // Umbral sensible para capturar la voz del receptor en Google Meet
        const incomingThreshold = 0.002;

        let isIncomingSpeaking = false;
        let incomingSpeechStart = 0;

        if (rms >= incomingThreshold) {
          if (!isIncomingSpeaking) {
            isIncomingSpeaking = true;
            incomingSpeechStart = Date.now();
            appendLog('RECEPTOR', `🎙️ Voz del receptor en Google Meet detectada [${new Date().toLocaleTimeString()}]...`, 'audio');
          }
          incomingSpeechHold = 4; // ~512ms de retención para corte rápido
          ipcRenderer.send('DISPLAY_SPEECH_STATE', { speaking: true });
          for (let i = 0; i < inputData.length; i++) {
            incomingSamplesBuffer.push(inputData[i]);
          }
        } else {
          if (incomingSpeechHold > 0) {
            incomingSpeechHold--;
            for (let i = 0; i < inputData.length; i++) {
              incomingSamplesBuffer.push(inputData[i]);
            }
            if (incomingSpeechHold === 0) {
              ipcRenderer.send('DISPLAY_SPEECH_STATE', { speaking: false });
              isIncomingSpeaking = false;
            }
          } else {
            // Descartar fragmentos de ruido aislados que no alcancen duración mínima de habla (~300ms = 4800 muestras)
            if (incomingSamplesBuffer.length > 0 && incomingSamplesBuffer.length < 4800) {
              incomingSamplesBuffer = [];
            }
          }
        }

        // Procesar si terminó la frase (pausa natural con buffer >= 4800) O si alcanzó ~4.5s continuos (72000 muestras)
        const shouldProcess = (incomingSpeechHold === 0 && incomingSamplesBuffer.length >= 4800) || (incomingSamplesBuffer.length > 72000);

        if (shouldProcess && !isTranscribingIncoming && apiKey) {
          const samples = new Float32Array(incomingSamplesBuffer);
          const voiceDurationMs = Math.round(samples.length / 16);
          const speechStartTime = incomingSpeechStart || (Date.now() - voiceDurationMs);
          incomingSamplesBuffer = [];
          isIncomingSpeaking = false;

          // Comprobar si el búfer tiene suficiente energía promedio (no solo un clic o estática)
          let energySum = 0;
          for (let i = 0; i < samples.length; i++) {
            energySum += samples[i] * samples[i];
          }
          const avgRms = Math.sqrt(energySum / samples.length);
          if (avgRms < 0.001) {
            return;
          }

          isTranscribingIncoming = true;

          try {
            const wavBuffer = encodeWAV(samples, 16000);
            const wavBase64 = arrayBufferToBase64(wavBuffer);

            const sttStart = Date.now();
            let result = null;
            if (engineType === 'gemini_35') {
              const glossaryList = (typeof DEFAULT_GLOSSARY !== 'undefined') ? Object.values(DEFAULT_GLOSSARY) : [];
              appendLog('GEMINI', `⚡ Enviando audio receptor (${voiceDurationMs}ms) a Gemini STT...`, 'gemini');
              result = await ipcRenderer.invoke('TRANSCRIBE_GEMINI_35', {
                audioBase64: wavBase64,
                apiKey,
                language: 'en',
                customVocabulary: glossaryList,
                format: 'wav'
              });
            } else {
              appendLog('GROQ', `⚡ Enviando audio receptor (${voiceDurationMs}ms) a Groq Whisper...`, 'audio');
              result = await ipcRenderer.invoke('TRANSCRIBE_GROQ', {
                audioBase64: wavBase64,
                apiKey,
                language: 'en',
                prompt: 'Conversational English in a live business meeting. Transcribe complete, coherent sentences with proper punctuation.',
                format: 'wav'
              });
            }

            const sttElapsed = (result && result.elapsedMs) || (Date.now() - sttStart);

            if (result && result.text && result.text.trim()) {
              const text = result.text.trim();
              if (!isWhisperHallucination(text)) {
                const modelTag = (result && result.model) ? result.model : (engineType === 'gemini_35' ? 'Gemini 3.5' : 'Groq');
                appendLog('RECEPTOR', `Inglés (${modelTag}) en ${sttElapsed}ms: "${text}"`, 'audio');
                outputQueue.push(() => deliverIncoming({
                  text, sttElapsed, voiceDurationMs, speechStartTime
                }));
              }
            }
          } catch (err) {
            console.warn('[Incoming Audio Process] Error:', err);
          } finally {
            isTranscribingIncoming = false;
          }
        }
      };

      incomingSource.connect(incomingScriptProcessor);
      appendLog('AUDIO', 'Traducción bidireccional del receptor (Inglés ➔ Español) ACTIVADA 🎧', 'audio');
      refreshLabInputs();
      updateDucking();

    } catch (err) {
      appendLog('AUDIO', `Aviso de captura de audio del receptor: ${err.message}`, 'warn');
    }
  }

  // ── Pipeline Unificado con VAD, Filtrado de Ruido y Soporte Dual ──
  async function startUnifiedAudioPipeline(engine, apiKey) {
    try {
      // 1. Inicializar WebSocket para Gemini Live (Modo Audio-to-Audio) si aplica
      if (engine === 'gemini_live') {
        await pcmPlayer.init(virtualCableSelect.value);

        geminiLiveClient = new GeminiLiveClient({
          apiKey,
          mode: 'translate_audio',
          voiceName: geminiVoiceSelect.value,
          sourceLang: sourceLangSelect.value,
          targetLang: targetLangSelect.value,
          onOpen: () => {
            appendLog('GEMINI', '🟢 Conexión con Gemini Live establecida con éxito.', 'gemini');
          },
          onInterrupted: () => {
            appendLog('GEMINI', '⚡ Voz simultánea detectada en flujo continuo...', 'gemini');
            if (pcmPlayer) pcmPlayer.clearQueue();
          },
          onAudioReceived: (rawBytes) => {
            pcmPlayer.feedPcm(rawBytes);
            const now = Date.now();
            if (now - lastAudioLogTime > 2000) {
              lastAudioLogTime = now;
              appendLog('AUDIO', `Reproduciendo voz traducida en tiempo real (PCM 24kHz)...`, 'audio');
            }
            previewTrans.textContent = '🔊 Transmitiendo voz traducida al inglés en vivo...';
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
      } else if (engine === 'gemini_35_transcribe') {
        appendLog('GEMINI', '🟢 Motor Gemini 3.5 Transcribe STT inicializado y listo.', 'gemini');
      }

      // 2. Captura de audio del micrófono con DSP WebRTC nativo
      const micDeviceId = micInputSelect.value;
      try {
        micMediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: (micDeviceId && micDeviceId !== 'default') ? { ideal: micDeviceId } : undefined,
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (e1) {
        console.warn('[Microphone] Usando fallback de captura directa:', e1);
        micMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      appendLog('AUDIO', `Micrófono capturado con Supresión de Ruido y Cancelación de Eco (${engine.toUpperCase()}).`, 'audio');

      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(micMediaStream);
      scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

      // Nodo de silencio para que onaudioprocess se ejecute SIN reproducir el micro en los parlantes
      const muteGain = audioContext.createGain();
      muteGain.gain.value = 0;
      scriptProcessor.connect(muteGain);
      muteGain.connect(audioContext.destination);

      // Buffers para STT por bloques (Groq Whisper o Gemini 3.5 REST)
      let speechSamplesBuffer = [];
      let continuousSpeechFrames = 0;
      let isTranscribingBlock = false;
      let micEchoBlocked = false;

      scriptProcessor.onaudioprocess = async (audioProcessingEvent) => {
        if (!isPipelineRunning) return;

        // 0. Bloqueo de Eco Acústico (Si el altavoz está reproduciendo audio, ignorar el micrófono)
        const isCurrentlyPlayingAudio = isAppSpeaking || (Date.now() - lastAppSpeakingEndTime < 450);
        if (isCurrentlyPlayingAudio) {
          if (engine === 'local' && !micEchoBlocked) {
            micEchoBlocked = true;
            ipcRenderer.send('LOCAL_AI_FLUSH', { stream: 'mic' });
          }
          speechHoldFrames = 0;
          speechSamplesBuffer = [];
          continuousSpeechFrames = 0;
          if (vadBadge) {
            vadBadge.className = 'vad-badge noise';
            vadBadge.textContent = '🔇 ECO BLOQUEADO';
          }
          if (vuBar) vuBar.style.width = '0%';
          if (vuValText) vuValText.textContent = '0%';
          return;
        }

        micEchoBlocked = false;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);

        // 1. Cálculo de Energía RMS (Root Mean Square)
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);

        // 2. Actualización de Barra VU Meter en UI y Modal de Hardware
        const levelPct = Math.min(100, Math.round(rms * 900));
        if (vuBar) vuBar.style.width = `${levelPct}%`;
        if (vuValText) vuValText.textContent = `${levelPct}%`;

        const hwMeterBar = document.getElementById('hw-meter-bar');
        const hwMeterText = document.getElementById('hw-meter-text');
        if (hwMeterBar) hwMeterBar.style.width = `${levelPct}%`;
        if (hwMeterText) hwMeterText.textContent = `${levelPct}%`;

        // 3. Lógica de Puerta de Ruido (Noise Gate / VAD)
        const threshold = currentNoiseThreshold;

        if (rms >= threshold) {
          if (!isSpeakingActive) {
            isSpeakingActive = true;
            speechBlockStartTime = Date.now();
            appendLog('MIC', `🎙️ Hablando detectado [${new Date().toLocaleTimeString()}]...`, 'audio');
          }
          speechHoldFrames = 3; // 3 frames (~384ms) de retención para corte rápido
          continuousSpeechFrames++;

          if (vadBadge) {
            vadBadge.className = 'vad-badge speaking';
            vadBadge.textContent = '🟢 VOZ DETECTADA';
          }
        } else {
          if (speechHoldFrames > 0) {
            speechHoldFrames--;
          } else {
            isSpeakingActive = false;
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
          if (speechHoldFrames > 0 && geminiLiveClient && geminiLiveClient.isConnected) {
            const pcm16Buffer = floatTo16BitPCM(inputData);
            const base64Data = arrayBufferToBase64(pcm16Buffer);
            geminiLiveClient.sendRealtimeAudioChunk(base64Data);
          }
        } else if (engine === 'whisper_groq' || engine === 'gemini_35_transcribe') {
          // Acumular muestras SOLO mientras hay voz
          if (speechHoldFrames > 0) {
            for (let i = 0; i < inputData.length; i++) {
              speechSamplesBuffer.push(inputData[i]);
            }
          } else {
            // Si el usuario dejó de hablar y las muestras acumuladas son muy pocas (< 300ms = 4800 muestras),
            // descartar ruidos breves
            if (speechSamplesBuffer.length > 0 && speechSamplesBuffer.length < 4800) {
              speechSamplesBuffer = [];
            }
          }

          // Si el usuario pausó O se alcanzó ~4.5s de habla continua (72000 muestras)
          const shouldProcessBlock = (speechHoldFrames === 0 && speechSamplesBuffer.length >= 4800) || (speechSamplesBuffer.length > 72000);

          if (shouldProcessBlock && !isTranscribingBlock) {
            const samplesToSend = new Float32Array(speechSamplesBuffer);
            const voiceDurationMs = Math.round(samplesToSend.length / 16);
            const userSpeechStart = speechBlockStartTime || (Date.now() - voiceDurationMs);
            speechSamplesBuffer = [];
            continuousSpeechFrames = 0;
            isSpeakingActive = false;

            // Verificar energía RMS promedio del búfer completo
            let energySum = 0;
            for (let i = 0; i < samplesToSend.length; i++) {
              energySum += samplesToSend[i] * samplesToSend[i];
            }
            const avgRms = Math.sqrt(energySum / samplesToSend.length);
            if (avgRms < threshold * 0.35) {
              return;
            }

            isTranscribingBlock = true;

            try {
              const wavBuffer = encodeWAV(samplesToSend, 16000);
              const wavBase64 = arrayBufferToBase64(wavBuffer);

              const sttStart = Date.now();
              let result = null;
              if (engine === 'gemini_35_transcribe') {
                const glossaryList = (typeof DEFAULT_GLOSSARY !== 'undefined') ? Object.values(DEFAULT_GLOSSARY) : [];
                appendLog('GEMINI', `⚡ Enviando audio (${voiceDurationMs}ms) a Gemini STT...`, 'gemini');
                result = await ipcRenderer.invoke('TRANSCRIBE_GEMINI_35', {
                  audioBase64: wavBase64,
                  apiKey,
                  language: sourceLangSelect.value.substring(0, 2),
                  customVocabulary: glossaryList,
                  format: 'wav'
                });
              } else {
                appendLog('GROQ', `⚡ Enviando audio (${voiceDurationMs}ms) a Groq Whisper...`, 'audio');
                result = await ipcRenderer.invoke('TRANSCRIBE_GROQ', {
                  audioBase64: wavBase64,
                  apiKey,
                  language: sourceLangSelect.value.substring(0, 2),
                  prompt: 'Conversación fluida en vivo en español. Transcribir oraciones completas con puntuación adecuada.',
                  format: 'wav'
                });
              }

              const sttElapsed = (result && result.elapsedMs) || (Date.now() - sttStart);

              if (result && result.text && result.text.trim()) {
                const recognizedText = result.text.trim();
                if (!isWhisperHallucination(recognizedText)) {
                  const modelTag = (result && result.model) ? result.model : (engine === 'gemini_35_transcribe' ? 'Gemini 3.5' : 'Groq');
                  appendLog('VOICE', `Reconocido (${modelTag}) en ${sttElapsed}ms: "${recognizedText}"`, 'audio');
                  previewOrig.textContent = `🎙️ ${recognizedText}`;
                  outputQueue.push(() => deliverOutgoing({
                    recognizedText, sttElapsed, voiceDurationMs, userSpeechStart
                  }));
                }
              }
            } catch (err) {
              console.warn('[Unified Audio Process] Error:', err);
            } finally {
              isTranscribingBlock = false;
            }
          }
        } else if (engine === 'local' && localPair) {
          ipcRenderer.send('LOCAL_AI_AUDIO', {
            stream: 'mic',
            lang: localPair.source,
            target: localPair.target,
            at: Date.now(),
            samples: new Float32Array(inputData)
          });
        }
      };

      source.connect(scriptProcessor);

    } catch (err) {
      appendLog('AUDIO', `Error en captura de audio: ${err.message}`, 'error');
    }
  }

  // ── Funcionalidad de Validador de Hardware y Diagnóstico ──────────
  let hwMicStream = null;
  let hwAudioCtx = null;
  let hwScriptProc = null;
  let latestHwReportText = '';

  async function openHardwareModal() {
    const modal = document.getElementById('hardware-modal');
    if (modal) {
      modal.style.display = 'flex';
      await runHardwareValidation();
      startHwLiveMicTest();
    }
  }

  function closeHardwareModal() {
    const modal = document.getElementById('hardware-modal');
    if (modal) {
      modal.style.display = 'none';
      stopHwLiveMicTest();
    }
  }

  async function startHwLiveMicTest() {
    if (isPipelineRunning) return; // Si ya está corriendo el pipeline de traducción, usa ese stream
    try {
      if (hwMicStream) stopHwLiveMicTest();
      const deviceId = micInputSelect?.value || 'default';
      const constraints = {
        audio: (deviceId && deviceId !== 'default') ? { deviceId: { exact: deviceId } } : true,
        video: false
      };
      hwMicStream = await navigator.mediaDevices.getUserMedia(constraints);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      hwAudioCtx = new AudioCtx({ sampleRate: 16000 });
      const src = hwAudioCtx.createMediaStreamSource(hwMicStream);
      hwScriptProc = hwAudioCtx.createScriptProcessor(1024, 1, 1);
      hwScriptProc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const pct = Math.min(100, Math.round(rms * 900));
        const bar = document.getElementById('hw-meter-bar');
        const txt = document.getElementById('hw-meter-text');
        if (bar) bar.style.width = `${pct}%`;
        if (txt) txt.textContent = `${pct}%`;
      };
      src.connect(hwScriptProc);
      const nullDest = hwAudioCtx.createMediaStreamDestination();
      hwScriptProc.connect(nullDest);
    } catch (e) {
      console.warn('[HwLiveMicTest] Error iniciando prueba de mic:', e);
    }
  }

  function stopHwLiveMicTest() {
    if (hwScriptProc) {
      try { hwScriptProc.disconnect(); } catch (e) { }
      hwScriptProc = null;
    }
    if (hwAudioCtx && hwAudioCtx.state !== 'closed') {
      try { hwAudioCtx.close(); } catch (e) { }
      hwAudioCtx = null;
    }
    if (hwMicStream) {
      try { hwMicStream.getTracks().forEach(t => t.stop()); } catch (e) { }
      hwMicStream = null;
    }
    const bar = document.getElementById('hw-meter-bar');
    const txt = document.getElementById('hw-meter-text');
    if (bar) bar.style.width = '0%';
    if (txt) txt.textContent = '0%';
  }

  async function runHardwareValidation() {
    appendLog('HARDWARE', 'Iniciando diagnóstico profundo de hardware...');

    const verdictTitle = document.getElementById('hw-verdict-title');
    const verdictDesc = document.getElementById('hw-verdict-desc');
    const verdictBadge = document.getElementById('hw-verdict-badge');
    const verdictCard = document.getElementById('hw-verdict-card');

    if (verdictTitle) verdictTitle.textContent = 'Analizando hardware y drivers...';
    if (verdictBadge) verdictBadge.textContent = 'ANALIZANDO';

    try {
      const hwData = await ipcRenderer.invoke('CHECK_HARDWARE');
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const tempCtx = new AudioCtx();
      const sampleRate = tempCtx.sampleRate || 48000;
      try { tempCtx.close(); } catch (e) { }

      // WebGL check
      let webglName = 'Aceleración GPU Activa';
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          if (dbg) {
            const raw = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
            webglName = raw.replace(/(ANGLE|Direct3D|vs_\d+_\d+|ps_\d+_\d+)/g, '').trim() || 'GPU Compatible';
          }
        }
      } catch (e) { }

      // Rellenar CPU
      const cpuModelEl = document.getElementById('hw-cpu-model');
      const cpuCoresEl = document.getElementById('hw-cpu-cores');
      const osInfoEl = document.getElementById('hw-os-info');
      const archInfoEl = document.getElementById('hw-arch-info');

      if (cpuModelEl) cpuModelEl.textContent = hwData.cpu.model.slice(0, 32);
      if (cpuCoresEl) cpuCoresEl.textContent = `${hwData.cpu.cores} Núcleos (${hwData.cpu.speed} MHz)`;
      if (osInfoEl) osInfoEl.textContent = `${hwData.os.type} ${hwData.os.release}`;
      if (archInfoEl) archInfoEl.textContent = `${hwData.cpu.arch.toUpperCase()} (64-bit Ready)`;

      // Rellenar RAM
      const ramTotalEl = document.getElementById('hw-ram-total');
      const ramFreeEl = document.getElementById('hw-ram-free');
      const ramPctEl = document.getElementById('hw-ram-pct');
      const ramBar = document.getElementById('hw-ram-bar');

      if (ramTotalEl) ramTotalEl.textContent = `${hwData.memory.totalGB} GB`;
      if (ramFreeEl) ramFreeEl.textContent = `${hwData.memory.freeGB} GB libres`;
      if (ramPctEl) ramPctEl.textContent = `${hwData.memory.usedGB} GB (${hwData.memory.usagePct}%)`;
      if (ramBar) ramBar.style.width = `${hwData.memory.usagePct}%`;

      // Rellenar Audio
      const cableStatusEl = document.getElementById('hw-cable-status');
      const sampleRateEl = document.getElementById('hw-sample-rate');
      const micsCountEl = document.getElementById('hw-mics-count');
      const outputsCountEl = document.getElementById('hw-outputs-count');
      const audioStatusBadge = document.getElementById('hw-audio-status');

      const cableFound = outputs.some(d => (d.label || '').toLowerCase().includes('cable') || (d.label || '').toLowerCase().includes('virtual'));
      if (cableStatusEl) cableStatusEl.textContent = cableFound ? 'CABLE Input (VB-Audio) 🟢' : 'No detectado ⚠️';
      if (sampleRateEl) sampleRateEl.textContent = `${Math.round(sampleRate / 1000)} kHz (${sampleRate} Hz)`;
      if (micsCountEl) micsCountEl.textContent = `${mics.length} micrófono(s) activos`;
      if (outputsCountEl) outputsCountEl.textContent = `${outputs.length} dispositivo(s) de salida`;
      if (audioStatusBadge) {
        audioStatusBadge.textContent = cableFound ? 'CALIBRADO 🟢' : 'DRIVER PENDIENTE ⚠️';
        audioStatusBadge.className = cableFound ? 'hw-status-badge green' : 'hw-status-badge yellow';
      }

      // Rellenar GPU & Red
      const gpuInfoEl = document.getElementById('hw-gpu-info');
      const pingMsEl = document.getElementById('hw-ping-ms');
      const electronVerEl = document.getElementById('hw-electron-ver');
      const chromeVerEl = document.getElementById('hw-chrome-ver');

      if (gpuInfoEl) gpuInfoEl.textContent = webglName.slice(0, 30);
      if (pingMsEl) pingMsEl.textContent = hwData.network.pingMs > 0 ? `${hwData.network.pingMs} ms (Excelente)` : 'Conexión Local';
      if (electronVerEl) electronVerEl.textContent = `v${hwData.versions.electron}`;
      if (chromeVerEl) chromeVerEl.textContent = `v${hwData.versions.chrome}`;

      // Score / Veredicto Final
      const isOptimal = cableFound && hwData.cpu.cores >= 2;
      if (verdictCard) {
        verdictCard.className = isOptimal ? 'hw-verdict-card' : 'hw-verdict-card yellow-verdict';
      }
      if (verdictTitle) {
        verdictTitle.textContent = isOptimal ? '✅ Sistema 100% Calibrado y Óptimo' : '⚠️ Sistema con Recomendaciones de Driver';
      }
      if (verdictDesc) {
        verdictDesc.textContent = isOptimal
          ? 'Tu hardware cuenta con aceleración por GPU, baja latencia y driver de audio virtual listos para llamadas.'
          : 'Para transmitir a Meet/Teams sin que se escuche tu voz en español, instala el driver VB-Cable.';
      }
      if (verdictBadge) {
        verdictBadge.textContent = isOptimal ? '100% ÓPTIMO' : 'ATENCIÓN';
      }

      // Generar texto para reporte
      latestHwReportText = `=== REPORTE DE VALIDACIÓN DE HARDWARE ===
Fecha: ${new Date().toLocaleString()}
CPU: ${hwData.cpu.model} (${hwData.cpu.cores} núcleos @ ${hwData.cpu.speed} MHz)
RAM: ${hwData.memory.usedGB} GB / ${hwData.memory.totalGB} GB (${hwData.memory.usagePct}% uso)
Sistema: ${hwData.os.type} ${hwData.os.release} (${hwData.cpu.arch})
GPU: ${webglName}
Sample Rate: ${sampleRate} Hz
Driver VB-Cable: ${cableFound ? 'LISTO 🟢' : 'NO DETECTADO ⚠️'}
Micrófonos: ${mics.length}
Salidas: ${outputs.length}
Latencia Red: ${hwData.network.pingMs} ms
Veredicto: ${isOptimal ? 'APTO Y 100% ÓPTIMO' : 'REQUIERE DRIVER VB-CABLE'}
========================================`;

      appendLog('HARDWARE', `Diagnóstico completado: ${isOptimal ? 'SISTEMA ÓPTIMO 🟢' : 'DRIVER PENDIENTE ⚠️'}`);

    } catch (err) {
      appendLog('HARDWARE', `Error en validación de hardware: ${err.message}`, 'error');
      if (verdictTitle) verdictTitle.textContent = 'Error al ejecutar diagnóstico';
      if (verdictDesc) verdictDesc.textContent = err.message;
    }
  }

  // ── Lógica de Fish Audio: Gestión de Voces, Pruebas y Estudio de Clonación ──

  async function loadFishVoiceModels(selectedVoiceId = null) {
    if (!fishVoiceSelect) return;

    try {
      const apiKey = fishApiKeyInput ? fishApiKeyInput.value.trim() : '';
      const response = await ipcRenderer.invoke('FISH_AUDIO_LIST_MODELS', { apiKey, pageSize: 40 });
      const items = (response && response.items) ? response.items : [];

      const userPrimaryVoiceId = '0356fc9e08b646ed91607baa54a847c3';

      fishVoiceSelect.innerHTML = `
        <option value="default">⚡ Voz Estándar de Fish Audio</option>
      `;

      // Grupo de Voces Clonadas
      const myGroup = document.createElement('optgroup');
      myGroup.label = '⭐ Mis Voces Clonadas (IA)';

      // Incluir siempre el modelo principal del usuario
      const primaryOpt = document.createElement('option');
      primaryOpt.value = userPrimaryVoiceId;
      primaryOpt.textContent = '🎙️ Mi Voz Principal (Clonada)';
      myGroup.appendChild(primaryOpt);

      // Separar otros modelos de la cuenta
      const myModels = items.filter(m => (m.visibility === 'private' || (m.tags && m.tags.includes('custom'))) && (m._id !== userPrimaryVoiceId && m.id !== userPrimaryVoiceId));
      const communityModels = items.filter(m => m.visibility !== 'private' && m._id !== userPrimaryVoiceId && m.id !== userPrimaryVoiceId);

      myModels.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m._id || m.id;
        opt.textContent = `🎙️ ${m.title || 'Voz Clonada'}`;
        myGroup.appendChild(opt);
      });
      fishVoiceSelect.appendChild(myGroup);

      if (communityModels.length > 0) {
        const commGroup = document.createElement('optgroup');
        commGroup.label = '🌟 Voces de Alta Fidelidad y Estudio';
        communityModels.slice(0, 15).forEach(m => {
          const opt = document.createElement('option');
          opt.value = m._id || m.id;
          const langTag = (m.languages && m.languages[0]) ? `[${m.languages[0].toUpperCase()}] ` : '';
          opt.textContent = `${langTag}${m.title || 'Voz de Estudio'}`;
          commGroup.appendChild(opt);
        });
        fishVoiceSelect.appendChild(commGroup);
      }

      const customOpt = document.createElement('option');
      customOpt.value = 'custom';
      customOpt.textContent = '✏️ Ingresar ID de Modelo Manualmente...';
      fishVoiceSelect.appendChild(customOpt);

      // Seleccionar voz previa o la voz clonada principal
      const targetId = selectedVoiceId || (settings && settings.fishVoiceModelId) || userPrimaryVoiceId;
      const existsInSelect = Array.from(fishVoiceSelect.options).some(o => o.value === targetId);

      if (existsInSelect) {
        fishVoiceSelect.value = targetId;
        if (fishCustomVoiceGroup) fishCustomVoiceGroup.style.display = 'none';
      } else if (targetId && targetId !== 'default') {
        fishVoiceSelect.value = 'custom';
        if (fishVoiceIdInput) fishVoiceIdInput.value = targetId;
        if (fishCustomVoiceGroup) fishCustomVoiceGroup.style.display = 'block';
      }

      appendLog('FISH-AUDIO', `Voces de Fish Audio cargadas. Voz activa: ${fishVoiceSelect.options[fishVoiceSelect.selectedIndex]?.textContent || targetId}`);
    } catch (err) {
      console.warn('[Fish Audio] Error cargando modelos:', err);
    }
  }

  async function validateFishApiKey(showNotification = true) {
    if (!fishApiKeyInput || !fishStatusPill) return;

    const apiKey = fishApiKeyInput.value.trim();
    if (!apiKey) {
      fishStatusPill.className = 'status-pill-fish amber';
      fishStatusPill.textContent = 'Clave Pendiente';
      return;
    }

    fishStatusPill.className = 'status-pill-fish amber';
    fishStatusPill.textContent = 'Verificando...';

    try {
      const result = await ipcRenderer.invoke('FISH_AUDIO_TEST_KEY', { apiKey });
      if (result && result.ok) {
        fishStatusPill.className = 'status-pill-fish green';
        fishStatusPill.textContent = 'Conectado';
        if (showNotification) {
          appendLog('FISH-AUDIO', '✅ API Key de Fish Audio validada exitosamente.', 'success');
        }
      } else {
        fishStatusPill.className = 'status-pill-fish red';
        fishStatusPill.textContent = 'Error de Clave';
        if (showNotification) {
          appendLog('FISH-AUDIO', `❌ Error validando API Key: ${result?.message || 'Revisa la clave'}`, 'error');
        }
      }
    } catch (e) {
      fishStatusPill.className = 'status-pill-fish red';
      fishStatusPill.textContent = 'Sin Conexión';
    }
  }

  async function testFishVoice(testPhrase = null) {
    const phrase = testPhrase || 'Hello! This is my cloned voice translating in real time for Google Meet, Teams, and Zoom.';
    appendLog('FISH-AUDIO', `Iniciando prueba de voz clonada: "${phrase}"...`);

    if (btnTestFishVoice) {
      btnTestFishVoice.innerHTML = '<span class="btn-icon">⏳</span><span class="btn-text">Generando...</span>';
    }

    try {
      await playAudioToVirtualCableAndSpeakers(phrase, 'en', true);
      appendLog('FISH-AUDIO', '✅ Audio de prueba reproducido en tus auriculares/parlantes y enviado a Cable Virtual.', 'success');
    } catch (err) {
      appendLog('FISH-AUDIO', `Error en prueba de voz: ${err.message}`, 'error');
    } finally {
      if (btnTestFishVoice) {
        btnTestFishVoice.innerHTML = '<span class="btn-icon">🔊</span><span class="btn-text">Probar Mi Voz</span>';
      }
    }
  }

  // ── Estudio de Grabación de Voz para Clonación ──────────────────────
  let cloneMediaStream = null;
  let cloneAudioCtx = null;
  let cloneScriptProc = null;
  let cloneAudioSamples = [];
  let isCloneRecording = false;
  let cloneRecordTimerInterval = null;
  let cloneRecordSeconds = 0;
  let recordedWavBuffer = null;
  let recordedBlobUrl = null;

  function openCloneModal() {
    if (voiceCloneModal) {
      voiceCloneModal.style.display = 'flex';
      resetCloneStudio();
    }
  }

  function closeCloneModal() {
    if (isCloneRecording) {
      stopCloneRecording();
    }
    if (voiceCloneModal) {
      voiceCloneModal.style.display = 'none';
    }
    if (recordedBlobUrl) {
      URL.revokeObjectURL(recordedBlobUrl);
      recordedBlobUrl = null;
    }
  }

  function resetCloneStudio() {
    isCloneRecording = false;
    cloneRecordSeconds = 0;
    cloneAudioSamples = [];
    recordedWavBuffer = null;

    if (btnRecordText) btnRecordText.textContent = 'Iniciar Grabación';
    if (btnToggleRecord) btnToggleRecord.classList.remove('is-recording');
    if (recordStatusDot) recordStatusDot.className = 'record-status-dot';
    if (recordStatusLabel) recordStatusLabel.textContent = 'Micrófono listo';
    if (recordTimerBadge) recordTimerBadge.textContent = '00:00 / 00:20';
    if (voiceWaveContainer) voiceWaveContainer.classList.remove('recording');

    if (btnPlayPreview) btnPlayPreview.style.display = 'none';
    if (btnDiscardRecord) btnDiscardRecord.style.display = 'none';
    if (btnSubmitVoiceClone) {
      btnSubmitVoiceClone.disabled = true;
      btnSubmitVoiceClone.classList.remove('btn-loading');
      btnSubmitVoiceClone.innerHTML = '<span>✨ Entrenar y Crear Clon de Voz</span>';
    }
    if (trainingStatusBox) {
      trainingStatusBox.style.display = 'none';
      trainingStatusBox.className = 'training-status-box';
    }
    if (trainingSpinner) trainingSpinner.style.display = 'block';
    if (trainingStatusIcon) trainingStatusIcon.style.display = 'none';
    if (trainingProgressFill) trainingProgressFill.style.width = '15%';
    if (trainingBadgeStep) trainingBadgeStep.textContent = 'Paso 1 de 3';
  }

  async function startCloneRecording() {
    try {
      const deviceId = micInputSelect?.value || 'default';
      const constraints = {
        audio: (deviceId && deviceId !== 'default') ? { deviceId: { exact: deviceId } } : true,
        video: false
      };

      cloneMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      cloneAudioCtx = new AudioCtx({ sampleRate: 16000 });
      const src = cloneAudioCtx.createMediaStreamSource(cloneMediaStream);

      cloneScriptProc = cloneAudioCtx.createScriptProcessor(2048, 1, 1);
      cloneAudioSamples = [];
      isCloneRecording = true;
      cloneRecordSeconds = 0;

      const waveBars = voiceWaveContainer ? voiceWaveContainer.querySelectorAll('.wave-bar') : [];

      cloneScriptProc.onaudioprocess = (e) => {
        if (!isCloneRecording) return;
        const inputData = e.inputBuffer.getChannelData(0);
        cloneAudioSamples.push(new Float32Array(inputData));

        // Calcular volumen para animar barras
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        const height = Math.min(42, Math.max(6, Math.round(rms * 280)));

        waveBars.forEach((bar, idx) => {
          const factor = (idx % 3 === 0) ? 1.2 : 0.8;
          bar.style.height = `${Math.min(44, Math.round(height * factor))}px`;
        });
      };

      src.connect(cloneScriptProc);
      const nullDest = cloneAudioCtx.createMediaStreamDestination();
      cloneScriptProc.connect(nullDest);

      if (btnRecordText) btnRecordText.textContent = 'Detener Grabación';
      if (btnToggleRecord) btnToggleRecord.classList.add('is-recording');
      if (recordStatusDot) recordStatusDot.className = 'record-status-dot recording';
      if (recordStatusLabel) recordStatusLabel.textContent = 'Grabando muestra de voz...';
      if (voiceWaveContainer) voiceWaveContainer.classList.add('recording');

      cloneRecordTimerInterval = setInterval(() => {
        cloneRecordSeconds++;
        const mins = String(Math.floor(cloneRecordSeconds / 60)).padStart(2, '0');
        const secs = String(cloneRecordSeconds % 60).padStart(2, '0');
        if (recordTimerBadge) {
          recordTimerBadge.textContent = `${mins}:${secs} / 00:20`;
          if (cloneRecordSeconds >= 15) {
            recordTimerBadge.style.color = '#34c759';
            recordTimerBadge.style.borderColor = 'rgba(52, 199, 89, 0.5)';
            recordStatusLabel.textContent = 'Longitud óptima alcanzada. Puedes detener cuando termines la lectura.';
          }
        }

        // Límite máximo de 60s
        if (cloneRecordSeconds >= 60) {
          stopCloneRecording();
        }
      }, 1000);

      appendLog('FISH-AUDIO', '🎙️ Grabación de muestra de voz para clonación iniciada.');
    } catch (err) {
      appendLog('FISH-AUDIO', `Error iniciando grabación de voz: ${err.message}`, 'error');
    }
  }

  function stopCloneRecording() {
    isCloneRecording = false;
    clearInterval(cloneRecordTimerInterval);

    if (cloneScriptProc) {
      try { cloneScriptProc.disconnect(); } catch (e) { }
      cloneScriptProc = null;
    }
    if (cloneAudioCtx && cloneAudioCtx.state !== 'closed') {
      try { cloneAudioCtx.close(); } catch (e) { }
      cloneAudioCtx = null;
    }
    if (cloneMediaStream) {
      try { cloneMediaStream.getTracks().forEach(t => t.stop()); } catch (e) { }
      cloneMediaStream = null;
    }

    if (btnRecordText) btnRecordText.textContent = 'Iniciar Nueva Grabación';
    if (btnToggleRecord) btnToggleRecord.classList.remove('is-recording');
    if (recordStatusDot) recordStatusDot.className = 'record-status-dot';
    if (recordStatusLabel) recordStatusLabel.textContent = `Grabación finalizada (${cloneRecordSeconds} seg). Escucha o crea tu modelo.`;
    if (voiceWaveContainer) voiceWaveContainer.classList.remove('recording');

    // Concatenar Float32Arrays grabados
    let totalLength = 0;
    for (let i = 0; i < cloneAudioSamples.length; i++) {
      totalLength += cloneAudioSamples[i].length;
    }
    const mergedSamples = new Float32Array(totalLength);
    let offset = 0;
    for (let i = 0; i < cloneAudioSamples.length; i++) {
      mergedSamples.set(cloneAudioSamples[i], offset);
      offset += cloneAudioSamples[i].length;
    }

    // Codificar a WAV 16-bit 16kHz
    const wavArrayBuffer = encodeWAV(mergedSamples, 16000);
    recordedWavBuffer = wavArrayBuffer;

    // Crear preview de audio
    const blob = new Blob([wavArrayBuffer], { type: 'audio/wav' });
    if (recordedBlobUrl) URL.revokeObjectURL(recordedBlobUrl);
    recordedBlobUrl = URL.createObjectURL(blob);

    if (clonePreviewAudio) {
      clonePreviewAudio.src = recordedBlobUrl;
    }

    if (btnPlayPreview) btnPlayPreview.style.display = 'inline-flex';
    if (btnDiscardRecord) btnDiscardRecord.style.display = 'inline-flex';
    if (btnSubmitVoiceClone) btnSubmitVoiceClone.disabled = false;

    appendLog('FISH-AUDIO', `Muestra de voz lista: ${totalLength} samples (~${cloneRecordSeconds}s, ${wavArrayBuffer.byteLength} bytes).`);
  }

  if (btnToggleRecord) {
    btnToggleRecord.addEventListener('click', () => {
      if (isCloneRecording) {
        stopCloneRecording();
      } else {
        startCloneRecording();
      }
    });
  }

  if (btnPlayPreview) {
    btnPlayPreview.addEventListener('click', () => {
      if (clonePreviewAudio) {
        clonePreviewAudio.currentTime = 0;
        clonePreviewAudio.play();
        btnPlayPreview.innerHTML = '<span>🔊 Reproduciendo...</span>';
        clonePreviewAudio.onended = () => {
          btnPlayPreview.innerHTML = '<span>▶️ Escuchar Muestra</span>';
        };
      }
    });
  }

  if (btnDiscardRecord) {
    btnDiscardRecord.addEventListener('click', () => {
      resetCloneStudio();
      appendLog('FISH-AUDIO', 'Muestra de voz descartada.');
    });
  }

  if (btnSubmitVoiceClone) {
    btnSubmitVoiceClone.addEventListener('click', async () => {
      if (!recordedWavBuffer) {
        alert('Por favor graba una muestra de voz primero.');
        return;
      }

      const title = cloneModelTitle ? cloneModelTitle.value.trim() : 'Mi Voz Clonada';
      const visibility = cloneVisibility ? cloneVisibility.value : 'private';
      const sampleTranscript = cloneSampleTranscript ? cloneSampleTranscript.value.trim() : '';
      const apiKey = fishApiKeyInput ? fishApiKeyInput.value.trim() : '';

      if (!title) {
        alert('Por favor ingresa un nombre para el modelo.');
        return;
      }

      // ── Activar Estado de Carga (Loading) en Botón y Panel ──
      btnSubmitVoiceClone.disabled = true;
      btnSubmitVoiceClone.classList.add('btn-loading');
      btnSubmitVoiceClone.innerHTML = '<div class="btn-spinner"></div> <span>Entrenando y Creando Modelo IA...</span>';

      if (trainingStatusBox) {
        trainingStatusBox.className = 'training-status-box';
        trainingStatusBox.style.display = 'flex';
      }
      if (trainingSpinner) trainingSpinner.style.display = 'block';
      if (trainingStatusIcon) trainingStatusIcon.style.display = 'none';
      if (trainingBadgeStep) trainingBadgeStep.textContent = 'Paso 1 de 3';
      if (trainingProgressFill) trainingProgressFill.style.width = '28%';
      if (trainingStatusTitle) trainingStatusTitle.textContent = 'Codificando y Subiendo Audio a Fish Audio...';
      if (trainingStatusDesc) trainingStatusDesc.textContent = 'Procesando muestra WAV en alta fidelidad y extrayendo vectores fonéticos...';

      // Timers visuales para feedback continuo durante la petición
      const step2Timer = setTimeout(() => {
        if (trainingBadgeStep) trainingBadgeStep.textContent = 'Paso 2 de 3';
        if (trainingProgressFill) trainingProgressFill.style.width = '65%';
        if (trainingStatusTitle) trainingStatusTitle.textContent = 'Calibrando Redes Neuronales Acústicas...';
        if (trainingStatusDesc) trainingStatusDesc.textContent = 'Ajustando timbre, cadencia y armónicos vocales en los servidores de Fish Audio...';
      }, 1400);

      const step3Timer = setTimeout(() => {
        if (trainingBadgeStep) trainingBadgeStep.textContent = 'Paso 3 de 3';
        if (trainingProgressFill) trainingProgressFill.style.width = '88%';
        if (trainingStatusTitle) trainingStatusTitle.textContent = 'Generando e Indexando Modelo de Voz...';
        if (trainingStatusDesc) trainingStatusDesc.textContent = 'Asociando el nuevo modelo a tu cuenta privada...';
      }, 3200);

      const wavBase64 = arrayBufferToBase64(recordedWavBuffer);

      appendLog('FISH-AUDIO', `Enviando muestra de audio a Fish Audio para crear modelo "${title}"...`);

      try {
        const result = await ipcRenderer.invoke('FISH_AUDIO_CREATE_MODEL', {
          title,
          audioBase64: wavBase64,
          audioMimeType: 'audio/wav',
          sampleText: sampleTranscript,
          visibility,
          apiKey
        });

        clearTimeout(step2Timer);
        clearTimeout(step3Timer);

        if (result && result.success) {
          const modelId = result.modelId;
          appendLog('FISH-AUDIO', `🎉 ¡Clon de voz creado exitosamente! ID: ${modelId}`, 'success');

          if (trainingProgressFill) trainingProgressFill.style.width = '100%';
          if (trainingStatusBox) trainingStatusBox.className = 'training-status-box success';
          if (trainingSpinner) trainingSpinner.style.display = 'none';
          if (trainingStatusIcon) {
            trainingStatusIcon.style.display = 'block';
            trainingStatusIcon.textContent = '✅';
          }
          if (trainingBadgeStep) trainingBadgeStep.textContent = '¡Completado!';
          if (trainingStatusTitle) trainingStatusTitle.textContent = '¡Clon de Voz Creado con Éxito!';
          if (trainingStatusDesc) trainingStatusDesc.textContent = `Modelo ID: ${modelId}. Asignando como tu voz activa...`;
          btnSubmitVoiceClone.innerHTML = '<span>🎉 ¡Voz Clonada con Éxito!</span>';

          // Recargar lista y seleccionar el nuevo modelo
          await loadFishVoiceModels(modelId);
          await saveCurrentSettings();

          setTimeout(() => {
            closeCloneModal();
            // Ejecutar una prueba rápida para que el usuario escuche su nueva voz
            testFishVoice('Hello! My voice clone is now active and ready for video calls.');
          }, 1900);

        } else {
          appendLog('FISH-AUDIO', `❌ Error creando modelo: ${result?.error || 'Respuesta fallida'}`, 'error');
          if (trainingProgressFill) trainingProgressFill.style.width = '100%';
          if (trainingStatusBox) trainingStatusBox.className = 'training-status-box error';
          if (trainingSpinner) trainingSpinner.style.display = 'none';
          if (trainingStatusIcon) {
            trainingStatusIcon.style.display = 'block';
            trainingStatusIcon.textContent = '❌';
          }
          if (trainingBadgeStep) trainingBadgeStep.textContent = 'Error';
          if (trainingStatusTitle) trainingStatusTitle.textContent = 'Error al crear modelo';
          if (trainingStatusDesc) trainingStatusDesc.textContent = result?.error || 'Verifica tu conexión y API Key.';

          btnSubmitVoiceClone.classList.remove('btn-loading');
          btnSubmitVoiceClone.innerHTML = '<span>✨ Reintentar Entrenamiento</span>';
          btnSubmitVoiceClone.disabled = false;
        }
      } catch (err) {
        clearTimeout(step2Timer);
        clearTimeout(step3Timer);
        appendLog('FISH-AUDIO', `Excepción creando clon de voz: ${err.message}`, 'error');
        if (trainingStatusBox) trainingStatusBox.className = 'training-status-box error';
        if (trainingSpinner) trainingSpinner.style.display = 'none';
        if (trainingStatusIcon) {
          trainingStatusIcon.style.display = 'block';
          trainingStatusIcon.textContent = '❌';
        }
        if (trainingBadgeStep) trainingBadgeStep.textContent = 'Error';
        if (trainingStatusTitle) trainingStatusTitle.textContent = 'Error de conexión';
        if (trainingStatusDesc) trainingStatusDesc.textContent = err.message;

        btnSubmitVoiceClone.classList.remove('btn-loading');
        btnSubmitVoiceClone.innerHTML = '<span>✨ Reintentar Entrenamiento</span>';
        btnSubmitVoiceClone.disabled = false;
      }
    });
  }

  // ── Selector de Plantillas Fonéticas para Clonación de Voz ─────────
  const PROMPT_TEMPLATES = {
    phonetic: 'Hola, mi nombre es Julian. Esta es una prueba de calibración y clonación de voz en alta fidelidad. A lo largo del día participo en diferentes reuniones de trabajo, presentaciones ejecutivas y llamadas estratégicas con equipos de todo el mundo. Es fundamental mantener una comunicación fluida, clara y natural en cualquier idioma. Me aseguro de hablar con un ritmo constante, pausado y con una entonación amigable para que la inteligencia artificial capture exactamente el timbre y la calidez de mi voz real.',
    executive: 'Buenos días a todos. En la sesión de hoy revisaremos los avances clave del proyecto, las métricas de rendimiento del último trimestre y los próximos objetivos que implementaremos en la plataforma. Si tienen alguna duda técnica o sugerencia sobre la arquitectura, por favor coméntenla con total libertad para alinear nuestras prioridades antes del cierre.',
    bilingual: 'Hola, estoy probando la traducción simultánea con mi propio clon de voz. Durante mis llamadas en vivo, mi objetivo es transmitir mis ideas con total confianza y precisión. I am excited to see how this technology translates my words into natural English, keeping my personal voice style, tone, and professional confidence across all my meetings.'
  };

  const btnPromptTpls = document.querySelectorAll('.btn-prompt-tpl');
  const promptReadingTextEl = document.getElementById('prompt-reading-text');

  btnPromptTpls.forEach(btn => {
    btn.addEventListener('click', () => {
      btnPromptTpls.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tplKey = btn.getAttribute('data-tpl');
      const text = PROMPT_TEMPLATES[tplKey] || PROMPT_TEMPLATES.phonetic;
      if (promptReadingTextEl) promptReadingTextEl.textContent = `"${text}"`;
      if (cloneSampleTranscript) cloneSampleTranscript.value = text;
      appendLog('FISH-AUDIO', `Plantilla de lectura seleccionada: [${btn.textContent.trim()}]`);
    });
  });
});


