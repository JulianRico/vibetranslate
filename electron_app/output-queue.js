/**
 * output-queue.js - Cola ordenada para la salida (traducir ➔ subtítulo ➔ voz)
 * La captura de audio encola y sigue; nunca espera a que termine la voz sintetizada.
 */

function createOutputQueue({ onError = () => {} } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  let epoch = 0;

  return {
    push(job) {
      pending++;
      const mine = epoch;
      tail = tail
        .then(() => (mine === epoch ? job({ backlog: pending - 1 }) : undefined))
        .catch(onError)
        .finally(() => { pending--; });
      return tail;
    },
    /** Descarta lo que aún no ha empezado (el trabajo en curso termina). */
    reset() { epoch++; },
    size: () => pending
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOutputQueue };
}
