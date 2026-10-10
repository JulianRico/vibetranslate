/**
 * prepare.js - Preparación del motor local: descarga lo que falte y arranca el proceso, salvo que el usuario lo detenga antes
 */

const STOP_GRACE_MS = 4000;

function createPrepare({ store, client, onProgress = () => {} }) {
  let epoch = 0; // cambia con cada parada: una preparación anterior a la parada no debe arrancar nada

  return {
    async prepare({ vadThreshold = 0.5 } = {}) {
      const mine = epoch;
      try {
        if (!store.status().ready) await store.ensure(onProgress);
        if (mine !== epoch) return { ok: false, cancelled: true };
        const ready = await client.start({ paths: store.paths(), vadThreshold });
        return { ok: true, loadMs: ready.loadMs };
      } catch (err) {
        if (mine !== epoch) return { ok: false, cancelled: true };
        return { ok: false, error: err.message };
      }
    },
    /** Detiene dejando un margen para que la frase en curso se cierre y se traduzca. */
    cancel() {
      epoch++;
      client.stop({ graceMs: STOP_GRACE_MS });
    }
  };
}

module.exports = { createPrepare };
