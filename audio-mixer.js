/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * Intercepta navigator.mediaDevices.getUserMedia para crear un mixer
 * que combina el audio del micrófono con el audio TTS de traducción.
 *
 * Cuando la traducción está activa:
 *   - El micrófono original se SILENCIA (gain = 0) para que el participante
 *     remoto NO escuche la voz en español.
 *   - Solo la voz traducida en inglés (TTS) se transmite por la llamada.
 *
 * Ejecutado en el mundo MAIN (contexto de la página) al inicio del
 * documento (document_start) para interceptar antes de que Meet/Zoom/Teams
 * configuren sus conexiones WebRTC.
 * ====================================================================
 */
(function () {
  'use strict';

  // Guardar referencia original de getUserMedia
  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  let audioCtx = null;
  let mixerDestination = null;
  let micSourceNode = null;
  let micGainNode = null;   // Controla volumen del mic (0 = silenciado, 1 = activo)
  let ttsGainNode = null;   // Controla volumen del TTS traducido
  let isMixerActive = false;

  /**
   * Override de getUserMedia para interceptar streams de audio.
   */
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    // Llamar al getUserMedia original
    const originalStream = await _origGetUserMedia(constraints);

    // Solo interceptar si se solicita audio
    if (!constraints || !constraints.audio) {
      return originalStream;
    }

    const audioTracks = originalStream.getAudioTracks();
    if (audioTracks.length === 0) {
      return originalStream;
    }

    try {
      // Crear AudioContext si no existe
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext({ sampleRate: 48000 });
      }

      // Reanudar si está suspendido
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Crear nodo destino del mixer (stream de salida para WebRTC)
      mixerDestination = audioCtx.createMediaStreamDestination();

      // ── CANAL DEL MICRÓFONO ──
      // Nodo de ganancia del mic: permite silenciar la voz original
      micGainNode = audioCtx.createGain();
      micGainNode.gain.value = 1.0; // Activo por defecto, se silencia al activar traducción

      micSourceNode = audioCtx.createMediaStreamSource(originalStream);
      micSourceNode.connect(micGainNode);
      micGainNode.connect(mixerDestination);

      // ── CANAL TTS (TRADUCCIÓN) ──
      // Nodo de ganancia para el audio TTS traducido
      ttsGainNode = audioCtx.createGain();
      ttsGainNode.gain.value = 2.0; // Volumen alto para claridad en la llamada
      ttsGainNode.connect(mixerDestination);

      isMixerActive = true;

      // Construir stream mixto de salida
      const mixedStream = new MediaStream();

      // Agregar nuestro track de audio mixto (mic + TTS)
      mixerDestination.stream.getAudioTracks().forEach(track => {
        mixedStream.addTrack(track);
      });

      // Preservar tracks de video del stream original
      originalStream.getVideoTracks().forEach(track => {
        mixedStream.addTrack(track);
      });

      console.log('[MeetTranslate Mixer] ✅ Mixer de audio WebRTC activo — Listo para inyectar traducción');

      // Notificar al content script que el mixer está listo
      window.postMessage({ type: 'MT_MIXER_READY' }, '*');

      return mixedStream;

    } catch (err) {
      console.warn('[MeetTranslate Mixer] Fallo al configurar el mixer, usando stream original:', err);
      isMixerActive = false;
      return originalStream;
    }
  };

  /**
   * Reproduce audio TTS a través del mixer (se envía al participante remoto).
   */
  async function playTTSIntoMixer(audioArrayBuffer) {
    if (!isMixerActive || !audioCtx || !ttsGainNode) {
      console.warn('[MeetTranslate Mixer] ⚠️ Mixer no activo, no se puede inyectar TTS');
      return;
    }

    try {
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Decodificar los datos de audio MP3
      const audioBuffer = await audioCtx.decodeAudioData(audioArrayBuffer.slice(0));

      // Crear fuente de buffer y conectar al mixer vía nodo de ganancia
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNode);
      source.start(0);

      console.log('[MeetTranslate Mixer] 🔊 Audio TTS traducido inyectado en la llamada WebRTC');
    } catch (err) {
      console.warn('[MeetTranslate Mixer] Error reproduciendo TTS en el mixer:', err);
    }
  }

  /**
   * Escuchar mensajes desde el content script (mundo ISOLATED).
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || !event.data.type) return;

    switch (event.data.type) {
      // Inyectar audio TTS traducido en el stream de la llamada
      case 'MT_PLAY_TTS_INTO_CALL':
        if (event.data.audioData && event.data.audioData instanceof ArrayBuffer) {
          playTTSIntoMixer(event.data.audioData);
        }
        break;

      // Silenciar / activar micrófono original en el stream WebRTC
      case 'MT_SET_MIC_MUTE':
        if (micGainNode) {
          const muted = !!event.data.muted;
          micGainNode.gain.setValueAtTime(muted ? 0 : 1, audioCtx ? audioCtx.currentTime : 0);
          console.log('[MeetTranslate Mixer] Micrófono ' + (muted ? '🔇 SILENCIADO (solo sale inglés)' : '🎙️ ACTIVO (voz directa)'));
        }
        break;

      // Consultar estado del mixer
      case 'MT_MIXER_STATUS':
        window.postMessage({
          type: 'MT_MIXER_STATUS_RESPONSE',
          isActive: isMixerActive,
          micMuted: micGainNode ? micGainNode.gain.value === 0 : false
        }, '*');
        break;
    }
  });

  console.log('[MeetTranslate Mixer] 🎯 Interceptor de getUserMedia instalado — Esperando llamada...');
})();
