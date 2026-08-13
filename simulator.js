/**
 * simulator.js - Controlador de la Sala de Reunión Virtual & Simulador Bilingüe
 * Implementa la simulación interactiva bidireccional entre Julián (Español 🇪🇸) y Alex (Inglés 🇺🇸).
 */

(function () {
  'use strict';

  // UI - Navbar & Controles
  const btnToggleRoom = document.getElementById('btn-toggle-room');
  const badgeRoom = document.getElementById('badge-room');
  const badgeMicA = document.getElementById('badge-mic-a');
  const badgeMicB = document.getElementById('badge-mic-b');

  // UI - Hablante A (Julián - ES)
  const sttAOrig = document.getElementById('stt-a-orig');
  const sttATrans = document.getElementById('stt-a-trans');
  const barVolMicA = document.getElementById('bar-vol-mic-a');
  const txtVolMicA = document.getElementById('txt-vol-mic-a');
  const barVolOutA = document.getElementById('bar-vol-out-a');
  const txtVolOutA = document.getElementById('txt-vol-out-a');
  const chkMuteSpA = document.getElementById('chk-mute-sp-a');
  const inputPhraseA = document.getElementById('input-phrase-a');
  const btnSpeakA = document.getElementById('btn-speak-a');

  // UI - Participante B (Alex - EN)
  const sttBOrig = document.getElementById('stt-b-orig');
  const sttBTrans = document.getElementById('stt-b-trans');
  const barVolRecvB = document.getElementById('bar-vol-recv-b');
  const txtVolRecvB = document.getElementById('txt-vol-recv-b');
  const chkListenB = document.getElementById('chk-listen-b');
  const inputPhraseB = document.getElementById('input-phrase-b');
  const btnSpeakB = document.getElementById('btn-speak-b');

  const logBox = document.getElementById('log-box');

  // Estado del Pipeline
  let isRoomActive = false;
  let rawMicStreamA = null;
  let audioCtx = null;

  let micGainA = null;
  let ttsGainA = null;
  let mixerDestA = null;

  let analyserMicA = null;
  let analyserOutA = null;
  let analyserRecvB = null;

  let speechRecognitionA = null;
  let alexSpeakerAudio = new Audio();

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    logBox.textContent += `[${time}] ${msg}\n`;
    logBox.scrollTop = logBox.scrollHeight;
    console.log('[VirtualRoom]', msg);
  }

  btnToggleRoom.addEventListener('click', async () => {
    if (isRoomActive) {
      stopVirtualRoom();
    } else {
      await startVirtualRoom();
    }
  });

  async function startVirtualRoom() {
    log('Iniciando Sala de Reunión Virtual Bilingüe...');
    try {
      // 1. Capturar micrófono físico del Hablante A (Julián)
      rawMicStreamA = await navigator.mediaDevices.getUserMedia({ audio: true });
      log('✅ Micrófono físico de Julián activado.');

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // 2. Analyser del micrófono físico de Julián
      const micSourceA = audioCtx.createMediaStreamSource(rawMicStreamA);
      analyserMicA = audioCtx.createAnalyser();
      analyserMicA.fftSize = 256;
      micSourceA.connect(analyserMicA);

      // 3. Crear Mixer de Audio WebRTC (Canal que se transmite a Alex)
      mixerDestA = audioCtx.createMediaStreamDestination();

      micGainA = audioCtx.createGain();
      micGainA.gain.value = chkMuteSpA.checked ? 0.0 : 1.0;

      micSourceA.connect(micGainA);
      micGainA.connect(mixerDestA);

      ttsGainA = audioCtx.createGain();
      ttsGainA.gain.value = 2.5;
      ttsGainA.connect(mixerDestA);

      // 4. Analyser del canal transmitido a Alex
      analyserOutA = audioCtx.createAnalyser();
      analyserOutA.fftSize = 256;
      const outSourceA = audioCtx.createMediaStreamSource(mixerDestA.stream);
      outSourceA.connect(analyserOutA);

      // 5. Conectar parlantes de Alex
      alexSpeakerAudio.srcObject = mixerDestA.stream;
      alexSpeakerAudio.muted = !chkListenB.checked;
      alexSpeakerAudio.play().catch(() => {});

      const recvSourceB = audioCtx.createMediaStreamSource(mixerDestA.stream);
      analyserRecvB = audioCtx.createAnalyser();
      analyserRecvB.fftSize = 256;
      recvSourceB.connect(analyserRecvB);

      isRoomActive = true;

      btnToggleRoom.innerHTML = '<span>⏹️ Salir de la Reunión</span>';
      btnToggleRoom.className = 'btn btn-stop';

      badgeRoom.className = 'status-badge badge-live';
      badgeRoom.innerHTML = '<span class="live-dot"></span> EN VIVO';

      badgeMicA.className = 'status-badge badge-live'; badgeMicA.textContent = 'MIC ACTIVO';
      badgeMicB.className = 'status-badge badge-live'; badgeMicB.textContent = 'OYENTE EN VIVO';

      startSpeechRecognitionA();
      updateMetersLoop();

      log('🎉 ¡Reunión Virtual activada! Habla por tu micrófono en español o usa las frases de prueba.');

    } catch (err) {
      log(`❌ Error al conectar a la reunión: ${err.message}`);
      stopVirtualRoom();
    }
  }

  function stopVirtualRoom() {
    isRoomActive = false;
    stopSpeechRecognitionA();

    if (rawMicStreamA) {
      rawMicStreamA.getTracks().forEach(t => t.stop());
      rawMicStreamA = null;
    }

    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }

    btnToggleRoom.innerHTML = '<span>▶️ Entrar a la Reunión Virtual</span>';
    btnToggleRoom.className = 'btn btn-start';

    badgeRoom.className = 'status-badge badge-off'; badgeRoom.textContent = 'EN ESPERA';
    badgeMicA.className = 'status-badge badge-off'; badgeMicA.textContent = 'MIC OFF';
    badgeMicB.className = 'status-badge badge-off'; badgeMicB.textContent = 'OYENTE';

    barVolMicA.style.width = '0%'; txtVolMicA.textContent = '0%';
    barVolOutA.style.width = '0%'; txtVolOutA.textContent = '0%';
    barVolRecvB.style.width = '0%'; txtVolRecvB.textContent = '0%';

    log('Reunión Virtual finalizada.');
  }

  // Control de silenciado de voz original en español
  chkMuteSpA.addEventListener('change', () => {
    const isMuted = chkMuteSpA.checked;
    if (micGainA && audioCtx) {
      micGainA.gain.setValueAtTime(isMuted ? 0.0 : 1.0, audioCtx.currentTime);
    }
    if (isMuted) {
      barVolOutA.classList.add('muted');
      log('🔇 Micrófono original en español SILENCIADO (Ganancia = 0.0). Tu voz directa no viajará por la llamada.');
    } else {
      barVolOutA.classList.remove('muted');
      log('🎙️ Micrófono original ACTIVADO. Tu voz directa en español viajará por la llamada.');
    }
  });

  chkListenB.addEventListener('change', () => {
    alexSpeakerAudio.muted = !chkListenB.checked;
    log(chkListenB.checked ? '🔊 Escucha del receptor activada en tus audífonos.' : '🔇 Escucha del receptor silenciada.');
  });

  // HABLAR FRASE DE PRUEBA DESDE JULIÁN (ES ➔ EN)
  btnSpeakA.addEventListener('click', async () => {
    const text = inputPhraseA.value.trim();
    if (!text) return;

    sttAOrig.textContent = text;
    log(`[Julián habla ES] "${text}"`);

    // Traducir a inglés
    const translated = await translateText(text, 'es', 'en');
    sttATrans.textContent = translated;
    log(`[Traducción -> Alex EN] "${translated}"`);

    // Transmitir voz hablada en inglés a Alex
    await transmitTTS(translated, 'en');
  });

  // RESPONDER COMO ALEX (EN ➔ ES)
  btnSpeakB.addEventListener('click', async () => {
    const text = inputPhraseB.value.trim();
    if (!text) return;

    sttBOrig.textContent = text;
    log(`[Alex responde EN] "${text}"`);

    // Traducir a español
    const translated = await translateText(text, 'en', 'es');
    sttBTrans.textContent = translated;
    log(`[Traducción -> Julián ES] "${translated}"`);

    // Reproducir respuesta en español para Julián
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(translated);
      utterance.lang = 'es-ES';
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    }
  });

  // Función para transmitir audio TTS en inglés a Alex con chunking automático de párrafos largos
  async function transmitTTS(text, lang) {
    if (!isRoomActive || !audioCtx || !ttsGainA) {
      log('⚠️ Entra a la reunión virtual antes de transmitir.');
      return;
    }

    try {
      // Dividir texto largo en fragmentos de máximo 140 caracteres para evitar HTTP 400 de Google TTS
      const words = (text || '').split(' ');
      const chunks = [];
      let cur = '';
      for (const w of words) {
        if ((cur + ' ' + w).trim().length <= 140) {
          cur = (cur + ' ' + w).trim();
        } else {
          if (cur) chunks.push(cur);
          cur = w;
        }
      }
      if (cur) chunks.push(cur);

      let scheduleTime = audioCtx.currentTime;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=${lang}&client=tw-ob`;
        const res = await fetch(url);
        if (!res.ok) continue;

        const arrayBuffer = await res.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ttsGainA);
        source.start(scheduleTime);

        scheduleTime += audioBuffer.duration;
      }

      log(`🔊 Audio traducido en inglés transmitido a Alex (${chunks.length} fragmento(s))`);
    } catch (err) {
      log(`⚠️ Error transmitiendo audio TTS: ${err.message}`);
    }
  }

  // Traducción vía Google Translate GTX API
  async function translateText(text, src, tgt) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${src}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && Array.isArray(data[0])) {
        return data[0].map(c => c[0]).filter(Boolean).join('');
      }
    } catch (e) {}
    return text;
  }

  // Reconocimiento de voz continuo de Julián
  function startSpeechRecognitionA() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    speechRecognitionA = new SpeechRecognition();
    speechRecognitionA.continuous = true;
    speechRecognitionA.interimResults = true;
    speechRecognitionA.lang = 'es-ES';

    let processedWordIndexA = 0;

    speechRecognitionA.onresult = async (event) => {
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
      if (!text) return;

      sttAOrig.textContent = text;
      const words = text.split(/\s+/);
      const isFinal = finalStr.length > 0;
      const newWords = words.slice(processedWordIndexA);

      // Interpretación simultánea continua en streaming: enviar cada 4 palabras o pausa
      if (newWords.length >= 4 || isFinal) {
        const clause = newWords.join(' ');
        if (clause.trim().length > 0) {
          processedWordIndexA = words.length;
          const translatedClause = await translateText(clause.trim(), 'es', 'en');
          sttATrans.textContent = translatedClause;
          log(`[⚡ Interpretación Simultánea -> Alex EN] "${translatedClause}"`);
          await transmitTTS(translatedClause, 'en');
        }
      } else {
        const previewTranslated = await translateText(text, 'es', 'en');
        sttATrans.textContent = previewTranslated;
      }

      if (isFinal) {
        processedWordIndexA = 0;
      }
    };

    speechRecognitionA.onerror = (e) => {
      if (e.error !== 'no-speech') console.warn('STT Error:', e.error);
    };

    speechRecognitionA.onend = () => {
      if (isRoomActive && speechRecognitionA) {
        try { speechRecognitionA.start(); } catch (e) {}
      }
    };

    try { speechRecognitionA.start(); } catch (e) {}
  }

  function stopSpeechRecognitionA() {
    if (speechRecognitionA) {
      try {
        speechRecognitionA.onend = null;
        speechRecognitionA.stop();
      } catch (e) {}
      speechRecognitionA = null;
    }
  }

  // Bucle de actualización de los VU meters
  function updateMetersLoop() {
    if (!isRoomActive) return;

    const micVol = getVol(analyserMicA);
    const outVol = getVol(analyserOutA);
    const recvVol = getVol(analyserRecvB);

    barVolMicA.style.width = `${micVol}%`;
    txtVolMicA.textContent = `${micVol}%`;

    barVolOutA.style.width = `${outVol}%`;
    txtVolOutA.textContent = `${outVol}%`;

    barVolRecvB.style.width = `${recvVol}%`;
    txtVolRecvB.textContent = `${recvVol}%`;

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
