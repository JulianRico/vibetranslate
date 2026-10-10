import { nextState } from '../domain/session-state.js';
import { createTurnBuffer } from '../domain/turn-buffer.js';
import { isBackchannel } from '../domain/backchannel.js';
import { pushMetric } from './metrics.js';

/**
 * Live session: turns what the microphone hears into transcript lines (EN + ES) and closed turns.
 * Speech and translator are ports; `requestSuggestion.request(turn)` is called when a turn closes.
 */
export function createSession({ speech, translator, requestSuggestion, store, scheduler, clock = { now: () => Date.now() } }) {
  let lineSeq = 0;
  let translations = Promise.resolve(); // the translation engine handles one text at a time: keep the order
  // "Okay." / "Great." from the interviewer is not a question: keep the answer Julian is reading.
  const buffer = createTurnBuffer({ scheduler, onTurnClosed: (turn) => { if (!isBackchannel(turn.text)) requestSuggestion.request(turn); } });

  const transition = (event) => store.update((s) => ({ ...s, session: nextState(s.session, event) }));
  const sessionIs = (...names) => names.includes(store.getState().session);
  const setStatus = (key, { status, detail = '' }) => store.update((s) => ({ ...s, statuses: { ...s.statuses, [key]: { status, detail } } }));

  function fail(err) {
    transition('fail');
    store.update({ error: err?.message || String(err) });
  }

  /** Julian is (or is no longer) talking: while speaking, nothing the microphone hears is kept. */
  function setSpeaking(speaking) {
    if (speaking && sessionIs('listening')) {
      transition('pause');
      buffer.pause();
      store.update({ partial: '' });
    } else if (!speaking && sessionIs('speaking')) {
      transition('resume');
      buffer.flush();
    }
  }

  speech.onState((state) => {
    setStatus('speech', state);
    if (state.fatal && sessionIs('listening', 'speaking')) fail(new Error(state.detail || 'El reconocimiento de voz se detuvo'));
  });
  translator.onState((state) => setStatus('translator', state));

  speech.onPartial((text) => {
    if (!sessionIs('listening')) return;
    store.update({ partial: text });
    buffer.addPartial();
  });

  speech.onFinal((text) => {
    if (!sessionIs('listening')) return;
    const id = `l${++lineSeq}`;
    store.update((s) => ({ ...s, partial: '', lines: [...s.lines, { id, en: text, es: null }] }));
    buffer.addFinal(text);
    translations = translations.then(async () => {
      let es;
      const startedAt = clock.now();
      try { es = await translator.translate(text); } catch { es = false; }
      const took = clock.now() - startedAt;
      store.update((s) => ({
        ...s,
        lines: s.lines.map((l) => (l.id === id ? { ...l, es } : l)),
        ...(es === false ? {} : { metrics: { ...s.metrics, translation: pushMetric(s.metrics.translation, took) } }),
      }));
    });
  });

  return {
    /** Must be called from a click: Chrome needs user activation to download the speech and translation models. */
    async start() {
      if (sessionIs('starting', 'listening', 'speaking')) return;
      transition('start');
      store.update({ error: '' });
      // Started together so the translator is created inside the click's user-activation window.
      const [speechReady] = await Promise.allSettled([speech.ensureReady(), translator.ensureReady()]);
      if (!sessionIs('starting')) return; // stopped while preparing
      if (speechReady.status === 'rejected') { fail(speechReady.reason); return; }
      speech.start();
      transition('ready');
    },

    stop() {
      speech.stop();
      buffer.reset();
      requestSuggestion.cancel();
      transition('stop');
      store.update({ partial: '' });
    },

    setSpeaking,
    toggleSpeaking: () => setSpeaking(sessionIs('listening')),

    /** Clears the transcript, the history and the current suggestion (e.g. after a practice call). */
    clear() {
      buffer.reset();
      requestSuggestion.cancel();
      store.update((s) => ({ ...s, lines: [], partial: '', history: [], suggestion: { state: 'idle' } }));
    },
  };
}
