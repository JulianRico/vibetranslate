import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebSpeechRecognizer } from '../../public/adapters/web-speech-recognizer.js';
import { createRestartPolicy } from '../../public/adapters/restart-policy.js';
import { createFakeScheduler } from '../support/fakes-client.js';

/** Fake SpeechRecognition class: records instances so tests can drive their event handlers. */
function fakeWindow({ availability = 'available', installed = true, withAvailable = true, startThrows = false } = {}) {
  const instances = [];
  const installs = [];
  class FakeRecognition {
    constructor() { this.started = false; this.aborted = false; instances.push(this); }
    start() { if (startThrows) throw new Error('already started'); this.started = true; }
    abort() { this.aborted = true; }
  }
  if (withAvailable) {
    FakeRecognition.available = async (options) => { FakeRecognition.lastAvailableOptions = options; return availability; };
    FakeRecognition.install = async (options) => { installs.push(options); return installed; };
  }
  return { win: { SpeechRecognition: FakeRecognition }, instances, installs, FakeRecognition };
}

const results = (...items) => Object.assign(items.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })), {});
const resultEvent = (resultIndex, ...items) => ({ resultIndex, results: results(...items) });

function setup(opts) {
  const fake = fakeWindow(opts);
  const scheduler = createFakeScheduler();
  const recognizer = createWebSpeechRecognizer({ scheduler, win: fake.win });
  const events = { partial: [], final: [], states: [] };
  recognizer.onPartial((t) => events.partial.push(t));
  recognizer.onFinal((t) => events.final.push(t));
  recognizer.onState((s) => events.states.push(s));
  return { ...fake, scheduler, recognizer, events, last: () => fake.instances.at(-1) };
}

test('restart policy backs off 250, 500, 1000, 2000, 2000 and resets', () => {
  const p = createRestartPolicy();
  assert.deepEqual([p.nextDelay(), p.nextDelay(), p.nextDelay(), p.nextDelay(), p.nextDelay()], [250, 500, 1000, 2000, 2000]);
  p.reset();
  assert.equal(p.nextDelay(), 250);
});

test('ensureReady checks the on-device pack for en-US and becomes ready', async () => {
  const t = setup();
  await t.recognizer.ensureReady();
  assert.deepEqual(t.FakeRecognition.lastAvailableOptions, { langs: ['en-US'], processLocally: true });
  assert.equal(t.events.states.at(-1).status, 'ready');
  assert.equal(t.installs.length, 0);
});

test('ensureReady installs the pack when it is downloadable', async () => {
  const t = setup({ availability: 'downloadable' });
  await t.recognizer.ensureReady();
  assert.deepEqual(t.installs, [{ langs: ['en-US'], processLocally: true }]);
  assert.equal(t.events.states.some((s) => s.status === 'downloading'), true);
  assert.equal(t.events.states.at(-1).status, 'ready');
});

test('ensureReady fails with a fatal state when the install fails or the pack is unavailable', async () => {
  const failed = setup({ availability: 'downloadable', installed: false });
  await assert.rejects(failed.recognizer.ensureReady(), /No se pudo instalar/);
  assert.deepEqual([failed.events.states.at(-1).status, failed.events.states.at(-1).fatal], ['error', true]);
  const unavailable = setup({ availability: 'unavailable' });
  await assert.rejects(unavailable.recognizer.ensureReady(), /no está disponible/);
  assert.equal(unavailable.events.states.at(-1).status, 'unavailable');
});

test('ensureReady fails when the browser has no speech recognition at all', async () => {
  const recognizer = createWebSpeechRecognizer({ scheduler: createFakeScheduler(), win: {} });
  const states = [];
  recognizer.onState((s) => states.push(s));
  await assert.rejects(recognizer.ensureReady(), /Usa Chrome de escritorio/);
  assert.equal(states.at(-1).status, 'unavailable');
});

test('an older Chrome without on-device mode still works, and says the audio goes to Google', async () => {
  const t = setup({ withAvailable: false });
  await t.recognizer.ensureReady();
  assert.match(t.events.states.at(-1).detail, /servidores de Google/);
  t.recognizer.start();
  assert.equal(t.last().processLocally, undefined);
});

