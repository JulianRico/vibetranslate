/**
 * audio-ducker.js - Baja el volumen de los demás programas mientras la app lee la traducción (solo Windows)
 *
 * Habla con audio-ducker.ps1, que usa el mezclador de Windows. Si la app se cierra, el auxiliar restaura los volúmenes.
 */

const READY_TIMEOUT_MS = 15000; // PowerShell tarda un par de segundos en compilar el auxiliar la primera vez
const REPLY_TIMEOUT_MS = 5000;

function createAudioDucker({ spawn, platform = process.platform, scriptPath, keepProcessName, readyTimeoutMs = READY_TIMEOUT_MS }) {
  let helper = null;
  let ready = null; // promesa que se resuelve (true/false) cuando el auxiliar contesta "ready"
  let active = false;
  let waiters = []; // respuestas pendientes, en orden

  function forget(proc) {
    if (helper !== proc) return;
    helper = null;
    ready = null;
    active = false;
    for (const waiter of waiters.splice(0)) waiter(null);
  }

  function start() {
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    helper = proc;
    let buffer = '';
    let resolveReady;
    ready = new Promise((resolve) => { resolveReady = resolve; });
    const timer = setTimeout(() => {
      resolveReady(false);
      proc.kill();
      forget(proc);
    }, readyTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line === 'ready') {
          clearTimeout(timer);
          resolveReady(true);
        } else if (line && waiters.length > 0) {
          waiters.shift()(line);
        }
      }
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      resolveReady(false);
      forget(proc);
    });
  }

  /** Envía una orden y espera su respuesta (null si el auxiliar no contesta). */
  function ask(command) {
    return new Promise((resolve) => {
      const proc = helper;
      if (!proc) return resolve(null);
      let done = false;
      const finish = (line) => { if (!done) { done = true; resolve(line); } };
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== finish);
        finish(null);
      }, REPLY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      waiters.push((line) => { clearTimeout(timer); finish(line); });
      proc.stdin.write(command + '\n');
    });
  }

  return {
    /** Baja los demás programas a `level` (0-1, relativo a su volumen). Devuelve si quedó activo. */
    async duck(level) {
      const off = { active: false, level: 1 };
      if (platform !== 'win32' || !Number.isFinite(level) || level >= 1 || level < 0) return off;
      if (!helper) start();
      if (!(await ready)) return off;
      const reply = await ask(`duck ${level} ${keepProcessName}`);
      active = typeof reply === 'string' && reply.startsWith('ducked');
      return active ? { active: true, level } : off;
    },

    /**
     * Al arrancar la app: si un cierre a la fuerza dejó programas atenuados (queda un archivo de estado),
     * el auxiliar los restaura nada más iniciarse.
     */
    async recover(stateFileExists) {
      if (platform !== 'win32' || !stateFileExists) return false;
      if (!helper) start();
      return ready;
    },

    async restore() {
      if (!helper) return;
      active = false;
      await ask('restore');
    },

    /** Al salir: cerrar la entrada hace que el auxiliar restaure y termine por sí mismo. */
    dispose() {
      const proc = helper;
      forget(proc);
      if (proc) proc.stdin.end();
    },

    isActive: () => active
  };
}

module.exports = { createAudioDucker };
