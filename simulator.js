/**
 * simulator.js - Controlador del Simulador e Inspector de Audio WebRTC
 * Ejecuta el pipeline completo en tiempo real: captura de micrófono, reconocedor de voz en español,
 * traducción instantánea a inglés, silenciador del mic original e inyección del audio traducido en la llamada.
 */

(function () {
  'use strict';

  // Elementos UI
  const btnToggleSim = document.getElementById('btn-toggle-sim');
  const chkMuteSp = document.getElementById('chk-mute-sp');
  const btnSendTts = document.getElementById('btn-send-tts');
  const inputTtsCustom = document.getElementById('input-tts-custom');
  const chkListenRemote = document.getElementById('chk-listen-remote');

  const txtSttOrig = document.getElementById('txt-stt-orig');
  const txtSttTrans = document.getElementById('txt-stt-trans');

  const barMic = document.getElementById('bar-mic');
  const txtMicVal = document.getElementById('txt-mic-val');
  const barOut = document.getElementById('bar-out');
  const txtOutVal = document.getElementById('txt-out-val');
  const barRemote = document.getElementById('bar-remote');
  const txtRemoteVal = document.getElementById('txt-remote-val');

  const pillMic = document.getElementById('pill-mic');
  const pillWebrtc = document.getElementById('pill-webrtc');
  const pillRemote = document.getElementById('pill-remote');
  const txtChannelStatus = document.getElementById('txt-channel-status');
  const logBox = document.getElementById('log-box');

  // Estado del Pipeline Audio
  let isSimActive = false;
  let rawMicStream = null;
  let audioCtx = null;

  let micGainNode = null;
  let ttsGainNode = null;
  let mixerDestNode = null;

  let analyserMic = null;
  let analyserOut = null;
  let analyserRemote = null;

  let speechRecognition = null;
  let remoteAudioElement = new Audio();

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `[${time}] ${msg}\n`;
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[Simulator]', msg);
  }

  btnToggleSim.addEventListener('click', async () => {
    if (isSimActive) {
      stopSimulation();
    } else {
      await startSimulation();
    }
  });

  async function startSimulation() {
    log('Iniciando simulación de canal WebRTC...');
    try {
      // 1. Obtener stream de micrófono físico
      rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log('✅ Micrófono físico capturado.');

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // 2. Analyser del micrófono físico (Panel 1)
      const micSource = audioCtx.createMediaStreamSource(rawMicStream);
      analyserMic = audioCtx.createAnalyser();
      analyserMic.fftSize = 256;
      micSource.connect(analyserMic);

      // 3. Crear Mixer de Audio (Canal de salida WebRTC)
      mixerDestNode = audioCtx.createMediaStreamDestination();

      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = chkMuteSp.checked ? 0.0 : 1.0;

      micSource.connect(micGainNode);
      micGainNode.connect(mixerDestNode);

      ttsGainNode = audioCtx.createGain();
      ttsGainNode.gain.value = 2.5;
      ttsGainNode.connect(mixerDestNode);

      // 4. Analyser del Canal de Salida Transmitido (Panel 2)
      analyserOut = audioCtx.createAnalyser();
      analyserOut.fftSize = 256;
      const outSource = audioCtx.createMediaStreamSource(mixerDestNode.stream);
      outSource.connect(analyserOut);

      // 5. Oyente Remoto (Panel 3)
      remoteAudioElement.srcObject = mixerDestNode.stream;
      remoteAudioElement.muted = !chkListenRemote.checked;
      remoteAudioElement.play().catch(() => {});

      const remoteSource = audioCtx.createMediaStreamSource(mixerDestNode.stream);
      analyserRemote = audioCtx.createAnalyser();
      analyserRemote.fftSize = 256;
      remoteSource.connect(analyserRemote);

      isSimActive = true;

      btnToggleSim.innerHTML = '<span>⏹️ Detener Simulación</span>';
      btnToggleSim.className = 'btn btn-stop';

      pillMic.className = 'status-pill pill-on'; pillMic.textContent = 'ACTIVO';
      pillWebrtc.className = 'status-pill pill-on'; pillWebrtc.textContent = 'TRANSMITIENDO';
      pillRemote.className = 'status-pill pill-on'; pillRemote.textContent = 'CONECTADO';

      updateChannelStatusText();
      startLiveSTT();
      updateMetersLoop();

      log('✅ Simulación de llamada WebRTC iniciada exitosamente.');

    } catch (err) {
      log(`❌ Error iniciando simulación: ${err.message}`);
      stopSimulation();
    }
  }

  function stopSimulation() {
    isSimActive = false;
    stopLiveSTT();

    if (rawMicStream) {
      rawMicStream.getTracks().forEach(t => t.stop());
      rawMicStream = null;
    }

    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }

    btnToggleSim.innerHTML = '<span>▶️ Iniciar Simulación</span>';
    btnToggleSim.className = 'btn btn-start';

    pillMic.className = 'status-pill pill-off'; pillMic.textContent = 'OFF';
    pillWebrtc.className = 'status-pill pill-off'; pillWebrtc.textContent = 'INACTIVO';
    pillRemote.className = 'status-pill pill-off'; pillRemote.textContent = 'DESCONECTADO';

    barMic.style.width = '0%'; txtMicVal.textContent = '0%';
    barOut.style.width = '0%'; txtOutVal.textContent = '0%';
    barRemote.style.width = '0%'; txtRemoteVal.textContent = '0%';
    txtChannelStatus.textContent = 'Esperando inicio';

    log('Simulación de llamada detenida.');
  }

  chkMuteSp.addEventListener('change', () => {
    const isMuted = chkMuteSp.checked;
    if (micGainNode && audioCtx) {
      micGainNode.gain.setValueAtTime(isMuted ? 0.0 : 1.0, audioCtx.currentTime);
    }
    updateChannelStatusText();
    log(isMuted ? '🔇 Micrófono original silenciado (Ganancia = 0.0)' : '🎙️ Micrófono original activado (Ganancia = 1.0)');
  });

  chkListenRemote.addEventListener('change', () => {
    remoteAudioElement.muted = !chkListenRemote.checked;
    log(chkListenRemote.checked ? '🔊 Escucha local activada.' : '🔇 Escucha local silenciada.');
  });

  function updateChannelStatusText() {
    if (!isSimActive) {
      txtChannelStatus.textContent = 'Esperando inicio';
      txtChannelStatus.style.color = '#94a3b8';
      return;
    }
    if (chkMuteSp.checked) {
      txtChannelStatus.textContent = '🔇 Micrófono Silenciado (Solo sale Traducción)';
      txtChannelStatus.style.color = '#ef4444';
      barOut.classList.add('muted');
    } else {
      txtChannelStatus.textContent = '🎙️ Micrófono Directo (Sin silenciar)';
      txtChannelStatus.style.color = '#34d399';
      barOut.classList.remove('muted');
    }
  }

  // Transmisión de voz traducida (TTS MP3 -> Mixer)
  btnSendTts.addEventListener('click', async () => {
    const text = inputTtsCustom.value.trim();
    if (!text) return;
    await transmitTTSAudio(text, 'en');
  });

  async function transmitTTSAudio(text, lang) {
    if (!isSimActive || !audioCtx || !ttsGainNode) {
      log('⚠️ Inicia la simulación antes de transmitir TTS.');
      return;
    }

    log(`Descargando y transmitiendo audio TTS en inglés: "${text}"...`);

    try {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNode);
      source.start(0);

      log(`✅ Voz traducida enviada al canal WebRTC (${Math.round(audioBuffer.duration * 10) / 10}s)`);
    } catch (err) {
      log(`⚠️ Error reproduciendo TTS: ${err.message}`);
    }
  }

  // Reconocimiento de voz en tiempo real + Traducción automática
  function startLiveSTT() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    speechRecognition = new SpeechRecognition();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;
    speechRecognition.lang = 'es-ES';

    speechRecognition.onresult = async (event) => {
      let interim = '';
      let finalStr = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalStr += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      const text = (finalStr || interim).trim();
      if (text) {
        txtSttOrig.textContent = text;
        log(`[Mic STT] "${text}"`);

        // Traducir usando la API rápida de Google
        try {
          const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=es&tl=en&dt=t&q=${encodeURIComponent(text)}`;
          const res = await fetch(url);
          const data = await res.json();
          let translated = text;
          if (data && Array.isArray(data[0])) {
            translated = data[0].map(c => c[0]).filter(Boolean).join('');
          }

          txtSttTrans.textContent = translated;

          // Si la frase es final y el silenciador está activo, transmitir automáticamente la voz traducida
          if (finalStr && chkMuteSp.checked) {
            log(`[Traducción Lista] Transmitiendo al oyente remoto: "${translated}"`);
            await transmitTTSAudio(translated, 'en');
          }
        } catch (e) {
          console.warn('Error traduciendo:', e);
        }
      }
    };

    speechRecognition.onerror = (e) => {
      if (e.error !== 'no-speech') console.warn('STT Error:', e.error);
    };

    speechRecognition.onend = () => {
      if (isSimActive && speechRecognition) {
        try { speechRecognition.start(); } catch (e) {}
      }
    };

    try { speechRecognition.start(); } catch (e) {}
  }

  function stopLiveSTT() {
    if (speechRecognition) {
      try {
        speechRecognition.onend = null;
        speechRecognition.stop();
      } catch (e) {}
      speechRecognition = null;
    }
  }

  // Bucle de actualización de los VU meters de volumen
  function updateMetersLoop() {
    if (!isSimActive) return;

    const micVol = getVol(analyserMic);
    const outVol = getVol(analyserOut);
    const remoteVol = getVol(analyserRemote);

    barMic.style.width = `${micVol}%`;
    txtMicVal.textContent = `${micVol}%`;

    barOut.style.width = `${outVol}%`;
    txtOutVal.textContent = `${outVol}%`;

    barRemote.style.width = `${remoteVol}%`;
    txtRemoteVal.textContent = `${remoteVol}%`;

    requestAnimationFrame(updateMetersLoop);
  }

  function getVol(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return Math.min(100, Math.round((sum / data.length / 128) * 100));
  }

})();