test('start configures a continuous, interim, on-device en-US recognition', async () => {
  const t = setup();
  await t.recognizer.ensureReady();
  t.recognizer.start();
  const r = t.last();
  assert.deepEqual([r.lang, r.continuous, r.interimResults, r.processLocally, r.started], ['en-US', true, true, true, true]);
  r.onstart();
  assert.equal(t.events.states.at(-1).status, 'working');
});

test('results are split into partial and final using resultIndex (finals are not repeated)', async () => {
  const t = setup();
  t.recognizer.start();
  const r = t.last();
  r.onresult(resultEvent(0, ['Tell me', false]));
  r.onresult(resultEvent(0, ['Tell me about yourself.', true]));
  // `results` is cumulative in continuous mode; `resultIndex` marks the first entry that changed.
  r.onresult(resultEvent(1, ['Tell me about yourself.', true], ['So', false]));
  r.onresult(resultEvent(1, ['Tell me about yourself.', true], ['So why this company?', true]));
  assert.deepEqual(t.events.partial, ['Tell me', 'So']);
  assert.deepEqual(t.events.final, ['Tell me about yourself.', 'So why this company?']);
});

test('blank results are ignored', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onresult(resultEvent(0, ['   ', true]));
  assert.deepEqual(t.events.final, []);
});

test('when Chrome ends the recognition it restarts with backoff, and a result resets the backoff', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onend();
  assert.equal(t.instances.length, 1, 'not yet');
  t.scheduler.advance(249);
  assert.equal(t.instances.length, 1);
  t.scheduler.advance(1);
  assert.equal(t.instances.length, 2);
  t.last().onend();
  t.scheduler.advance(499);
  assert.equal(t.instances.length, 2, 'second restart waits 500 ms');
  t.scheduler.advance(1);
  assert.equal(t.instances.length, 3);
  t.last().onresult(resultEvent(0, ['hello', true]));
  t.last().onend();
  t.scheduler.advance(250);
  assert.equal(t.instances.length, 4, 'back to 250 ms after a result');
});

test('stop aborts the recognition and prevents any restart', () => {
  const t = setup();
  t.recognizer.start();
  const r = t.last();
  t.recognizer.stop();
  assert.equal(r.aborted, true);
  r.onend();
  t.scheduler.advance(10_000);
  assert.equal(t.instances.length, 1);
  assert.equal(t.events.states.at(-1).status, 'ready');
});

test('stop while a restart is pending cancels it', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onend();
  t.recognizer.stop();
  t.scheduler.advance(10_000);
  assert.equal(t.instances.length, 1);
});

test('no-speech and aborted errors are normal and ignored', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onerror({ error: 'no-speech' });
  t.last().onerror({ error: 'aborted' });
  assert.equal(t.events.states.some((s) => s.status === 'error'), false);
});

test('a blocked microphone is fatal, explained in Spanish, and stops the restarts', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onerror({ error: 'not-allowed' });
  const state = t.events.states.at(-1);
  assert.deepEqual([state.status, state.fatal], ['error', true]);
  assert.match(state.detail, /bloqueó el micrófono/);
  t.last().onend();
  t.scheduler.advance(10_000);
  assert.equal(t.instances.length, 1);
});

test('a missing language pack is fatal and tells the user what to do', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onerror({ error: 'language-not-supported' });
  assert.equal(t.events.states.at(-1).fatal, true);
  assert.match(t.events.states.at(-1).detail, /paquete de voz en inglés/);
});

test('other errors (e.g. network) are reported but not fatal, and the restart still happens', () => {
  const t = setup();
  t.recognizer.start();
  t.last().onerror({ error: 'network' });
  assert.equal(t.events.states.at(-1).status, 'error');
  assert.equal(t.events.states.at(-1).fatal, undefined);
  t.last().onend();
  t.scheduler.advance(250);
  assert.equal(t.instances.length, 2);
});

test('if start() throws (already started), it reports the error and retries later', () => {
  const t = setup({ startThrows: true });
  t.recognizer.start();
  assert.match(t.events.states.at(-1).detail, /No se pudo iniciar la escucha/);
  t.scheduler.advance(250);
  assert.equal(t.instances.length, 2);
});
