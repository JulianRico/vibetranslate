/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * ARQUITECTURA DE INYECCIÓN Y SUPRESIÓN DIRECTA EN GOOGLE MEET:
 *
 * 1. Interceptamos navigator.mediaDevices.getUserMedia al inicio (document_start).
 *    En lugar de entregarle a Google Meet el micrófono físico directamente,
 *    creamos un Mixer (AudioContext) que envuelve el micrófono con nodos de ganancia:
 *      - micGain (0.0 = Silenciado en español, 1.0 = Voz directa)
 *      - ttsGain (2.5 = Audio traducido en inglés)
 *
 * 2. Entregamos a Google Meet un 'virtualStream'. Google Meet NUNCA ve el micrófono
 *    físico sin filtrar, solo ve nuestro stream controlado.
 *
 * 3. Cuando activas la traducción en vivo (🔊):
 *    micGain pasa a 0.0 ➔ Google Meet recibe SILENCIO ABSOLUTO (0.0 volume) para el español.
 *    Cuando se sintetiza el inglés ➔ ttsGain inyecta la voz traducida directamente
 *    en el stream que Meet está transmitiendo por WebRTC al participante remoto.
 * ====================================================================
 */
(function () {
  'use strict';

  // Guardar referencias nativas
  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origAddTrack = RTCPeerConnection.prototype.addTrack;

  let audioCtx = null;
  let mixerDest = null;
  let micGain = null;
  let ttsGain = null;
  let isMixerReady = false;
  let isMicMuted = false;
  let capturedRawMicStream = null;

  const senderMap = new Map();
  const origTrackDesc = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'track');

  /**
   * Inicializa los nodos del Mixer de Audio.
   */
  function setupMixer(rawStream) {
    if (isMixerReady && audioCtx && audioCtx.state !== 'closed') return;

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

      mixerDest = audioCtx.createMediaStreamDestination();

      // ── Canal del Micrófono Físico ──
      micGain = audioCtx.createGain();
      micGain.gain.value = isMicMuted ? 0.0 : 1.0;

      const micSource = audioCtx.createMediaStreamSource(rawStream);
      micSource.connect(micGain);
      micGain.connect(mixerDest);

      // ── Canal TTS (Traducción en Inglés) ──
      ttsGain = audioCtx.createGain();
      ttsGain.gain.value = 2.5; // Volumen alto para claridad
      ttsGain.connect(mixerDest);

      isMixerReady = true;
      capturedRawMicStream = rawStream;

      notify('MIXER_READY');
      console.log('[MT Mixer] ✅ Mixer de audio inicializado exitosamente');
    } catch (e) {
      console.warn('[MT Mixer] Error inicializando mixer:', e);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. getUserMedia Interceptor: Entrega a Meet el VirtualStream controlado
  // ══════════════════════════════════════════════════════════════════
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const originalStream = await _origGUM(constraints);

    // Si no solicita audio, devolver stream original (ej. solo video)
    if (!constraints || !constraints.audio || originalStream.getAudioTracks().length === 0) {
      return originalStream;
    }

    try {
      setupMixer(originalStream);

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Crear stream virtual de salida para Google Meet
      const virtualStream = new MediaStream();

      // Agregar el track de audio mixto (mic silenciable + TTS)
      if (mixerDest && mixerDest.stream) {
        mixerDest.stream.getAudioTracks().forEach(track => {
          virtualStream.addTrack(track);
        });
      } else {
        originalStream.getAudioTracks().forEach(track => virtualStream.addTrack(track));
      }

      // Preservar tracks de video (cámara) sin tocar
      originalStream.getVideoTracks().forEach(track => {
        virtualStream.addTrack(track);
      });

      notify('VIRTUAL_STREAM_DELIVERED');
      console.log('[MT Mixer] 🎯 VirtualStream entregado a Google Meet — Control de silenciamiento activo');
      return virtualStream;

    } catch (err) {
      console.warn('[MT Mixer] Fallo al crear VirtualStream, usando original:', err);
      return originalStream;
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // 2. RTCPeerConnection.addTrack Interceptor: Garantiza que si Meet
  //    agrega un track directamente, use el track del mixer
  // ══════════════════════════════════════════════════════════════════
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    if (track.kind === 'audio') {
      console.log('[MT Mixer] 📡 RTCPeerConnection.addTrack de audio interceptado');

      if (!isMixerReady) {
        const rawStream = new MediaStream([track]);
        setupMixer(rawStream);
      }

      if (mixerDest && mixerDest.stream.getAudioTracks().length > 0) {
        const mixedTrack = mixerDest.stream.getAudioTracks()[0];
        const sender = _origAddTrack.call(this, mixedTrack, ...streams);
        senderMap.set(sender, track);
        notify('TRACK_REPLACED');
        console.log('[MT Mixer] 🔄 Track de audio en WebRTC reemplazado por el Mixer');
        return sender;
      }
    }

    return _origAddTrack.call(this, track, ...streams);
  };

  // Camuflaje de getter de track para evitar sorpresas en Meet
  if (origTrackDesc && origTrackDesc.get) {
    Object.defineProperty(RTCRtpSender.prototype, 'track', {
      get: function () {
        if (senderMap.has(this)) {
          return senderMap.get(this);
        }
        return origTrackDesc.get.call(this);
      },
      configurable: true
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. Reproducción e Inyección de Audio TTS Traducido
  // ══════════════════════════════════════════════════════════════════
  async function playTTS(arrayBuffer) {
    if (!isMixerReady || !audioCtx || !ttsGain) {
      console.warn('[MT Mixer] ⚠️ Mixer no listo para reproducir TTS');
      notify('TTS_FAILED');
      return;
    }

    try {
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const buffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(ttsGain);
      source.start(0);

      notify('TTS_PLAYING');
      console.log('[MT Mixer] 🔊 Audio TTS traducido inyectado en el stream de Meet (' +
        Math.round(buffer.duration * 10) / 10 + 's)');
    } catch (e) {
      console.warn('[MT Mixer] Error decodificando o inyectando TTS:', e);
      notify('TTS_ERROR');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. Comunicación con content script (ISOLATED World)
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
        isMicMuted = !!event.data.muted;
        if (micGain && audioCtx) {
          micGain.gain.setValueAtTime(isMicMuted ? 0.0 : 1.0, audioCtx.currentTime);
          notify(isMicMuted ? 'MIC_MUTED' : 'MIC_UNMUTED');
          console.log('[MT Mixer] ' + (isMicMuted ? '🔇 Micrófono SILENCIADO (Ganancia = 0.0)' : '🎙️ Micrófono ACTIVO (Ganancia = 1.0)'));
        }
        break;

      case 'MT_MIXER_STATUS':
        window.postMessage({
          type: 'MT_MIXER_STATUS_RESPONSE',
          isActive: isMixerReady,
          micMuted: isMicMuted
        }, '*');
        break;
    }
  });

  console.log('[MT Mixer] 🎯 Interceptores instalados en document_start (getUserMedia + addTrack + VirtualStream)');
})();
