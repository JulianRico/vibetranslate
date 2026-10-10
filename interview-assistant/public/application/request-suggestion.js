import { pushMetric } from './metrics.js';
import { findPrepared } from '../domain/prepared-matcher.js';

const FINALS_PER_SUGGESTION = 3;
const HISTORY_TURNS = 4;
const MAX_TEXT = 600; // the server rejects longer strings

const clip = (text) => (text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text);
const setSuggestions = (s, status, detail = '') => ({ ...s, statuses: { ...s.statuses, suggestions: { status, detail } } });

/**
 * Asks for a suggestion when a turn closes. Only the latest request may update the screen:
 * a newer turn aborts the previous request and any late answer is dropped.
 * `gateways` = { cloud, nano }; the one named by `state.provider` is used.
 * Before asking, a strong match with a prepared answer is shown instantly instead (no gateway call); `askAi()` skips that shortcut.
 */
export function createRequestSuggestion({ gateways, store, clock = { now: () => Date.now() } }) {
  let requestId = 0;
  let controller = null;
  let lastTurn = null;

  /** Shows a prepared answer as the suggestion: instant, offline, and it supersedes any request in flight. */
  function showPrepared(turn, hit) {
    controller?.abort();
    controller = null;
    requestId++;
    lastTurn = turn;
    store.update((s) => ({
      ...setSuggestions(s, 'ready'),
      history: [...s.history.filter((h) => h.id !== turn.id), { id: turn.id, interviewer: clip(turn.text), suggestedAnswer: clip(hit.answer.en) }],
      suggestion: {
        state: 'ready',
        source: 'prepared',
        preparedId: hit.id,
        preparedStatus: hit.status,
        suggestion: { questionEs: '', intent: hit.question, points: hit.points, answer: hit.answer },
        usedContext: [],
        omittedContext: [],
      },
    }));
  }

  async function request(turn, { skipPrepared = false } = {}) {
    if (!skipPrepared) {
      const hit = findPrepared(turn.text, store.getState().prepared.items);
      if (hit) { showPrepared(turn, hit); return; }
    }
    controller?.abort();
    const id = ++requestId;
    controller = new AbortController();
    const { signal } = controller;
    lastTurn = turn;
    const startedAt = clock.now();

    const state = store.getState();
    const gateway = gateways[state.provider] ?? gateways.cloud;
    const history = state.history
      .filter((h) => h.id !== turn.id)
      .slice(-HISTORY_TURNS)
      .map(({ interviewer, suggestedAnswer }) => ({ interviewer, ...(suggestedAnswer ? { suggestedAnswer } : {}) }));
    const entry = { id: turn.id, interviewer: clip(turn.text) };

    store.update((s) => ({
      ...setSuggestions(s, 'working'),
      history: [...s.history.filter((h) => h.id !== turn.id), entry],
      suggestion: { state: 'thinking', turnText: turn.text },
    }));

    try {
      const result = await gateway.suggest({ turns: turn.finals.slice(-FINALS_PER_SUGGESTION).map(clip), history }, { signal });
      if (id !== requestId) return;
      const answer = result.suggestion.answer?.en;
      const took = clock.now() - startedAt;
      store.update((s) => ({
        ...setSuggestions(s, 'ready'),
        metrics: { ...s.metrics, suggestion: pushMetric(s.metrics.suggestion, took) },
        history: s.history.map((h) => (h.id === turn.id && answer ? { ...h, suggestedAnswer: clip(answer) } : h)),
        suggestion: { state: 'ready', ...result },
      }));
    } catch (err) {
      if (id !== requestId || err?.name === 'AbortError') return;
      store.update((s) => ({ ...setSuggestions(s, 'error', err.message), suggestion: { state: 'error', message: err.message } }));
    }
  }

  return {
    request,
    /** Repeats the last request (the "Reintentar" button). */
    retry: () => (lastTurn ? request(lastTurn) : Promise.resolve()),
    /** The "Pedir a la IA" button: repeats the last turn with Gemini even if a prepared answer matches. */
    askAi: () => (lastTurn ? request(lastTurn, { skipPrepared: true }) : Promise.resolve()),
    /** Drops the request in flight, if any. */
    cancel() {
      requestId++;
      controller?.abort();
      controller = null;
      store.update((s) => (s.suggestion.state === 'thinking' ? { ...setSuggestions(s, 'idle'), suggestion: { state: 'idle' } } : s));
    },
  };
}
