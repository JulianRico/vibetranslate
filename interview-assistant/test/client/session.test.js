import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, initialState } from '../../public/application/store.js';
import { createSession } from '../../public/application/session.js';
import { SILENCE_MS } from '../../public/domain/turn-buffer.js';
import { createFakeScheduler, createFakeSpeech, createFakeTranslator, createSteppingClock, tick } from '../support/fakes-client.js';

function setup({ speech = createFakeSpeech(), translator = createFakeTranslator(), clock } = {}) {
  const store = createStore(initialState());
  const scheduler = createFakeScheduler();
  const requested = [];
  const cancelled = [];
  const requestSuggestion = { request: (turn) => requested.push(turn), cancel: () => cancelled.push(true) };
  const session = createSession({ speech, translator, requestSuggestion, store, scheduler, ...(clock ? { clock } : {}) });
  return { store, scheduler, speech, translator, session, requested, cancelled, state: () => store.getState() };
}

async function started(opts) {
  const ctx = setup(opts);
  await ctx.session.start();
  return ctx;
}

test('start prepares speech and translator together, starts listening and ends in the listening state', async () => {
  const ctx = setup();
  const starting = ctx.session.start();
  assert.equal(ctx.state().session, 'starting');
  await starting;
  assert.equal(ctx.state().session, 'listening');
  assert.deepEqual(ctx.speech.calls, ['ensureReady', 'start']);
  assert.deepEqual(ctx.translator.calls, ['ensureReady']);
});

test('a translator that cannot be prepared does not stop the session (English only)', async () => {
  const translator = createFakeTranslator({ ensureReady: async () => { throw new Error('no model'); } });
  const ctx = await started({ translator });
  assert.equal(ctx.state().session, 'listening');
});

test('speech that cannot be prepared puts the session in error with the reason; start can be retried', async () => {
  let fail = true;
  const speech = createFakeSpeech({ ensureReady: async () => { if (fail) throw new Error('Sin paquete de voz'); } });
  const ctx = await started({ speech });
  assert.equal(ctx.state().session, 'error');
  assert.equal(ctx.state().error, 'Sin paquete de voz');
  assert.equal(ctx.speech.calls.includes('start'), false);
  fail = false;
  await ctx.session.start();
  assert.equal(ctx.state().session, 'listening');
  assert.equal(ctx.state().error, '');
});

test('starting twice does nothing; stopping while starting cancels the start', async () => {
  let release;
  const speech = createFakeSpeech({ ensureReady: () => new Promise((r) => { release = r; }) });
  const ctx = setup({ speech });
  const first = ctx.session.start();
  await ctx.session.start();
  assert.equal(ctx.speech.calls.filter((c) => c === 'ensureReady').length, 1);
  ctx.session.stop();
  release();
  await first;
  assert.equal(ctx.state().session, 'idle');
  assert.equal(ctx.speech.calls.includes('start'), false);
});

test('a final phrase becomes a line, then gets its translation', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Tell me about yourself.');
  assert.deepEqual(ctx.state().lines, [{ id: 'l1', en: 'Tell me about yourself.', es: null }]);
  await tick();
  assert.deepEqual(ctx.state().lines, [{ id: 'l1', en: 'Tell me about yourself.', es: 'ES:Tell me about yourself.' }]);
});

test('partial results show up as provisional text and a final clears them', async () => {
  const ctx = await started();
  ctx.speech.emitPartial('Tell me');
  assert.equal(ctx.state().partial, 'Tell me');
  ctx.speech.emitFinal('Tell me about yourself.');
  assert.equal(ctx.state().partial, '');
});

test('translations keep their order even when a later one would finish first', async () => {
  const translator = createFakeTranslator({ delays: { slow: 30 } });
  const ctx = await started({ translator });
  ctx.speech.emitFinal('slow');
  ctx.speech.emitFinal('fast');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(translator.calls.slice(1), ['slow', 'fast']);
  assert.deepEqual(ctx.state().lines.map((l) => l.es), ['ES:slow', 'ES:fast']);
});

test('a failed translation marks that line (false) without affecting the others', async () => {
  const translator = createFakeTranslator({ fail: (t) => t === 'bad' });
  const ctx = await started({ translator });
  ctx.speech.emitFinal('bad');
  ctx.speech.emitFinal('good');
  await tick();
  await tick();
  assert.deepEqual(ctx.state().lines.map((l) => l.es), [false, 'ES:good']);
});

test('after 1.5 s of silence the turn closes and a suggestion is requested with the finals', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Tell me about a time');
  ctx.scheduler.advance(1000);
  ctx.speech.emitFinal('you led a team.');
  ctx.scheduler.advance(SILENCE_MS);
  assert.equal(ctx.requested.length, 1);
  assert.deepEqual(ctx.requested[0].finals, ['Tell me about a time', 'you led a team.']);
});

