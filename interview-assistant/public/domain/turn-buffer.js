export const SILENCE_MS = 1500;

/**
 * Groups the interviewer's FINAL phrases into turns. A turn closes after `silenceMs` without news
 * (the interviewer finished) and is handed to `onTurnClosed({ id, finals, text })`.
 * Time comes from the injected `scheduler` ({ after(ms, fn) → cancel }), so this is pure and testable.
 */
export function createTurnBuffer({ scheduler, onTurnClosed, silenceMs = SILENCE_MS }) {
  let finals = [];
  let cancel = null;
  let seq = 0;

  const stopTimer = () => { cancel?.(); cancel = null; };
  const arm = () => { stopTimer(); cancel = scheduler.after(silenceMs, close); };

  function close() {
    stopTimer();
    if (finals.length === 0) return;
    const turn = { id: `t${++seq}`, finals, text: finals.join(' ') };
    finals = [];
    onTurnClosed(turn);
  }

  return {
    /** A finished phrase: joins the open turn and restarts the silence countdown. */
    addFinal(text) {
      const phrase = String(text ?? '').trim();
      if (!phrase) return;
      finals.push(phrase);
      arm();
    },
    /** A provisional phrase: the interviewer is still talking, so the countdown restarts (only if a turn is open). */
    addPartial() {
      if (finals.length > 0) arm();
    },
    /** Julian starts speaking: keep what we have but stop the countdown. */
    pause: stopTimer,
    /** Closes the open turn right now (used when Julian stops speaking). */
    flush: close,
    hasOpenTurn: () => finals.length > 0,
    /** Forgets the open turn without emitting it. */
    reset() { stopTimer(); finals = []; },
  };
}
