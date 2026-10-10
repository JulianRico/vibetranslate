/**
 * output-queue.js - Cola ordenada para la salida (traducir ➔ subtítulo ➔ voz)
 * La captura de audio encola y sigue; nunca espera a que termine la voz sintetizada.
 */

function createOutputQueue({ onError = () => {} } = {}) {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    push(job) {
      pending++;
      tail = tail
        .then(() => job({ backlog: pending - 1 }))
        .catch(onError)
        .finally(() => { pending--; });
      return tail;
    },
    size: () => pending
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createOutputQueue };
}