test('while Julian is speaking nothing is kept; when he stops, the open turn is closed', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Why this company?');
  ctx.session.setSpeaking(true);
  assert.equal(ctx.state().session, 'speaking');
  ctx.speech.emitPartial('my own voice');
  ctx.speech.emitFinal('my own voice, finished');
  ctx.scheduler.advance(10_000);
  assert.equal(ctx.state().lines.length, 1, 'own voice was ignored');
  assert.equal(ctx.requested.length, 0, 'the countdown was paused');
  ctx.session.setSpeaking(false);
  assert.equal(ctx.state().session, 'listening');
  assert.deepEqual(ctx.requested.map((t) => t.text), ['Why this company?']);
});

test('toggleSpeaking flips between listening and speaking, and does nothing when idle', async () => {
  const idle = setup();
  idle.session.toggleSpeaking();
  assert.equal(idle.state().session, 'idle');
  const ctx = await started();
  const { toggleSpeaking } = ctx.session; // used detached by the keyboard handler
  toggleSpeaking();
  assert.equal(ctx.state().session, 'speaking');
  toggleSpeaking();
  assert.equal(ctx.state().session, 'listening');
});

test('stop silences everything: no more lines, countdown and suggestion cancelled', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Hello there');
  ctx.session.stop();
  assert.equal(ctx.state().session, 'idle');
  assert.deepEqual(ctx.speech.calls.slice(-1), ['stop']);
  assert.equal(ctx.cancelled.length, 1);
  ctx.speech.emitFinal('late result');
  ctx.scheduler.advance(10_000);
  assert.equal(ctx.state().lines.length, 1);
  assert.equal(ctx.requested.length, 0);
});

test('component status updates reach the store; a fatal speech state ends the session in error', async () => {
  const ctx = await started();
  ctx.translator.emitState({ status: 'downloading', detail: '40%' });
  assert.deepEqual(ctx.state().statuses.translator, { status: 'downloading', detail: '40%' });
  ctx.speech.emitState({ status: 'working' });
  assert.equal(ctx.state().session, 'listening');
  ctx.speech.emitState({ status: 'error', detail: 'Chrome bloqueó el micrófono', fatal: true });
  assert.equal(ctx.state().session, 'error');
  assert.equal(ctx.state().error, 'Chrome bloqueó el micrófono');
  assert.equal(ctx.state().statuses.speech.status, 'error');
});

test('a transient (non-fatal) speech error keeps the session going', async () => {
  const ctx = await started();
  ctx.speech.emitState({ status: 'error', detail: 'network' });
  assert.equal(ctx.state().session, 'listening');
});

test('clear empties transcript, history and suggestion and cancels the pending request', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Hello');
  ctx.store.update((s) => ({ ...s, history: [{ id: 't1', interviewer: 'Hello' }], suggestion: { state: 'thinking' } }));
  ctx.session.clear();
  assert.deepEqual([ctx.state().lines, ctx.state().history, ctx.state().suggestion], [[], [], { state: 'idle' }]);
  assert.equal(ctx.cancelled.length, 1);
});

test('a turn made only of listening noises ("Okay.") stays in the transcript but does not ask for a suggestion', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Tell me about yourself.');
  ctx.scheduler.advance(SILENCE_MS);
  assert.equal(ctx.requested.length, 1);
  ctx.speech.emitFinal('Okay.');
  ctx.speech.emitFinal('Great.');
  ctx.scheduler.advance(SILENCE_MS);
  assert.equal(ctx.requested.length, 1, 'the answer Julian is reading is not replaced');
  assert.deepEqual(ctx.state().lines.map((l) => l.en), ['Tell me about yourself.', 'Okay.', 'Great.']);
});

test('a short real question or "Okay, why?" still asks for a suggestion', async () => {
  const ctx = await started();
  ctx.speech.emitFinal('Why?');
  ctx.scheduler.advance(SILENCE_MS);
  ctx.speech.emitFinal('Okay, why did you choose Azure?');
  ctx.scheduler.advance(SILENCE_MS);
  assert.deepEqual(ctx.requested.map((t) => t.text), ['Why?', 'Okay, why did you choose Azure?']);
});

test('each successful translation records how long it took; a failed one records nothing', async () => {
  const translator = createFakeTranslator({ fail: (t) => t === 'bad' });
  const ctx = await started({ translator, clock: createSteppingClock(120) });
  ctx.speech.emitFinal('good one');
  ctx.speech.emitFinal('bad');
  ctx.speech.emitFinal('good two');
  await tick();
  await tick();
  await tick();
  assert.deepEqual(ctx.state().metrics.translation, [120, 120]);
});
