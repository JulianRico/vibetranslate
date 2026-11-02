const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalAiClient } = require('../local-ai/client');

/** Temporizadores manuales: `advance` mueve el reloj y dispara lo que venza, en orden. */
function fakeTimers(clock) {
  const pending = [];
  const add = (fn, ms, repeat) => { const t = { fn, ms, repeat, next: clock.now + ms }; pending.push(t); return t; };
  const remove = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  return {
    api: {
      setInterval: (fn, ms) => add(fn, ms, true),
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearInterval: remove,
      clearTimeout: remove
    },
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = pending.filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        clock.now = due.next;
        if (due.repeat) due.next += due.ms; else remove(due);
        due.fn();
      }
      clock.now = end;
    }
  };
}

function setup() {
  const children = [];
  const events = [];
  const clock = { now: 1000 };
  const timers = fakeTimers(clock);
  const fork = () => {
    const child = new EventEmitter();
    child.sent = [];
    child.killed = false;
    child.postMessage = (m) => child.sent.push(m);
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  };
  const client = createLocalAiClient({ fork, workerPath: '/app/worker.js', onEvent: (e) => events.push(e), now: () => clock.now, timers: timers.api });
  const start = () => { const p = client.start({ paths: { vad: 'v' }, vadThreshold: 0.5 }); p.catch(() => {}); return p; };
  const ready = (i) => children[i].emit('message', { type: 'ready', loadMs: 1 });
  const types = (i) => children[i].sent.map((m) => m.type);
  return { client, children, events, clock, timers, start, ready, types };
}

test('si el motor no carga tras un reinicio, es un error fatal y no se queda un proceso inútil recibiendo audio', () => {
  const t = setup();
  t.start();
  t.ready(0);
  t.children[0].emit('exit', 1);
  t.children[1].emit('message', { type: 'error', stage: 'init', message: 'modelo ilegible' });
  assert.equal(t.children[1].killed, true);
  assert.equal(t.client.isRunning(), false);
  assert.equal(t.children.length, 2);
  const last = t.events[t.events.length - 1];
  assert.equal(last.fatal, true);
  assert.match(last.message, /modelo ilegible/);
});

test('un arranque del usuario empieza de cero: una caída poco después de otra sesión no cuenta como segunda', () => {
  const t = setup();
  t.start();
  t.children[0].emit('exit', 1); // primera caída, se reinicia solo
  t.client.stop();
  t.start(); // el usuario vuelve a activar
  t.clock.now += 5000;
  t.children[2].emit('exit', 1);
  assert.equal(t.children.length, 4, 'debe reiniciarse, no darse por perdido');
  assert.equal(t.events[t.events.length - 1].fatal, false);
});

test('un proceso que deja de responder se detecta y se reinicia', () => {
  const t = setup();
  t.start();
  t.ready(0);
  t.timers.advance(5000);
  assert.ok(t.types(0).includes('ping'));
  t.timers.advance(40000); // nunca contesta
  assert.equal(t.children[0].killed, true);
  assert.equal(t.children.length, 2);
  assert.deepEqual(t.events.map((e) => e.fatal), [false]);
});

test('un proceso que contesta a tiempo no se toca', () => {
  const t = setup();
  t.start();
  t.ready(0);
  for (let i = 0; i < 20; i++) {
    t.timers.advance(5000);
    t.children[0].emit('message', { type: 'pong' });
  }
  assert.equal(t.children.length, 1);
  assert.equal(t.children[0].killed, false);
  assert.deepEqual(t.events, []);
});

test('si el motor no termina de cargar en un minuto, el arranque falla en vez de esperar para siempre', async () => {
  const t = setup();
  const started = t.start();
  t.timers.advance(61000);
  await assert.rejects(started, /no respondió/);
  assert.equal(t.children[0].killed, true);
  assert.equal(t.client.isRunning(), false);
});

test('al detener con margen, la frase en curso se cierra y aún se puede traducir antes de apagar el proceso', async () => {
  const t = setup();
  t.start();
  t.ready(0);
  t.client.stop({ graceMs: 4000 });
  assert.equal(t.client.isRunning(), false);
  assert.equal(t.children[0].killed, false);
  assert.deepEqual(t.children[0].sent[t.children[0].sent.length - 1], { type: 'flush' });

  t.children[0].emit('message', { type: 'segment', id: 1000007, stream: 'mic', lang: 'es', text: 'última frase' });
  assert.deepEqual(t.events, [{ type: 'segment', id: 1000007, stream: 'mic', lang: 'es', text: 'última frase', late: true }]);

  const translation = t.client.translate({ text: 'última frase', source: 'es', target: 'en', segmentId: 1000007 });
  const request = t.children[0].sent[t.children[0].sent.length - 1];
  assert.equal(request.type, 'translate');
  t.children[0].emit('message', { type: 'translation', id: request.id, text: 'last phrase', ms: 300 });
  assert.deepEqual(await translation, { text: 'last phrase', ms: 300 });

  t.client.send({ type: 'audio' }); // ya no se acepta audio nuevo
  assert.ok(!t.types(0).includes('audio'));

  t.timers.advance(4000);
  assert.equal(t.children[0].killed, true);
  await assert.rejects(t.client.translate({ text: 'última frase', source: 'es', target: 'en' }), /detenido/);
});

test('volver a arrancar durante ese margen apaga el proceso anterior de inmediato', () => {
  const t = setup();
  t.start();
  t.ready(0);
  t.client.stop({ graceMs: 4000 });
  t.start();
  assert.equal(t.children[0].killed, true);
  assert.equal(t.children.length, 2);
});

test('configure cambia la sensibilidad en caliente y la conserva si el proceso se reinicia', () => {
  const t = setup();
  t.start();
  t.ready(0);
  t.client.configure({ stream: 'mic', vadThreshold: 0.75 });
  assert.deepEqual(t.children[0].sent[t.children[0].sent.length - 1], { type: 'config', stream: 'mic', vadThreshold: 0.75 });
  t.children[0].emit('exit', 1);
  assert.equal(t.children[1].sent[0].vadThreshold, 0.75);
});
