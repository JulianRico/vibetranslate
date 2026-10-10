import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, initialState } from '../../public/application/store.js';
import { createRequestSuggestion } from '../../public/application/request-suggestion.js';
import { createFakeSuggestionGateway, createSteppingClock, SUGGESTION, tick } from '../support/fakes-client.js';

const turn = (id, ...finals) => ({ id, finals, text: finals.join(' ') });

function setup({ cloud = createFakeSuggestionGateway(() => SUGGESTION), nano = createFakeSuggestionGateway(() => SUGGESTION), clock } = {}) {
  const store = createStore(initialState());
  const suggestions = createRequestSuggestion({ gateways: { cloud, nano }, store, ...(clock ? { clock } : {}) });
  return { store, suggestions, cloud, nano, state: () => store.getState() };
}

test('shows "thinking" with the question while waiting, then the suggestion', async () => {
  let release;
  const cloud = createFakeSuggestionGateway(() => new Promise((r) => { release = () => r(SUGGESTION); }));
  const ctx = setup({ cloud });
  const pending = ctx.suggestions.request(turn('t1', 'Tell me about yourself.'));
  assert.deepEqual(ctx.state().suggestion, { state: 'thinking', turnText: 'Tell me about yourself.' });
  assert.equal(ctx.state().statuses.suggestions.status, 'working');
  release();
  await pending;
  assert.equal(ctx.state().suggestion.state, 'ready');
  assert.deepEqual(ctx.state().suggestion.suggestion, SUGGESTION.suggestion);
  assert.equal(ctx.state().statuses.suggestions.status, 'ready');
});

test('sends at most the last 3 finals, each clipped to 600 characters', async () => {
  const ctx = setup();
  await ctx.suggestions.request(turn('t1', 'a', 'b', 'c', 'd', 'x'.repeat(700)));
  const sent = ctx.cloud.calls[0].payload.turns;
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.slice(0, 2), ['c', 'd']);
  assert.equal(sent[2].length, 600);
});

test('history carries previous turns with the suggested answer, at most 4, never the current turn', async () => {
  const ctx = setup();
  for (let i = 1; i <= 6; i++) await ctx.suggestions.request(turn(`t${i}`, `Question ${i}`));
  const payload = ctx.cloud.calls[5].payload;
  assert.deepEqual(payload.history.map((h) => h.interviewer), ['Question 2', 'Question 3', 'Question 4', 'Question 5']);
  assert.ok(payload.history.every((h) => h.suggestedAnswer === 'I lead teams.'));
  assert.deepEqual(ctx.cloud.calls[0].payload.history, []);
});

test('a newer request aborts the previous one and a late answer never overwrites the screen', async () => {
  const resolvers = [];
  const cloud = createFakeSuggestionGateway(() => new Promise((r) => resolvers.push(r)));
  const ctx = setup({ cloud });
  const first = ctx.suggestions.request(turn('t1', 'First question'));
  const second = ctx.suggestions.request(turn('t2', 'Second question'));
  assert.equal(cloud.calls[0].signal.aborted, true);
  assert.equal(cloud.calls[1].signal.aborted, false);
  const answer = (text) => ({ ...SUGGESTION, suggestion: { ...SUGGESTION.suggestion, answer: { en: text, es: text } } });
  resolvers[1](answer('for second'));
  await second;
  resolvers[0](answer('for first, too late'));
  await first;
  assert.equal(ctx.state().suggestion.suggestion.answer.en, 'for second');
  assert.equal(ctx.state().history.find((h) => h.id === 't1').suggestedAnswer, undefined);
});

test('a failure shows the message; retry repeats the same turn without duplicating history', async () => {
  let fail = true;
  const cloud = createFakeSuggestionGateway(() => { if (fail) throw new Error('Gemini HTTP 503: busy'); return SUGGESTION; });
  const ctx = setup({ cloud });
  await ctx.suggestions.request(turn('t1', 'Hello'));
  assert.deepEqual(ctx.state().suggestion, { state: 'error', message: 'Gemini HTTP 503: busy' });
  assert.equal(ctx.state().statuses.suggestions.status, 'error');
  fail = false;
  await ctx.suggestions.retry();
  assert.equal(ctx.state().suggestion.state, 'ready');
  assert.equal(ctx.state().history.length, 1);
  assert.equal(cloud.calls[1].payload.history.length, 0);
});

test('retry with nothing to retry does nothing', async () => {
  const ctx = setup();
  await ctx.suggestions.retry();
  assert.equal(ctx.cloud.calls.length, 0);
});

test('cancel drops the request in flight and returns to idle', async () => {
  const cloud = createFakeSuggestionGateway(() => new Promise(() => {}));
  const ctx = setup({ cloud });
  ctx.suggestions.request(turn('t1', 'Hello'));
  await tick();
  ctx.suggestions.cancel();
  assert.equal(cloud.calls[0].signal.aborted, true);
  assert.equal(ctx.state().suggestion.state, 'idle');
  assert.equal(ctx.state().statuses.suggestions.status, 'idle');
});

test('cancel leaves a finished suggestion on screen', async () => {
  const ctx = setup();
  await ctx.suggestions.request(turn('t1', 'Hello'));
  ctx.suggestions.cancel();
  assert.equal(ctx.state().suggestion.state, 'ready');
});

test('the provider in the state picks the gateway; Nano answers without a full answer', async () => {
  const nano = createFakeSuggestionGateway(() => ({
    suggestion: { questionEs: '', intent: '', points: [{ en: 'Lead teams', es: 'Liderar equipos' }], answer: null },
    usedContext: [], omittedContext: [],
  }));
  const ctx = setup({ nano });
  ctx.store.update({ provider: 'nano' });
  await ctx.suggestions.request(turn('t1', 'Hello'));
  assert.equal(nano.calls.length, 1);
  assert.equal(ctx.cloud.calls.length, 0);
  assert.equal(ctx.state().suggestion.suggestion.answer, null);
  assert.equal(ctx.state().history[0].suggestedAnswer, undefined);
});

test('a suggestion records how long it took from the closed turn to the answer', async () => {
  const ctx = setup({ clock: createSteppingClock(250) });
  await ctx.suggestions.request(turn('t1', 'Hello'));
  await ctx.suggestions.request(turn('t2', 'Again'));
  assert.deepEqual(ctx.state().metrics.suggestion, [250, 250]);
});

test('failed, cancelled and stale requests record no duration', async () => {
  const resolvers = [];
  const cloud = createFakeSuggestionGateway(() => new Promise((r) => resolvers.push(r)));
  const ctx = setup({ cloud, clock: createSteppingClock(250) });
  const first = ctx.suggestions.request(turn('t1', 'First'));
  const second = ctx.suggestions.request(turn('t2', 'Second'));
  resolvers[0](SUGGESTION);
  await first;
  assert.deepEqual(ctx.state().metrics.suggestion, [], 'the stale answer is not measured');
  resolvers[1](SUGGESTION);
  await second;
  assert.deepEqual(ctx.state().metrics.suggestion, [250]);
  const failing = setup({ cloud: createFakeSuggestionGateway(() => { throw new Error('boom'); }), clock: createSteppingClock(250) });
  await failing.suggestions.request(turn('t1', 'Hello'));
  assert.deepEqual(failing.state().metrics.suggestion, []);
});
