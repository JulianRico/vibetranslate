const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalAiClient } = require('../local-ai/client');

function setup() {
  const children = [];
  const events = [];
  let clock = 1000;
  const fork = (workerPath) => {
    const child = new EventEmitter();
    child.workerPath = workerPath;
    child.sent = [];
    child.killed = false;
    child.postMessage = (m) => child.sent.push(m);
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const client = createLocalAiClient({ fork, workerPath: '/app/worker.js', onEvent: (e) => events.push(e), now: () => clock });
  const init = { paths: { vad: 'v' }, vadThreshold: 0.5 };
  // stop() y las caídas rechazan el start pendiente: se silencia aquí para las pruebas que no lo esperan
  const start = () => { const p = client.start(init); p.catch(() => {}); return p; };
  return { client, children, events, init, start, advance: (ms) => { clock += ms; } };
}

test('start lanza el proceso, envía init y se resuelve cuando el motor está listo', async () => {
  const t = setup();
  const started = t.start();
  assert.equal(t.children[0].workerPath, '/app/worker.js');
  assert.deepEqual(t.children[0].sent, [{ type: 'init', paths: { vad: 'v' }, vadThreshold: 0.5, idBase: 1000001 }]);
  t.children[0].emit('message', { type: 'ready', loadMs: 1400 });
  assert.deepEqual(await started, { loadMs: 1400 });
  assert.equal(t.client.isRunning(), true);
});

test('start falla con el mensaje del motor si los modelos no cargan', async () => {
  const t = setup();
  const started = t.start();
  t.children[0].emit('message', { type: 'error', stage: 'init', message: 'modelo ilegible' });
  await assert.rejects(started, /modelo ilegible/);
});

test('los segmentos y avisos de voz llegan a onEvent; send reenvía al proceso', async () => {
  const t = setup();
  const started = t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  await started;
  t.client.send({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(4) });
  assert.equal(t.children[0].sent[1].type, 'audio');
  t.children[0].emit('message', { type: 'segment', id: 1, text: 'Hola.' });
  assert.deepEqual(t.events, [{ type: 'segment', id: 1, text: 'Hola.' }]);
});

test('translate se resuelve con la respuesta de su identificador o falla con su error', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  const ok = t.client.translate(3, 'en');
  const bad = t.client.translate(4, 'en');
  assert.deepEqual(t.children[0].sent.slice(1), [{ type: 'translate', id: 3, target: 'en' }, { type: 'translate', id: 4, target: 'en' }]);
  t.children[0].emit('message', { type: 'translation', id: 4, error: 'ya no está' });
  t.children[0].emit('message', { type: 'translation', id: 3, text: 'Hello.', ms: 400 });
  assert.deepEqual(await ok, { text: 'Hello.', ms: 400 });
  await assert.rejects(bad, /ya no está/);
  assert.deepEqual(t.events, []);
});

test('si el proceso muere se reinicia una vez con el mismo init y avisa sin ser fatal', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('message', { type: 'ready', loadMs: 1 });
  const pending = t.client.translate(1, 'en');
  t.children[0].emit('exit', 1);
  await assert.rejects(pending, /se cerró/);
  assert.equal(t.children.length, 2);
  // base distinta: una frase de antes del reinicio nunca coincide con un identificador nuevo
  assert.deepEqual(t.children[1].sent, [{ type: 'init', paths: { vad: 'v' }, vadThreshold: 0.5, idBase: 2000001 }]);
  assert.deepEqual(t.events, [{ type: 'error', stage: 'worker', fatal: false, message: 'El motor local se cerró y se está reiniciando.' }]);
  assert.equal(t.client.isRunning(), true);
});

test('una segunda caída en menos de 30 s es fatal y no se reinicia más', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('exit', 1);
  t.advance(10000);
  t.children[1].emit('exit', 1);
  assert.equal(t.children.length, 2);
  assert.equal(t.events[1].fatal, true);
  assert.match(t.events[1].message, /dos veces/);
  assert.equal(t.client.isRunning(), false);
});

test('una caída pasados 30 s se trata como la primera', async () => {
  const t = setup();
  t.start();
  t.children[0].emit('exit', 1);
  t.advance(31000);
  t.children[1].emit('exit', 1);
  assert.equal(t.children.length, 3);
  assert.equal(t.events[1].fatal, false);
});

test('stop mata el proceso, no lo reinicia y send deja de hacer nada', async () => {
  const t = setup();
  t.start();
  t.client.stop();
  assert.equal(t.children[0].killed, true);
  t.children[0].emit('exit', 0);
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.events, []);
  t.client.send({ type: 'audio' });
  await assert.rejects(t.client.translate(1, 'en'), /detenido/);
});

test('start sobre un cliente en marcha reemplaza el proceso anterior', async () => {
  const t = setup();
  t.start();
  t.start();
  assert.equal(t.children.length, 2);
  assert.equal(t.children[0].killed, true);
  t.children[0].emit('exit', 0);
  assert.equal(t.children.length, 2);
});
