const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAudioDucker } = require('../audio-ducker');

/** Proceso auxiliar simulado: responde como audio-ducker.ps1. */
function setup({ platform = 'win32', ready = true, sessions = 3 } = {}) {
  const spawned = [];
  const spawn = (command, args) => {
    const proc = new EventEmitter();
    proc.command = command;
    proc.args = args;
    proc.stdout = new EventEmitter();
    proc.written = [];
    proc.ended = false;
    proc.stdin = {
      write: (line) => {
        proc.written.push(line.trim());
        if (line.startsWith('duck')) setImmediate(() => proc.stdout.emit('data', Buffer.from(`ducked ${sessions}\r\n`)));
        if (line.startsWith('restore')) setImmediate(() => proc.stdout.emit('data', Buffer.from(`restored ${sessions}\r\n`)));
      },
      end: () => { proc.ended = true; }
    };
    proc.kill = () => { proc.killed = true; };
    spawned.push(proc);
    if (ready) setImmediate(() => proc.stdout.emit('data', Buffer.from('ready\r\n')));
    return proc;
  };
  const ducker = createAudioDucker({ spawn, platform, scriptPath: 'C:/app/audio-ducker.ps1', keepProcessName: 'ViBeTranslate Pro Studio', readyTimeoutMs: 50 });
  return { ducker, spawned };
}

test('duck arranca el auxiliar una sola vez y baja los demás programas al nivel pedido, sin tocar la propia app', async () => {
  const t = setup();
  assert.deepEqual(await t.ducker.duck(0.05), { active: true, level: 0.05 });
  assert.deepEqual(await t.ducker.duck(0.1), { active: true, level: 0.1 });
  assert.equal(t.spawned.length, 1);
  assert.equal(t.spawned[0].command, 'powershell');
  assert.ok(t.spawned[0].args.includes('C:/app/audio-ducker.ps1'));
  assert.deepEqual(t.spawned[0].written, ['duck 0.05 ViBeTranslate Pro Studio', 'duck 0.1 ViBeTranslate Pro Studio']);
});

test('restore devuelve los volúmenes y deja el auxiliar listo para la próxima vez', async () => {
  const t = setup();
  await t.ducker.duck(0.05);
  await t.ducker.restore();
  assert.equal(t.spawned[0].written[1], 'restore');
  assert.equal(t.ducker.isActive(), false);
});

test('restore sin haber bajado nada no arranca ningún proceso', async () => {
  const t = setup();
  await t.ducker.restore();
  assert.equal(t.spawned.length, 0);
});

test('un nivel del 100 % o inválido no baja nada', async () => {
  const t = setup();
  assert.deepEqual(await t.ducker.duck(1), { active: false, level: 1 });
  assert.deepEqual(await t.ducker.duck(Number.NaN), { active: false, level: 1 });
  assert.equal(t.spawned.length, 0);
});

test('fuera de Windows no hace nada y lo dice', async () => {
  const t = setup({ platform: 'darwin' });
  assert.deepEqual(await t.ducker.duck(0.05), { active: false, level: 1 });
  assert.equal(t.spawned.length, 0);
});

test('si el auxiliar no arranca, duck responde que no está activo en vez de quedarse esperando', async () => {
  const t = setup({ ready: false });
  assert.deepEqual(await t.ducker.duck(0.05), { active: false, level: 1 });
  assert.equal(t.spawned[0].killed, true);
});

test('si el auxiliar muere, se da por restaurado y el siguiente duck lanza otro', async () => {
  const t = setup();
  await t.ducker.duck(0.05);
  t.spawned[0].emit('exit', 1);
  assert.equal(t.ducker.isActive(), false);
  await t.ducker.duck(0.05);
  assert.equal(t.spawned.length, 2);
});

test('dispose cierra la entrada del auxiliar: él mismo restaura los volúmenes al terminar', async () => {
  const t = setup();
  await t.ducker.duck(0.05);
  t.ducker.dispose();
  assert.equal(t.spawned[0].ended, true);
  assert.equal(t.ducker.isActive(), false);
});

test('al arrancar, si quedó un estado de un cierre a la fuerza, el auxiliar se lanza para restaurar los volúmenes', async () => {
  const leftover = setup();
  assert.equal(await leftover.ducker.recover(true), true);
  assert.equal(leftover.spawned.length, 1);

  const clean = setup();
  assert.equal(await clean.ducker.recover(false), false);
  assert.equal(clean.spawned.length, 0);
});
