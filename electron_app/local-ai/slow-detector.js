/**
 * slow-detector.js - Detecta un equipo que transcribe más lento de lo que se habla (el retraso se acumularía)
 */

function createSlowDetector({ limit = 3 } = {}) {
  let streak = 0;
  let warned = false;

  return {
    /** Devuelve true una sola vez, cuando `limit` frases seguidas tardaron más en transcribirse de lo que duraron. */
    observe({ sttMs, durationMs }) {
      streak = sttMs > durationMs ? streak + 1 : 0;
      if (streak >= limit && !warned) {
        warned = true;
        return true;
      }
      return false;
    },
    reset() {
      streak = 0;
      warned = false;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createSlowDetector };
}
