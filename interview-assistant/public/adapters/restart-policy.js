/** Exponential backoff for restarting the speech recognizer: 250, 500, 1000, 2000, 2000… ms; `reset()` after a good result. */
export function createRestartPolicy({ initialMs = 250, maxMs = 2000 } = {}) {
  let delay = initialMs;
  return {
    nextDelay() {
      const current = delay;
      delay = Math.min(delay * 2, maxMs);
      return current;
    },
    reset() {
      delay = initialMs;
    },
  };
}
