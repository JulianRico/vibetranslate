/** Manual clock: timers only fire when the test calls advance(ms). */
export function createFakeScheduler() {
  let now = 0;
  let timers = [];
  return {
    after(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => { timers = timers.filter((t) => t !== timer); };
    },
    advance(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        if (!timers.includes(timer)) continue;
        timers = timers.filter((t) => t !== timer);
        timer.fn();
      }
    },
    pending: () => timers.length,
  };
}

/** Fake SpeechRecognizerPort with helpers to emit what the microphone "hears". */
export function createFakeSpeech({ ensureReady = async () => {} } = {}) {
  let partialCb = () => {};
  let finalCb = () => {};
  let stateCb = () => {};
  const calls = [];
  return {
    calls,
    ensureReady: async () => { calls.push('ensureReady'); return ensureReady(); },
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    onPartial: (cb) => { partialCb = cb; },
    onFinal: (cb) => { finalCb = cb; },
    onState: (cb) => { stateCb = cb; },
    emitPartial: (text) => partialCb(text),
    emitFinal: (text) => finalCb(text),
    emitState: (state) => stateCb(state),
  };
}

/** Fake TranslatorPort; `delays` maps a text to a delay in ms (to test ordering). */
export function createFakeTranslator({ ensureReady = async () => {}, delays = {}, fail = () => false } = {}) {
  let stateCb = () => {};
  const calls = [];
  return {
    calls,
    ensureReady: async () => { calls.push('ensureReady'); return ensureReady(); },
    translate: async (text) => {
      calls.push(text);
      if (delays[text]) await new Promise((r) => setTimeout(r, delays[text]));
      if (fail(text)) throw new Error('translation failed');
      return `ES:${text}`;
    },
    onState: (cb) => { stateCb = cb; },
    emitState: (state) => stateCb(state),
  };
}

/** Fake SuggestionGatewayPort. `responder(payload, { signal })` may return a value, a promise, or throw. */
export function createFakeSuggestionGateway(responder) {
  const calls = [];
  return {
    calls,
    suggest: async (payload, opts = {}) => {
      calls.push({ payload, signal: opts.signal });
      return responder(payload, opts);
    },
  };
}

export const SUGGESTION = Object.freeze({
  suggestion: {
    questionEs: '¿Cuéntame de ti?', intent: 'introducción',
    points: [{ en: 'Full Stack Lead', es: 'Líder Full Stack' }],
    answer: { en: 'I lead teams.', es: 'Lidero equipos.' },
  },
  usedContext: [], omittedContext: [],
});

export const tick = () => new Promise((r) => setImmediate(r));

/** Clock that advances by `step` ms every time it is read: a measured duration is then exactly `step`. */
export function createSteppingClock(step = 100) {
  let t = 0;
  return { now: () => { t += step; return t; } };
}
