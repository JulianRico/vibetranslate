/**
 * client.js - Lado del proceso principal: lanza el motor local, lo vigila, lo reinicia si muere y habla con él
 */

const RESTART_WINDOW_MS = 30000;
const READY_TIMEOUT_MS = 60000; // cargar el modelo tarda 1-5 s; un minuto sin respuesta es un fallo
const PING_EVERY_MS = 5000;
const HUNG_AFTER_MS = 30000; // una transcripción bloquea el proceso unos segundos como mucho

const REAL_TIMERS = { setInterval, clearInterval, setTimeout, clearTimeout };

function createLocalAiClient({ fork, workerPath, onEvent, now = Date.now, timers = REAL_TIMERS }) {
  let child = null;
  let childReady = false;
  let lastSeenAt = 0;
  let draining = null; // proceso ya detenido que aún cierra y traduce su última frase
  let drainTimer = null;
  let readyTimer = null;
  let watchdog = null;
  let initMsg = null;
  let lastCrashAt = -Infinity;
  let generation = 0;
  let readyWaiters = [];
  const translations = new Map();

  // Los temporizadores no deben mantener viva la aplicación al salir
  const quiet = (timer) => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };

  function rejectTranslations(error) {
    for (const waiter of translations.values()) waiter.reject(error);
    translations.clear();
  }

  function rejectReady(error) {
    for (const waiter of readyWaiters.splice(0)) waiter.reject(error);
  }

  function clearChildTimers() {
    if (readyTimer) timers.clearTimeout(readyTimer);
    if (watchdog) timers.clearInterval(watchdog);
    readyTimer = null;
    watchdog = null;
  }

  function endDrain() {
    if (drainTimer) timers.clearTimeout(drainTimer);
    drainTimer = null;
    const proc = draining;
    draining = null;
    if (proc) proc.kill();
  }

  /** Cada proceso numera sus frases desde una base distinta: un identificador viejo nunca apunta al audio de otro proceso. */
  function sendInit(proc) {
    generation++;
    proc.postMessage({ ...initMsg, idBase: generation * 1000000 + 1 });
  }

  /** El proceso actual ya no sirve: se descarta y, si no acaba de pasar lo mismo, se lanza otro. */
  function onCrash(reason) {
    clearChildTimers();
    child = null;
    rejectTranslations(new Error('El motor local se cerró'));
    const crashedAt = now();
    const again = crashedAt - lastCrashAt < RESTART_WINDOW_MS;
    lastCrashAt = crashedAt;
    if (again) {
      rejectReady(new Error('El motor local se cerró'));
      onEvent({ type: 'error', stage: 'worker', fatal: true, message: `El motor local falló dos veces seguidas (${reason}). Cambia a un motor en la nube o reinicia la aplicación.` });
      return;
    }
    onEvent({ type: 'error', stage: 'worker', fatal: false, message: 'El motor local se cerró y se está reiniciando.' });
    sendInit(spawn());
  }

  /** El modelo no cargó: reintentar daría el mismo resultado. */
  function onInitFailure(proc, message) {
    clearChildTimers();
    child = null;
    proc.kill();
    rejectTranslations(new Error('El motor local se cerró'));
    if (readyWaiters.length > 0) {
      rejectReady(new Error(message));
    } else {
      onEvent({ type: 'error', stage: 'init', fatal: true, message: `El motor local no pudo cargar el modelo: ${message}` });
    }
  }

  function spawn() {
    const proc = fork(workerPath);
    child = proc;
    childReady = false;
    lastSeenAt = now();

    proc.on('message', (msg) => {
      if (proc === draining) {
        if (msg.type === 'translation') settleTranslation(msg);
        else if (msg.type === 'segment') onEvent({ ...msg, late: true });
        return;
      }
      if (proc !== child) return;
      lastSeenAt = now();
      if (msg.type === 'pong') return;
      if (msg.type === 'ready') {
        childReady = true;
        if (readyTimer) timers.clearTimeout(readyTimer);
        readyTimer = null;
        for (const waiter of readyWaiters.splice(0)) waiter.resolve({ loadMs: msg.loadMs });
      } else if (msg.type === 'translation') {
        settleTranslation(msg);
      } else if (msg.type === 'error' && msg.stage === 'init') {
        onInitFailure(proc, msg.message);
      } else {
        onEvent(msg);
      }
    });

    proc.on('exit', (code) => {
      if (proc === draining) {
        draining = null;
        if (drainTimer) timers.clearTimeout(drainTimer);
        drainTimer = null;
        return;
      }
      if (proc !== child) return; // lo detuvimos nosotros o ya fue reemplazado
      onCrash(`código ${code}`);
    });

    readyTimer = quiet(timers.setTimeout(() => {
      if (proc !== child || childReady) return;
      onInitFailure(proc, 'el motor no respondió al cargar');
    }, READY_TIMEOUT_MS));

    watchdog = quiet(timers.setInterval(() => {
      if (proc !== child || !childReady) return;
      if (now() - lastSeenAt > HUNG_AFTER_MS) {
        proc.kill();
        onCrash('dejó de responder');
        return;
      }
      proc.postMessage({ type: 'ping' });
    }, PING_EVERY_MS));

    return proc;
  }

  function settleTranslation(msg) {
    const waiter = translations.get(msg.id);
    if (!waiter) return;
    translations.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve({ text: msg.text, ms: msg.ms });
  }

  /**
   * Detiene el motor. Con `graceMs`, el proceso cierra la frase en curso y sigue atendiendo
   * traducciones durante ese margen antes de apagarse; ya no recibe audio nuevo.
   */
  function stop({ graceMs = 0 } = {}) {
    const proc = child;
    const wasReady = childReady;
    clearChildTimers();
    child = null;
    rejectReady(new Error('Motor local detenido'));
    endDrain();

    if (proc && wasReady && graceMs > 0) {
      draining = proc;
      proc.postMessage({ type: 'flush' });
      drainTimer = quiet(timers.setTimeout(() => {
        drainTimer = null;
        rejectTranslations(new Error('Motor local detenido'));
        endDrain();
      }, graceMs));
      return;
    }
    rejectTranslations(new Error('Motor local detenido'));
    if (proc) proc.kill();
  }

  return {
    start(init) {
      stop();
      lastCrashAt = -Infinity; // un arranque pedido por el usuario empieza de cero
      initMsg = { type: 'init', ...init };
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
        sendInit(spawn());
      });
    },
    send(msg) {
      if (child) child.postMessage(msg);
    },
    /** Cambia la sensibilidad de un flujo en plena sesión y la conserva para los reinicios. */
    configure({ stream, vadThreshold }) {
      if (stream === 'mic' && initMsg) initMsg = { ...initMsg, vadThreshold };
      if (child) child.postMessage({ type: 'config', stream, vadThreshold });
    },
    translate(id, target) {
      return new Promise((resolve, reject) => {
        const proc = child || draining;
        if (!proc) return reject(new Error('Motor local detenido'));
        translations.set(id, { resolve, reject });
        proc.postMessage({ type: 'translate', id, target });
      });
    },
    stop,
    isRunning: () => child !== null
  };
}

module.exports = { createLocalAiClient };
