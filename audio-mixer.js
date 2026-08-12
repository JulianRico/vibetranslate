/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * Intercepta navigator.mediaDevices.getUserMedia para crear un mixer
 * que combina el audio del micrófono con el audio TTS de traducción.
 *
 * Esto permite que la voz traducida en inglés se transmita directamente
 * a través de la llamada al participante remoto vía WebRTC.
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
  let ttsGainNode = null;
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

      // Conectar el stream original del micrófono al mixer
      micSourceNode = audioCtx.createMediaStreamSource(originalStream);
      micSourceNode.connect(mixerDestination);

      // Crear nodo de ganancia para el audio TTS (control de volumen)
      ttsGainNode = audioCtx.createGain();
      ttsGainNode.gain.value = 1.8; // Volumen ligeramente superior para claridad
      ttsGainNode.connect(mixerDestination);

      isMixerActive = true;

      // Construir stream mixto de salida
      const mixedStream = new MediaStream();

      // Agregar nuestro track de audio mixto (micrófono + TTS)
      mixerDestination.stream.getAudioTracks().forEach(track => {
        mixedStream.addTrack(track);
      });

      // Preservar tracks de video del stream original (si existen)
      originalStream.getVideoTracks().forEach(track => {
        mixedStream.addTrack(track);
      });

      console.log('[MeetTranslate Mixer] ✅ Mixer de audio activo — El audio TTS será transmitido a la llamada');
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

      console.log('[MeetTranslate Mixer] 🔊 Audio TTS inyectado en el stream de la llamada');
    } catch (err) {
      console.warn('[MeetTranslate Mixer] Error reproduciendo TTS en el mixer:', err);
    }
  }

  /**
   * Escuchar mensajes de audio TTS desde el content script (mundo ISOLATED).
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'MT_PLAY_TTS_INTO_CALL') {
      if (event.data.audioData && event.data.audioData instanceof ArrayBuffer) {
        playTTSIntoMixer(event.data.audioData);
      }
    }
  });

  console.log('[MeetTranslate Mixer] 🎯 Interceptor de getUserMedia instalado, esperando llamada...');
})();
