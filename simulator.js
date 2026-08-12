/**
 * simulator.js - Controlador del Simulador e Inspector de Audio WebRTC
 * Establece una llamada WebRTC Loopback en la misma página (PC1 -> PC2)
 * para medir los VU meters de entrada, transmisión y salida remota.
 */

(function () {
  'use strict';

  // Elementos UI
  const btnStartSim = document.getElementById('btn-start-sim');
  const chkMuteMic = document.getElementById('chk-mute-mic');
  const btnSendTts = document.getElementById('btn-send-tts');
  const txtTtsTest = document.getElementById('txt-tts-test');
  const chkListenRemote = document.getElementById('chk-listen-remote');

  const barMic = document.getElementById('bar-mic');
  const valMic = document.getElementById('val-mic');
  const barTransmitted = document.getElementById('bar-transmitted');
  const valTransmitted = document.getElementById('val-transmitted');
  const barRemote = document.getElementById('bar-remote');
  const valRemote = document.getElementById('val-remote');

  const badgeEmisor = document.getElementById('badge-emisor');
  const badgeWebrtc = document.getElementById('badge-webrtc');
  const badgeReceptor = document.getElementById('badge-receptor');
  const statusChannelText = document.getElementById('status-channel-text');
  const logBox = document.getElementById('log-box');

  // WebRTC Loopback
  let pc1 = null; // Emisor (Local)
  let pc2 = null; // Receptor (Remoto)
  let localMicStream = null;
  let remoteAudioElement = new Audio();

  // Audio Context & Analysers
  let audioCtx = null;
  let analyserMic = null;
  let analyserTransmitted = null;
  let analyserRemote = null;

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}\n`;
    logBox.textContent += line;
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[Simulator]', msg);
  }

  btnStartSim.addEventListener('click', async () => {
    if (pc1) {
      log('Deteniendo simulación...');
      stopSimulation();
      return;
    }

    log('Iniciando simulación de llamada WebRTC...');
    btnStartSim.innerHTML = '<span>⏹️ Detener Simulación</span>';
    btnStartSim.classList.replace('btn-primary', 'btn-danger');

    try {
      audioCtx = new AudioContext();

      // 1. Obtener stream de micrófono (interceptado por audio-mixer.js si está activo)
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log('Stream de micrófono obtenido exitosamente.');
      badgeEmisor.className = 'status-badge badge-on';
      badgeEmisor.textContent = 'ACTIVO';

      // Configurar Analyser para el micrófono local
      const micSource = audioCtx.createMediaStreamSource(localMicStream);
      analyserMic = audioCtx.createAnalyser();
      analyserMic.fftSize = 256;
      micSource.connect(analyserMic);

      // 2. Crear pares WebRTC PeerConnection (Loopback PC1 -> PC2)
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();

      // Pasar candidatos ICE entre pares
      pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
      pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);

      // Cuando PC2 recibe el track de audio remoto
      pc2.ontrack = (event) => {
        log('✅ Stream de audio WebRTC RECIBIDO por el Oyente Remoto (PC2)');
        badgeReceptor.className = 'status-badge badge-on';
        badgeReceptor.textContent = 'CONECTADO';

        remoteAudioElement.srcObject = event.streams[0];
        remoteAudioElement.muted = !chkListenRemote.checked;
        remoteAudioElement.play().catch(() => {});

        // Analyser para la salida del oyente remoto
        const remoteSource = audioCtx.createMediaStreamSource(event.streams[0]);
        analyserRemote = audioCtx.createAnalyser();
        analyserRemote.fftSize = 256;
        remoteSource.connect(analyserRemote);
      };

      // Agregar track de audio a PC1
      localMicStream.getAudioTracks().forEach(track => {
        pc1.addTrack(track, localMicStream);
      });

      // Analyser para el stream transmitido por PC1
      const transmittedSource = audioCtx.createMediaStreamSource(localMicStream);
      analyserTransmitted = audioCtx.createAnalyser();
      analyserTransmitted.fftSize = 256;
      transmittedSource.connect(analyserTransmitted);

      // Negociación SDP
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);

      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      badgeWebrtc.className = 'status-badge badge-on';
      badgeWebrtc.textContent = 'TRANSMITIENDO';
      log('Conexión WebRTC Loopback ESTABLECIDA al 100%.');

      // Iniciar bucle de medición de VU meters
      updateMeters();

    } catch (err) {
      log(`❌ Error iniciando simulación: ${err.message}`);
      stopSimulation();
    }
  });

  // Toggle para silenciar el micrófono en español
  chkMuteMic.addEventListener('change', () => {
    const isMuted = chkMuteMic.checked;
    log(`Enviando evento MT_SET_MIC_MUTE (muted: ${isMuted})...`);

    window.postMessage({
      type: 'MT_SET_MIC_MUTE',
      muted: isMuted
    }, '*');

    if (isMuted) {
      statusChannelText.textContent = '🔇 Micrófono Silenciado (Solo sale Traducción)';
      statusChannelText.style.color = '#ef4444';
      barTransmitted.classList.add('muted');
    } else {
      statusChannelText.textContent = '🎙️ Micrófono Directo Activo';
      statusChannelText.style.color = '#34d399';
      barTransmitted.classList.remove('muted');
    }
  });

  // Toggle para escuchar el audio remoto localmente
  chkListenRemote.addEventListener('change', () => {
    remoteAudioElement.muted = !chkListenRemote.checked;
    log(`Escucha local del oyente remoto: ${chkListenRemote.checked ? 'ACTIVADA' : 'SILENCIADA'}`);
  });

  // Enviar audio TTS traducido de prueba
  btnSendTts.addEventListener('click', async () => {
    const text = txtTtsTest.value.trim();
    if (!text) return;

    log(`Descargando y enviando audio TTS traducido: "${text}"...`);

    try {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=en&client=tw-ob`;
      const res = await fetch(ttsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const audioBuffer = await res.arrayBuffer();

      window.postMessage({
        type: 'MT_PLAY_TTS_INTO_CALL',
        audioData: audioBuffer
      }, '*');

      log('✅ Audio TTS enviado al mixer de la llamada exitosamente.');
    } catch (err) {
      log(`⚠️ Error descargando TTS: ${err.message}`);
    }
  });

  // Bucle de actualización de los VU Meters
  function updateMeters() {
    if (!pc1) return;

    const micVol = getVolumeLevel(analyserMic);
    const transVol = getVolumeLevel(analyserTransmitted);
    const remoteVol = getVolumeLevel(analyserRemote);

    barMic.style.width = `${micVol}%`;
    valMic.textContent = `${micVol}%`;

    barTransmitted.style.width = `${transVol}%`;
    valTransmitted.textContent = `${transVol}%`;

    barRemote.style.width = `${remoteVol}%`;
    valRemote.textContent = `${remoteVol}%`;

    requestAnimationFrame(updateMeters);
  }

  function getVolumeLevel(analyser) {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const average = sum / data.length;
    return Math.min(100, Math.round((average / 128) * 100));
  }

  function stopSimulation() {
    if (pc1) { pc1.close(); pc1 = null; }
    if (pc2) { pc2.close(); pc2 = null; }
    if (localMicStream) {
      localMicStream.getTracks().forEach(t => t.stop());
      localMicStream = null;
    }

    btnStartSim.innerHTML = '<span>▶️ Iniciar Simulación de Llamada</span>';
    btnStartSim.classList.replace('btn-danger', 'btn-primary');

    badgeEmisor.className = 'status-badge badge-off'; badgeEmisor.textContent = 'OFF';
    badgeWebrtc.className = 'status-badge badge-off'; badgeWebrtc.textContent = 'ESPERANDO';
    badgeReceptor.className = 'status-badge badge-off'; badgeReceptor.textContent = 'DESCONECTADO';

    barMic.style.width = '0%'; valMic.textContent = '0%';
    barTransmitted.style.width = '0%'; valTransmitted.textContent = '0%';
    barRemote.style.width = '0%'; valRemote.textContent = '0%';

    log('Simulación de llamada detenida.');
  }

  // Escuchar mensajes de actualización de estado desde audio-mixer.js
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'MT_MIXER_STATUS_UPDATE') {
      log(`[AUDIO MIXER EVENT] Estado actualizado: ${e.data.status}`);
    }
  });

})();
