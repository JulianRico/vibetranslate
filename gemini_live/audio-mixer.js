/**
 * audio-mixer.js - WebRTC Audio Mixer (MAIN World)
 * ====================================================================
 * OBJETIVO: que el PARTICIPANTE REMOTO escuche la traducción en inglés.
 *
 * Cadena de audio:
 *   micRaw ──▶ micGain (0.0 mute / 1.0 directo) ──┐
 *                                                  ├──▶ mixerDest ──▶ track ──▶ WebRTC
 *   TTS EN ──▶ ttsGain (2.5)  ────────────────────┘
 *
 * REGLAS CRÍTICAS QUE ESTA VERSIÓN GARANTIZA:
 *
 * 1. UNA SOLA INSTANCIA por frame (guard global). Dos instancias anidan dos
 *    mixers y el micGain=0.0 del exterior silencia el TTS del interior.
 *
 * 2. NUNCA se entrega el track original de mixerDest a la página. Se entrega
 *    un clone() por cada getUserMedia. Meet detiene (track.stop()) el stream
 *    de la sala de espera al entrar a la llamada; si le diéramos el track
 *    original quedaría 'ended' PARA SIEMPRE y el receptor no oiría nada nunca.
 *
 * 3. Se interceptan addTrack, addTransceiver Y replaceTrack. Meet usa
 *    replaceTrack al mutear, al cambiar de dispositivo y al reconectar; sin
 *    esa intercepción Meet devuelve el micrófono crudo al sender y el mixer
 *    queda fuera del camino WebRTC.
 *
 * 4. Un watchdog re-afirma el track del mixer en todos los RTCRtpSender de
 *    audio cada 3s, y reconstruye el mixer si su track murió.
 *
 * 5. El TTS se agenda SECUENCIALMENTE (cursor de tiempo), no con offsets
 *    fijos que solapan los fragmentos y producen ruido ininteligible.
 * ====================================================================
 */
