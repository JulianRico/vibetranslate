/** Tiny observable state container. `update` takes a patch object or a function(state) → state. */
export function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  return {
    getState: () => state,
    update(patch) {
      state = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      for (const fn of [...subscribers]) fn(state);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

export const initialState = () => ({
  session: 'idle',
  error: '',
  statuses: { speech: { status: 'idle' }, translator: { status: 'idle' }, suggestions: { status: 'idle' } },
  lines: [], // { id, en, es: null (pending) | string | false (translation failed) }
  partial: '',
  suggestion: { state: 'idle' }, // idle | thinking {turnText} | ready {suggestion, usedContext, omittedContext} | error {message}
  history: [], // { id, interviewer, suggestedAnswer? }
  metrics: { translation: [], suggestion: [] }, // last durations in ms (see metrics.js)
  prepared: { items: [], busy: null, progress: null, error: null }, // prepared answers; busy = an id or 'all', progress = { done, total }
  provider: 'cloud', // cloud | nano
  config: null,
  profile: null,
  context: { items: [], activeChars: 0, maxActiveChars: 30000, busy: null, error: null },
});
