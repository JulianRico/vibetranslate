/**
 * client.js - Lado del proceso principal: lanza el motor local, lo reinicia si muere y habla con él
 */

const RESTART_WINDOW_MS = 30000;

function createLocalAiClient({ fork, workerPath, onEvent, now = Date.now }) {
  let child = null;
  let initMsg = null;
  let lastCrashAt = -Infinity;
  let generation = 0;
  let readyWaiters = [];
  const translations = new Map();

  function failPending(error) {
    for (const waiter of translations.values()) waiter.reject(error);
    translations.clear();
    for (const waiter of readyWaiters.splice(0)) waiter.reject(error);
  }

  /** Cada proceso numera sus frases desde una base distinta: un identificador viejo nunca apunta al audio de otro proceso. */
  function sendInit(proc) {
    generation++;
    proc.postMessage({ ...initMsg, idBase: generation * 1000000 + 1 });
  }

  function spawn() {
    const proc = fork(workerPath);
    child = proc;

    proc.on('message', (msg) => {
      if (proc !== child) return;
      if (msg.type === 'ready') {
        for (const waiter of readyWaiters.splice(0)) waiter.resolve({ loadMs: msg.loadMs });
      } else if (msg.type === 'translation') {
        const waiter = translations.get(msg.id);
        if (!waiter) return;
        translations.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve({ text: msg.text, ms: msg.ms });
      } else if (msg.type === 'error' && msg.stage === 'init') {
        for (const waiter of readyWaiters.splice(0)) waiter.reject(new Error(msg.message));
      } else {
        onEvent(msg);
      }
    });

    proc.on('exit', (code) => {
      if (proc !== child) return; // lo detuvimos nosotros o ya fue reemplazado
      child = null;
      const crashedAt = now();
      const again = crashedAt - lastCrashAt < RESTART_WINDOW_MS;
      lastCrashAt = crashedAt;
      if (again) {
        failPending(new Error('El motor local se cerró'));
        onEvent({ type: 'error', stage: 'worker', fatal: true, message: `El motor local falló dos veces seguidas (código ${code}). Cambia a un motor en la nube o reinicia la aplicación.` });
        return;
      }
      for (const waiter of translations.values()) waiter.reject(new Error('El motor local se cerró'));
      translations.clear();
      onEvent({ type: 'error', stage: 'worker', fatal: false, message: 'El motor local se cerró y se está reiniciando.' });
      sendInit(spawn());
    });

    return proc;
  }

  function stop() {
    const proc = child;
    child = null;
    failPending(new Error('Motor local detenido'));
    if (proc) proc.kill();
  }

  return {
    start(init) {
      stop();
      initMsg = { type: 'init', ...init };
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        sendInit(spawn());
      });
    },
    send(msg) {
      if (child) child.postMessage(msg);
    },
    translate(id, target) {
      return new Promise((resolve, reject) => {
        if (!child) return reject(new Error('Motor local detenido'));
        translations.set(id, { resolve, reject });
        child.postMessage({ type: 'translate', id, target });
      });
    },
    stop,
    isRunning: () => child !== null
  };
}

module.exports = { createLocalAiClient };