(function () {
  'use strict';

  // ── Guard: una sola instancia por frame ────────────────────────────
  if (window.__MT_MIXER_INSTALLED__) {
    console.warn('[MT Mixer] Ya hay una instancia instalada en este frame. Se omite la carga duplicada.');
    return;
  }
  window.__MT_MIXER_INSTALLED__ = true;

  const TTS_GAIN = 2.5;
  const CHUNK_GAP = 0.08;        // segundos de silencio entre fragmentos TTS
  const WATCHDOG_MS = 3000;

  // ── Referencias nativas (capturadas antes de parchear) ─────────────
  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origAddTrack = RTCPeerConnection.prototype.addTrack;
  const _origAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
  const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  const _origTrackDesc = Object.getOwnPropertyDescriptor(RTCRtpSender.prototype, 'track');
  const _origTrackGet = _origTrackDesc && _origTrackDesc.get;

  // ── Estado del mixer ───────────────────────────────────────────────
  let audioCtx = null;
  let mixerDest = null;
  let micGain = null;
  let ttsGain = null;
  let meterGain = null;
  let analyser = null;
  let micSourceNode = null;
  let rawMicStream = null;
  let isMicMuted = false;
  let ttsCursor = 0;

  const peerConnections = new Set();   // RTCPeerConnection vistas
  const ourTracks = new Set();         // clones que entregamos a la página
  const senderOriginalTrack = new Map(); // camuflaje: sender -> track original

  const diag = {
    gumCalls: 0,
    tracksHandedOut: 0,
    addTrackIntercepted: 0,
    addTransceiverIntercepted: 0,
    replaceTrackIntercepted: 0,
    watchdogReasserts: 0,
    mixerRebuilds: 0,
    ttsChunksPlayed: 0,
    ttsChunksFailed: 0,
    lastError: null,
    micLabel: null
  };

  // ══════════════════════════════════════════════════════════════════
  // Construcción y auto-reparación del mixer
  // ══════════════════════════════════════════════════════════════════

  function isLive(track) {
    return !!track && track.readyState === 'live';
  }

  function baseMixedTrack() {
    if (!mixerDest || !mixerDest.stream) return null;
    return mixerDest.stream.getAudioTracks()[0] || null;
  }

  /**
   * Garantiza AudioContext + grafo de nodos vivos. Reconstruye si el track
   * base murió (p. ej. si alguien logró detenerlo) o si el contexto se cerró.
   */
  function ensureMixer() {
    try {
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        mixerDest = null;
        ttsCursor = 0;
      }

      if (!mixerDest || !isLive(baseMixedTrack())) {
        mixerDest = audioCtx.createMediaStreamDestination();

        micGain = audioCtx.createGain();
        micGain.gain.value = isMicMuted ? 0.0 : 1.0;
        micGain.connect(mixerDest);

        ttsGain = audioCtx.createGain();
        ttsGain.gain.value = TTS_GAIN;
        ttsGain.connect(mixerDest);

        // Medidor de nivel: mide exactamente lo que entra a mixerDest
        meterGain = audioCtx.createGain();
        meterGain.gain.value = 1.0;
        micGain.connect(meterGain);
        ttsGain.connect(meterGain);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        meterGain.connect(analyser);

        micSourceNode = null;
        if (rawMicStream && rawMicStream.getAudioTracks().some(isLive)) {
          attachMicStream(rawMicStream);
        }

        diag.mixerRebuilds++;
        notify('MIXER_READY');
        console.log('[MT Mixer] ✅ Grafo de audio construido (rebuild #' + diag.mixerRebuilds + ')');
      }

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      return true;
    } catch (e) {
      diag.lastError = 'ensureMixer: ' + e.message;
      console.warn('[MT Mixer] Error construyendo el mixer:', e);
      return false;
    }
  }

  /**
   * Conecta el micrófono físico real al canal micGain.
   * Detiene la captura de micrófono anterior para no acumular capturas.
   */
  function attachMicStream(stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;

    try {
      if (micSourceNode) {
        try { micSourceNode.disconnect(); } catch (e) {}
        micSourceNode = null;
      }

      if (rawMicStream && rawMicStream !== stream) {
        rawMicStream.getAudioTracks().forEach(t => {
          try { t.stop(); } catch (e) {}
        });
      }

      rawMicStream = stream;
      micSourceNode = audioCtx.createMediaStreamSource(stream);
      micSourceNode.connect(micGain);
      diag.micLabel = stream.getAudioTracks()[0].label || '(sin etiqueta)';
      console.log('[MT Mixer] 🎙️ Micrófono físico conectado al mixer:', diag.micLabel);
    } catch (e) {
      diag.lastError = 'attachMicStream: ' + e.message;
      console.warn('[MT Mixer] Error conectando el micrófono al mixer:', e);
    }
  }

  /**
   * Devuelve SIEMPRE un clone nuevo. Si la página detiene el clone, el track
   * base del mixer sigue vivo y el siguiente getUserMedia entrega otro clone.
   */
  function freshMixedTrack() {
    if (!ensureMixer()) return null;
    const base = baseMixedTrack();
    if (!base) return null;

    let clone;
    try {
      clone = base.clone();
    } catch (e) {
      clone = base; // fallback extremo
    }
    ourTracks.add(clone);
    diag.tracksHandedOut++;

    // Limpiar clones muertos para no crecer sin límite
    for (const t of ourTracks) {
      if (t !== clone && t.readyState === 'ended') ourTracks.delete(t);
    }
    return clone;
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. getUserMedia: entregamos el VirtualStream (clone del mixer)
  // ══════════════════════════════════════════════════════════════════
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const originalStream = await _origGUM(constraints);
    diag.gumCalls++;

    if (!constraints || !constraints.audio || originalStream.getAudioTracks().length === 0) {
      return originalStream;
    }

    try {
      ensureMixer();
      attachMicStream(originalStream);

      const mixedTrack = freshMixedTrack();
      if (!mixedTrack) throw new Error('No se pudo obtener el track del mixer');

      const virtualStream = new MediaStream();
      virtualStream.addTrack(mixedTrack);
      originalStream.getVideoTracks().forEach(t => virtualStream.addTrack(t));

      notify('VIRTUAL_STREAM_DELIVERED');
      console.log('[MT Mixer] 🎯 VirtualStream entregado (gUM #' + diag.gumCalls + ') — clone id:', mixedTrack.id);
      return virtualStream;

    } catch (err) {
      diag.lastError = 'getUserMedia: ' + err.message;
      console.warn('[MT Mixer] Fallo creando VirtualStream, se devuelve el original:', err);
      notify('VIRTUAL_STREAM_FAILED');
      return originalStream;
    }
  };

  // ══════════════════════════════════════════════════════════════════
  // 2. addTrack / addTransceiver / replaceTrack
  // ══════════════════════════════════════════════════════════════════
  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    peerConnections.add(this);

    if (track && track.kind === 'audio' && !ourTracks.has(track)) {
      const mixed = freshMixedTrack();
      if (mixed) {
        const sender = _origAddTrack.call(this, mixed, ...streams);
        senderOriginalTrack.set(sender, track);
        diag.addTrackIntercepted++;
        notify('TRACK_REPLACED');
        console.log('[MT Mixer] 🔄 addTrack de audio sustituido por el track del mixer');
        return sender;
      }
    }

    return _origAddTrack.call(this, track, ...streams);
  };

  RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
    peerConnections.add(this);

    const isAudioTrack = trackOrKind &&
      typeof trackOrKind === 'object' &&
      trackOrKind.kind === 'audio' &&
      !ourTracks.has(trackOrKind);

    if (isAudioTrack) {
      const mixed = freshMixedTrack();
      if (mixed) {
        const transceiver = _origAddTransceiver.call(this, mixed, init);
        if (transceiver && transceiver.sender) {
          senderOriginalTrack.set(transceiver.sender, trackOrKind);
        }
        diag.addTransceiverIntercepted++;
        notify('TRACK_REPLACED');
        console.log('[MT Mixer] 🔄 addTransceiver de audio sustituido por el track del mixer');
        return transceiver;
      }
    }

    return _origAddTransceiver.call(this, trackOrKind, init);
  };

  RTCRtpSender.prototype.replaceTrack = function (newTrack) {
    // replaceTrack(null) = la página quiere silenciar de verdad: se respeta.
    if (newTrack && newTrack.kind === 'audio' && !ourTracks.has(newTrack)) {
      const mixed = freshMixedTrack();
      if (mixed) {
        senderOriginalTrack.set(this, newTrack);
        diag.replaceTrackIntercepted++;
        console.log('[MT Mixer] 🔁 replaceTrack interceptado — se mantiene el mixer en el sender');
        return _origReplaceTrack.call(this, mixed);
      }
    }

    if (newTrack === null) {
      senderOriginalTrack.delete(this);
    }
    return _origReplaceTrack.call(this, newTrack);
  };

  // Camuflaje: si la página lee sender.track, ve su track original
  if (_origTrackGet) {
    Object.defineProperty(RTCRtpSender.prototype, 'track', {
      get: function () {
        if (senderOriginalTrack.has(this)) {
          const real = _origTrackGet.call(this);
          // Si la página ya soltó el sender (track null), no mentir
          return real ? senderOriginalTrack.get(this) : real;
        }
        return _origTrackGet.call(this);
      },
      configurable: true
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. Watchdog: re-afirmar el mixer en todos los senders de audio
  // ══════════════════════════════════════════════════════════════════
  function audioSenders() {
    const out = [];
    for (const pc of Array.from(peerConnections)) {
      let senders;
      try {
        if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
          peerConnections.delete(pc);
          continue;
        }
        senders = pc.getSenders();
      } catch (e) {
        peerConnections.delete(pc);
        continue;
      }
      for (const s of senders) {
        const t = _origTrackGet ? _origTrackGet.call(s) : s.track;
        if (t && t.kind === 'audio') out.push({ sender: s, track: t });
      }
    }
    return out;
  }

  setInterval(() => {
    if (!mixerDest) return;

    // Reconstruir el mixer si su track base murió
    if (!isLive(baseMixedTrack())) {
      console.warn('[MT Mixer] ⚠️ El track base del mixer murió. Reconstruyendo...');
      ensureMixer();
    }

    for (const { sender, track } of audioSenders()) {
      const drifted = !ourTracks.has(track);
      const dead = track.readyState !== 'live';
      if (!drifted && !dead) continue;

      const fresh = freshMixedTrack();
      if (!fresh) continue;

      _origReplaceTrack.call(sender, fresh).then(() => {
        diag.watchdogReasserts++;
        notify('TRACK_REPLACED');
        console.log('[MT Mixer] 🛡️ Watchdog: track del mixer re-afirmado en el sender (' +
          (drifted ? 'la página lo reemplazó' : 'track muerto') + ')');
      }).catch(err => {
        diag.lastError = 'watchdog replaceTrack: ' + err.message;
      });
    }
  }, WATCHDOG_MS);

  // ══════════════════════════════════════════════════════════════════
  // 4. Reproducción de TTS traducido (agendado secuencialmente)
  // ══════════════════════════════════════════════════════════════════
  let ttsQueue = Promise.resolve();

  function enqueueTTS(buffers) {
    ttsQueue = ttsQueue.then(() => playTTSBuffers(buffers)).catch(() => {});
    return ttsQueue;
  }

  async function playTTSBuffers(buffers) {
    if (!ensureMixer() || !ttsGain) {
      diag.ttsChunksFailed += buffers.length;
      notify('TTS_FAILED');
      console.warn('[MT Mixer] ⚠️ Mixer no disponible para reproducir TTS');
      return;
    }

    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch (e) {}
    }

    let played = 0;
    let totalDuration = 0;

    for (const raw of buffers) {
      try {
        const audioBuffer = await audioCtx.decodeAudioData(raw.slice(0));
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ttsGain);

        const startAt = Math.max(audioCtx.currentTime + 0.05, ttsCursor);
        source.start(startAt);
        ttsCursor = startAt + audioBuffer.duration + CHUNK_GAP;

        played++;
        totalDuration += audioBuffer.duration;
        diag.ttsChunksPlayed++;
      } catch (e) {
        diag.ttsChunksFailed++;
        diag.lastError = 'decodeAudioData: ' + e.message;
        console.warn('[MT Mixer] Error decodificando fragmento TTS:', e);
      }
    }

    if (played > 0) {
      notify('TTS_PLAYING');
      console.log('[MT Mixer] 🔊 ' + played + ' fragmento(s) TTS inyectado(s) en WebRTC (' +
        (Math.round(totalDuration * 10) / 10) + 's de audio)');
    } else {
      notify('TTS_ERROR');
    }
  }

  /**
   * Tono de prueba: inyecta un beep de 1.2s directamente en el canal TTS.
   * Si el receptor OYE el beep ➔ el camino WebRTC funciona y el fallo está
   * en la descarga/decodificación del TTS. Si NO lo oye ➔ el mixer no está
   * en el camino de audio que Meet transmite.
   */
  function playTestTone() {
    if (!ensureMixer()) return false;
    try {
      const osc = audioCtx.createOscillator();
      const env = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      env.gain.value = 0.35;
      osc.connect(env);
      env.connect(ttsGain);
      const t0 = audioCtx.currentTime + 0.05;
      osc.start(t0);
      osc.stop(t0 + 1.2);
      notify('SELFTEST_TONE');
      console.log('[MT Mixer] 🧪 Tono de prueba de 880 Hz inyectado en el canal TTS');
      return true;
    } catch (e) {
      diag.lastError = 'playTestTone: ' + e.message;
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. Diagnóstico del estado real del camino de audio
  // ══════════════════════════════════════════════════════════════════
  function currentLevel() {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return Math.min(100, Math.round((sum / data.length / 128) * 100));
  }

  function buildReport() {
    const base = baseMixedTrack();
    const senders = audioSenders();
    const carrying = senders.filter(s => ourTracks.has(s.track));
    const enabledCarrying = carrying.filter(s => s.track.enabled);

    return {
      instalado: true,
      audioContext: audioCtx ? audioCtx.state : 'no creado',
      mixerTrack: base
        ? { id: base.id, readyState: base.readyState, enabled: base.enabled, muted: base.muted }
        : null,
      microfonoFisico: diag.micLabel,
      micGain: micGain ? micGain.gain.value : null,
      ttsGain: ttsGain ? ttsGain.gain.value : null,
      nivelActual: currentLevel(),
      peerConnections: peerConnections.size,
      sendersDeAudio: senders.length,
      sendersConNuestroMixer: carrying.length,
      sendersHabilitados: enabledCarrying.length,
      // Si hay senders con nuestro track pero deshabilitados, Meet está muteado
      meetMuteado: carrying.length > 0 && enabledCarrying.length === 0,
      contadores: { ...diag }
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. Puente con content.js (ISOLATED world)
  // ══════════════════════════════════════════════════════════════════
  function notify(status) {
    window.postMessage({ type: 'MT_MIXER_STATUS_UPDATE', status: status }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || !event.data.type) return;

    switch (event.data.type) {
      case 'MT_PLAY_TTS_INTO_CALL': {
        // Acepta un solo ArrayBuffer o una lista (fragmentos en orden)
        const payload = event.data.audioDataList || event.data.audioData;
        const list = Array.isArray(payload) ? payload : (payload ? [payload] : []);
        const buffers = list.filter(b => b && b.byteLength > 0);
        if (buffers.length > 0) {
          enqueueTTS(buffers);
        } else {
          console.warn('[MT Mixer] MT_PLAY_TTS_INTO_CALL recibido sin datos de audio utilizables');
          notify('TTS_ERROR');
        }
        break;
      }

      case 'MT_SET_MIC_MUTE': {
        const next = !!event.data.muted;
        const changed = next !== isMicMuted;
        isMicMuted = next;
        if (micGain && audioCtx) {
          micGain.gain.setValueAtTime(isMicMuted ? 0.0 : 1.0, audioCtx.currentTime);
        }
        if (changed) {
          notify(isMicMuted ? 'MIC_MUTED' : 'MIC_UNMUTED');
          console.log('[MT Mixer] ' + (isMicMuted
            ? '🔇 Voz en español SILENCIADA en la llamada (micGain = 0.0)'
            : '🎙️ Voz directa ACTIVA en la llamada (micGain = 1.0)'));
        }
        break;
      }

      case 'MT_MIXER_SELFTEST':
        playTestTone();
        break;

      case 'MT_MIXER_DIAG':
        window.postMessage({ type: 'MT_MIXER_DIAG_RESULT', report: buildReport() }, '*');
        break;

      case 'MT_MIXER_STATUS':
        window.postMessage({
          type: 'MT_MIXER_STATUS_RESPONSE',
          isActive: !!baseMixedTrack(),
          micMuted: isMicMuted
        }, '*');
        break;
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. Liberación del micrófono al abandonar la página
  //
  // Como el mixer retiene el micrófono físico (para que Meet no pueda
  // matarlo con track.stop()), hay que soltarlo explícitamente cuando la
  // pestaña se cierra o navega. No se libera antes: el mixer alimenta la
  // llamada, y soltarlo durante la reunión dejaría al usuario mudo.
  // ══════════════════════════════════════════════════════════════════
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // va al bfcache, puede volver
    try {
      if (rawMicStream) rawMicStream.getTracks().forEach(t => t.stop());
      for (const t of ourTracks) { try { t.stop(); } catch (e) {} }
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    } catch (e) {}
  });

  console.log('[MT Mixer] 🎯 Interceptores instalados en document_start ' +
    '(getUserMedia + addTrack + addTransceiver + replaceTrack + watchdog)');
})();
