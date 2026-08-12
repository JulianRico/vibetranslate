/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * ESTRATEGIA: replaceTrack() post-conexión
 *
 * En lugar de intentar modificar el stream ANTES de que Meet lo use
 * (lo cual Meet puede ignorar o revertir), dejamos que Meet configure
 * su conexión WebRTC normalmente con el micrófono original.
 *
 * DESPUÉS de que la conexión está establecida, usamos
 * RTCRtpSender.replaceTrack() para sustituir silenciosamente el
 * audio que se envía al participante remoto con nuestro mixer
 * (que combina mic original + TTS traducido).
 *
 * replaceTrack() es una API estándar de WebRTC que cambia el track
 * de un sender activo SIN renegociación — Meet NO puede detectarlo.
 * ====================================================================
 */
(function () {
  'use strict';

  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origAddTrack = RTCPeerConnection.prototype.addTrack;

  let audioCtx = null;
  let mixerDest = null;
  let micGain = null;
  let ttsGain = null;
  let isMixerReady = false;
  let capturedMicStream = null;

  // Mapa de senders cuyo track fue reemplazado + track original
  const senderMap = new Map();
  // Guardar original track getter para camuflaje
  const origTrackDesc = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'track');

  // ══════════════════════════════════════════════════════════════════
  // 1. Interceptar getUserMedia para CAPTURAR el mic stream
  //    (devolvemos el stream original SIN MODIFICAR a Meet)
  // ══════════════════════════════════════════════════════════════════
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await _origGUM(constraints);

    if (constraints && constraints.audio && stream.getAudioTracks().length > 0) {
      capturedMicStream = stream;
      initMixer(stream);
      console.log('[MT Mixer] 🎙️ Mic stream capturado para mixer');
    }

    // Devolver stream ORIGINAL sin modificar — Meet lo usa normalmente
    return stream;
  };

  // ══════════════════════════════════════════════════════════════════
  // 2. Interceptar addTrack para detectar cuándo Meet agrega audio
  //    a WebRTC, y programar el reemplazo silencioso
  // ══════════════════════════════════════════════════════════════════
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    const sender = _origAddTrack.call(this, track, ...streams);

    if (track.kind === 'audio') {
      console.log('[MT Mixer] 📡 Audio track agregado a RTCPeerConnection');

      // Si no tenemos el mic stream todavía, capturarlo del track
      if (!capturedMicStream) {
        capturedMicStream = new MediaStream([track]);
        initMixer(capturedMicStream);
      }

      // Programar reemplazo DESPUÉS de que Meet termine su setup
      scheduleTrackReplace(sender, track);
    }

    return sender;
  };

  // ══════════════════════════════════════════════════════════════════
  // 3. Camuflaje: ocultar el reemplazo de track a Meet
  //    Si Meet consulta sender.track, ve el track original
  // ══════════════════════════════════════════════════════════════════
  if (origTrackDesc && origTrackDesc.get) {
    Object.defineProperty(RTCRtpSender.prototype, 'track', {
      get: function () {
        // Si este sender fue reemplazado, devolver el track original para camuflaje
        if (senderMap.has(this)) {
          return senderMap.get(this);
        }
        return origTrackDesc.get.call(this);
      },
      configurable: true
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // Inicializar el mixer de audio
  // ══════════════════════════════════════════════════════════════════
  function initMixer(micStream) {
    if (isMixerReady) return;

    try {
      audioCtx = new AudioContext();
      mixerDest = audioCtx.createMediaStreamDestination();

      // ── Canal del micrófono ──
      micGain = audioCtx.createGain();
      micGain.gain.value = 1.0; // 1.0 = activo, 0.0 = silenciado
      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(micGain);
      micGain.connect(mixerDest);

      // ── Canal TTS (traducción) ──
      ttsGain = audioCtx.createGain();
      ttsGain.gain.value = 2.5; // Volumen alto para claridad
      ttsGain.connect(mixerDest);

      isMixerReady = true;
      notify('MIXER_READY');
      console.log('[MT Mixer] ✅ Mixer de audio inicializado');
    } catch (e) {
      console.warn('[MT Mixer] Error inicializando mixer:', e);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Reemplazar el track del sender con el output del mixer
  // ══════════════════════════════════════════════════════════════════
  function scheduleTrackReplace(sender, originalTrack) {
    // Intentar reemplazo con retardo para que Meet termine su setup
    const tryReplace = async (attempt) => {
      if (!isMixerReady || !mixerDest) {
        if (attempt < 10) {
          setTimeout(() => tryReplace(attempt + 1), 500);
        }
        return;
      }

      try {
        if (audioCtx.state === 'suspended') await audioCtx.resume();

        const mixedTrack = mixerDest.stream.getAudioTracks()[0];
        if (!mixedTrack) return;

        // replaceTrack() cambia el audio sin renegociación — indetectable
        await sender.replaceTrack(mixedTrack);

        // Guardar track original para camuflaje
        senderMap.set(sender, originalTrack);

        notify('TRACK_REPLACED');
        console.log('[MT Mixer] ✅ replaceTrack() EXITOSO — Audio del mixer inyectado en WebRTC');
      } catch (e) {
        console.warn('[MT Mixer] replaceTrack intento', attempt, ':', e.message);
        if (attempt < 10) {
          setTimeout(() => tryReplace(attempt + 1), 1000);
        }
      }
    };

    // Primer intento después de 300ms
    setTimeout(() => tryReplace(1), 300);
  }

  // ══════════════════════════════════════════════════════════════════
  // Vigilancia periódica: re-reemplazar si Meet revierte el track
  // ══════════════════════════════════════════════════════════════════
  setInterval(() => {
    if (!isMixerReady || !mixerDest) return;

    const mixedTrack = mixerDest.stream.getAudioTracks()[0];
    if (!mixedTrack) return;

    for (const [sender, origTrack] of senderMap.entries()) {
      try {
        // Verificar si el track real del sender cambió
        const realTrack = origTrackDesc ? origTrackDesc.get.call(sender) : null;
        if (realTrack && realTrack.id !== mixedTrack.id) {
          sender.replaceTrack(mixedTrack).then(() => {
            console.log('[MT Mixer] 🔄 Track re-reemplazado (Meet intentó revertir)');
            notify('TRACK_REPLACED');
          }).catch(() => {
            senderMap.delete(sender);
          });
        }
      } catch (e) {
        senderMap.delete(sender);
      }
    }
  }, 2000);

  // ══════════════════════════════════════════════════════════════════
  // Reproducir audio TTS traducido a través del mixer
  // ══════════════════════════════════════════════════════════════════
  async function playTTS(arrayBuffer) {
    if (!isMixerReady || !audioCtx || !ttsGain) {
      notify('TTS_FAILED');
      console.warn('[MT Mixer] ⚠️ No se puede reproducir TTS — mixer no listo');
      return;
    }

    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const buffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(ttsGain);
      source.start(0);

      notify('TTS_PLAYING');
      console.log('[MT Mixer] 🔊 TTS inyectado en llamada (' +
        Math.round(buffer.duration * 10) / 10 + 's)');
    } catch (e) {
      console.warn('[MT Mixer] Error TTS:', e);
      notify('TTS_ERROR');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Comunicación con content script (mundo ISOLATED)
  // ══════════════════════════════════════════════════════════════════
  function notify(status) {
    window.postMessage({ type: 'MT_MIXER_STATUS_UPDATE', status: status }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    switch (event.data.type) {
      case 'MT_PLAY_TTS_INTO_CALL':
        if (event.data.audioData && event.data.audioData instanceof ArrayBuffer) {
          playTTS(event.data.audioData);
        }
        break;

      case 'MT_SET_MIC_MUTE':
        if (micGain && audioCtx) {
          const muted = !!event.data.muted;
          micGain.gain.setValueAtTime(muted ? 0 : 1, audioCtx.currentTime);
          notify(muted ? 'MIC_MUTED' : 'MIC_UNMUTED');
          console.log('[MT Mixer] ' + (muted ? '🔇 Mic SILENCIADO — solo sale traducción' : '🎙️ Mic ACTIVO'));
        }
        break;

      case 'MT_MIXER_STATUS':
        window.postMessage({
          type: 'MT_MIXER_STATUS_RESPONSE',
          isActive: isMixerReady,
          trackReplaced: senderMap.size > 0,
          micMuted: micGain ? micGain.gain.value === 0 : false
        }, '*');
        break;
    }
  });

  console.log('[MT Mixer] 🎯 Interceptores instalados (getUserMedia + addTrack + replaceTrack + camuflaje)');
})();
