/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * DOBLE INTERCEPCIÓN:
 *   1. navigator.mediaDevices.getUserMedia → captura el mic original
 *   2. RTCPeerConnection.prototype.addTrack → REEMPLAZA el audio
 *      que WebRTC envía al participante remoto con nuestro mixer.
 *
 * Esto GARANTIZA que el audio que viaja por la llamada sea el del mixer,
 * independientemente de cómo Google Meet/Zoom/Teams gestione el audio.
 * ====================================================================
 */
(function () {
  'use strict';

  // ── Referencias originales ──
  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origAddTrack = RTCPeerConnection.prototype.addTrack;
  const _origAddStream = RTCPeerConnection.prototype.addStream;

  let audioCtx = null;
  let mixerDestination = null;
  let micSourceNode = null;
  let micGainNode = null;   // 0 = silenciado, 1 = activo
  let ttsGainNode = null;   // Control de volumen TTS
  let isMixerActive = false;
  let originalMicTrack = null; // Track original del mic para crear el mixer como fallback

  /**
   * Inicializa el mixer a partir de un AudioTrack.
   */
  function setupMixerFromTrack(audioTrack) {
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ sampleRate: 48000 });
      }

      mixerDestination = audioCtx.createMediaStreamDestination();

      // Canal del micrófono
      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = 1.0;

      const trackStream = new MediaStream([audioTrack]);
      micSourceNode = audioCtx.createMediaStreamSource(trackStream);
      micSourceNode.connect(micGainNode);
      micGainNode.connect(mixerDestination);

      // Canal TTS
      ttsGainNode = audioCtx.createGain();
      ttsGainNode.gain.value = 2.0;
      ttsGainNode.connect(mixerDestination);

      isMixerActive = true;
      originalMicTrack = audioTrack;

      notifyStatus('MIXER_ACTIVE');
      console.log('[MeetTranslate Mixer] ✅ Mixer creado desde AudioTrack');
    } catch (err) {
      console.warn('[MeetTranslate Mixer] Error creando mixer desde track:', err);
    }
  }

  /**
   * Obtiene el track de audio mixto del mixer.
   */
  function getMixedAudioTrack() {
    if (mixerDestination) {
      const tracks = mixerDestination.stream.getAudioTracks();
      if (tracks.length > 0) return tracks[0];
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  // INTERCEPCIÓN 1: getUserMedia → captura el stream del mic
  // ══════════════════════════════════════════════════════════════════
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const originalStream = await _origGetUserMedia(constraints);

    if (!constraints || !constraints.audio) {
      return originalStream;
    }

    const audioTracks = originalStream.getAudioTracks();
    if (audioTracks.length === 0) {
      return originalStream;
    }

    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ sampleRate: 48000 });
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      mixerDestination = audioCtx.createMediaStreamDestination();

      // Canal micrófono
      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = 1.0;
      micSourceNode = audioCtx.createMediaStreamSource(originalStream);
      micSourceNode.connect(micGainNode);
      micGainNode.connect(mixerDestination);

      // Canal TTS
      ttsGainNode = audioCtx.createGain();
      ttsGainNode.gain.value = 2.0;
      ttsGainNode.connect(mixerDestination);

      isMixerActive = true;
      originalMicTrack = audioTracks[0];

      // Construir stream mixto
      const mixedStream = new MediaStream();
      mixerDestination.stream.getAudioTracks().forEach(t => mixedStream.addTrack(t));
      originalStream.getVideoTracks().forEach(t => mixedStream.addTrack(t));

      notifyStatus('GUM_INTERCEPTED');
      console.log('[MeetTranslate Mixer] ✅ getUserMedia interceptado — Stream mixto creado');
      return mixedStream;

    } catch (err) {
      console.warn('[MeetTranslate Mixer] Error en getUserMedia override:', err);
      return originalStream;
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // INTERCEPCIÓN 2: RTCPeerConnection.addTrack → REEMPLAZA el audio
  // que WebRTC envía al participante remoto
  // ══════════════════════════════════════════════════════════════════
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    if (track.kind === 'audio') {
      // Si el mixer no está activo, configurarlo ahora usando este track
      if (!isMixerActive) {
        console.log('[MeetTranslate Mixer] ⚡ getUserMedia no interceptado, configurando mixer desde addTrack');
        setupMixerFromTrack(track);
      }

      // Reemplazar el track de audio con nuestro track mixto
      const mixedTrack = getMixedAudioTrack();
      if (mixedTrack) {
        console.log('[MeetTranslate Mixer] 🔄 Audio track REEMPLAZADO en WebRTC con mixer');
        notifyStatus('TRACK_REPLACED');
        return _origAddTrack.call(this, mixedTrack, ...streams);
      }
    }

    return _origAddTrack.call(this, track, ...streams);
  };

  // ══════════════════════════════════════════════════════════════════
  // INTERCEPCIÓN 3: RTCPeerConnection.addStream (API legacy)
  // ══════════════════════════════════════════════════════════════════
  if (_origAddStream) {
    RTCPeerConnection.prototype.addStream = function (stream) {
      const audioTracks = stream.getAudioTracks();

      if (audioTracks.length > 0) {
        if (!isMixerActive) {
          setupMixerFromTrack(audioTracks[0]);
        }

        const mixedTrack = getMixedAudioTrack();
        if (mixedTrack) {
          audioTracks.forEach(t => stream.removeTrack(t));
          stream.addTrack(mixedTrack);
          console.log('[MeetTranslate Mixer] 🔄 Audio reemplazado en addStream (legacy)');
          notifyStatus('STREAM_REPLACED');
        }
      }

      return _origAddStream.call(this, stream);
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // Reproducir audio TTS traducido a través del mixer
  // ══════════════════════════════════════════════════════════════════
  async function playTTSIntoMixer(audioArrayBuffer) {
    if (!isMixerActive || !audioCtx || !ttsGainNode) {
      console.warn('[MeetTranslate Mixer] ⚠️ Mixer no activo');
      notifyStatus('TTS_FAILED');
      return;
    }

    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNode);
      source.start(0);

      notifyStatus('TTS_PLAYING');
      console.log('[MeetTranslate Mixer] 🔊 Audio TTS inyectado en llamada WebRTC (' +
        Math.round(audioBuffer.duration * 10) / 10 + 's)');
    } catch (err) {
      console.warn('[MeetTranslate Mixer] Error reproduciendo TTS:', err);
      notifyStatus('TTS_ERROR');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // Comunicación con content script (ISOLATED world)
  // ══════════════════════════════════════════════════════════════════
  function notifyStatus(status) {
    window.postMessage({ type: 'MT_MIXER_STATUS_UPDATE', status: status }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    switch (event.data.type) {
      case 'MT_PLAY_TTS_INTO_CALL':
        if (event.data.audioData && event.data.audioData instanceof ArrayBuffer) {
          playTTSIntoMixer(event.data.audioData);
        }
        break;

      case 'MT_SET_MIC_MUTE':
        if (micGainNode && audioCtx) {
          const muted = !!event.data.muted;
          micGainNode.gain.setValueAtTime(muted ? 0 : 1, audioCtx.currentTime);
          notifyStatus(muted ? 'MIC_MUTED' : 'MIC_UNMUTED');
          console.log('[MeetTranslate Mixer] ' + (muted ? '🔇 Mic SILENCIADO' : '🎙️ Mic ACTIVO'));
        }
        break;

      case 'MT_MIXER_STATUS':
        window.postMessage({
          type: 'MT_MIXER_STATUS_RESPONSE',
          isActive: isMixerActive,
          micMuted: micGainNode ? micGainNode.gain.value === 0 : false
        }, '*');
        break;
    }
  });

  console.log('[MeetTranslate Mixer] 🎯 Interceptores getUserMedia + RTCPeerConnection instalados');
})();
