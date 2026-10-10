import { createRestartPolicy } from './restart-policy.js';

const FATAL_ERRORS = {
  'not-allowed': 'Chrome bloqueó el micrófono. Habilítalo en el candado de la barra de direcciones y recarga la página.',
  'service-not-allowed': 'Chrome no permite el reconocimiento de voz en esta página.',
  'language-not-supported': 'Falta el paquete de voz en inglés. Pulsa Iniciar de nuevo para instalarlo.',
};
const IGNORED_ERRORS = new Set(['no-speech', 'aborted']); // normal: Chrome ends the session and `onend` restarts it

/**
 * SpeechRecognizerPort backed by the Web Speech API in on-device mode (Chrome 139+).
 * Chrome ends recognition from time to time, so it restarts itself with backoff while the session is active.
 * `win` is injectable for tests.
 */
export function createWebSpeechRecognizer({ scheduler, win = globalThis, lang = 'en-US' }) {
  const Recognition = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  const policy = createRestartPolicy();
  let partialCb = () => {};
  let finalCb = () => {};
  let stateCb = () => {};
  let current = { status: 'idle', detail: '' };
  let local = true; // false when this Chrome has no on-device mode
  let wanted = false;
  let recognition = null;
  let cancelRestart = null;

  const setState = (status, detail = '', fatal = false) => {
    current = { status, detail, ...(fatal ? { fatal: true } : {}) };
    stateCb(current);
  };

  function begin() {
    cancelRestart = null;
    recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    if (local) recognition.processLocally = true;

    recognition.onstart = () => setState('working', local ? '' : 'sin modo local: el audio va a servidores de Google');
    recognition.onresult = (event) => {
      policy.reset();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) finalCb(text); else partialCb(text);
      }
    };
    recognition.onerror = (event) => {
      if (IGNORED_ERRORS.has(event.error)) return;
      if (FATAL_ERRORS[event.error]) {
        wanted = false;
        setState('error', FATAL_ERRORS[event.error], true);
        return;
      }
      setState('error', `Error de reconocimiento de voz: ${event.error}`);
    };
    recognition.onend = () => {
      if (!wanted) return;
      cancelRestart = scheduler.after(policy.nextDelay(), begin);
    };
    try {
      recognition.start();
    } catch (err) {
      setState('error', `No se pudo iniciar la escucha: ${err.message}`);
      if (wanted) cancelRestart = scheduler.after(policy.nextDelay(), begin);
    }
  }

  return {
    async ensureReady() {
      if (!Recognition) {
        setState('unavailable', 'Este navegador no tiene reconocimiento de voz', true);
        throw new Error('Este navegador no tiene reconocimiento de voz. Usa Chrome de escritorio.');
      }
      if (typeof Recognition.available === 'function') {
        const options = { langs: [lang], processLocally: true };
        const availability = await Recognition.available(options);
        if (availability === 'unavailable') {
          setState('unavailable', 'El reconocimiento de voz local no está disponible en este equipo', true);
          throw new Error('El reconocimiento de voz local no está disponible en este equipo.');
        }
        if (availability !== 'available') {
          setState('downloading', 'instalando el paquete de voz en inglés');
          const installed = await Recognition.install(options);
          if (!installed) {
            setState('error', 'No se pudo instalar el paquete de voz en inglés', true);
            throw new Error('No se pudo instalar el paquete de voz en inglés.');
          }
        }
        local = true;
      } else {
        local = false; // Chrome older than 139: cloud recognition only
      }
      setState('ready', local ? '' : 'sin modo local: el audio va a servidores de Google');
    },

    start() {
      wanted = true;
      policy.reset();
      begin();
    },

    stop() {
      wanted = false;
      cancelRestart?.();
      cancelRestart = null;
      try { recognition?.abort(); } catch { /* already stopped */ }
      setState('ready');
    },

    onPartial: (cb) => { partialCb = cb; },
    onFinal: (cb) => { finalCb = cb; },
    onState: (cb) => { stateCb = cb; cb(current); },
  };
}
