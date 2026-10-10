import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, initialState } from '../../public/application/store.js';
import { createRequestSuggestion } from '../../public/application/request-suggestion.js';
import { seedPrepared } from '../../src/domain/default-prepared.js';
import { createFakeSuggestionGateway, createSteppingClock, SUGGESTION } from '../support/fakes-client.js';

const bank = seedPrepared('2026-10-05T10:00:00.000Z');
const turn = (id, ...finals) => ({ id, finals, text: finals.join(' ') });

function setup({ items = bank, cloud = createFakeSuggestionGateway(() => SUGGESTION), nano = createFakeSuggestionGateway(() => SUGGESTION) } = {}) {
  const store = createStore({ ...initialState(), prepared: { ...initialState().prepared, items } });
  const suggestions = createRequestSuggestion({ gateways: { cloud, nano }, store, clock: createSteppingClock(250) });
  return { store, suggestions, cloud, nano, state: () => store.getState() };
}

test('a strong match shows the prepared answer at once and never calls Gemini', async () => {
  const t = setup();
  await t.suggestions.request(turn('t1', 'Tell me about yourself.'));
  const s = t.state().suggestion;
  assert.deepEqual([s.state, s.source, s.preparedId, s.preparedStatus], ['ready', 'prepared', 'tell-me-about-yourself', 'template']);
  assert.equal(s.suggestion.intent, 'Tell me about yourself');
  assert.equal(s.suggestion.answer.en, bank[0].answer.en);
  assert.deepEqual(s.suggestion.points, bank[0].points);
  assert.deepEqual([s.usedContext, s.omittedContext], [[], []]);
  assert.equal(t.cloud.calls.length, 0);
  assert.equal(t.state().statuses.suggestions.status, 'ready');
});

test('a prepared answer records no latency and goes into the history with its answer', async () => {
  const t = setup();
  await t.suggestions.request(turn('t1', 'What are your strengths?'));
  assert.deepEqual(t.state().metrics.suggestion, []);
  const entry = t.state().history[0];
  assert.deepEqual([entry.id, entry.interviewer], ['t1', 'What are your strengths?']);
  assert.match(entry.suggestedAnswer, /^My main strengths are leading teams/);
});

test('an edited answer is shown with its own status', async () => {
  const edited = bank.map((b) => (b.id === 'strengths' ? { ...b, status: 'edited', answer: { en: 'Mine', es: 'Mía' } } : b));
  const t = setup({ items: edited });
  await t.suggestions.request(turn('t1', 'What are your strengths?'));
  assert.deepEqual([t.state().suggestion.preparedStatus, t.state().suggestion.suggestion.answer.en], ['edited', 'Mine']);
});

test('without a strong match the normal request goes to Gemini', async () => {
  const t = setup();
  await t.suggestions.request(turn('t1', 'How would you build a payment gateway?'));
  assert.equal(t.cloud.calls.length, 1);
  assert.equal(t.state().suggestion.source, undefined);
  assert.equal(t.state().suggestion.state, 'ready');
});

test('questions without an answer are ignored, and an empty bank changes nothing', async () => {
  const withoutAnswers = bank.map((b) => ({ ...b, answer: null, status: 'empty' }));
  const t = setup({ items: withoutAnswers });
  await t.suggestions.request(turn('t1', 'Tell me about yourself.'));
  assert.equal(t.cloud.calls.length, 1);
  const none = setup({ items: [] });
  await none.suggestions.request(turn('t1', 'Tell me about yourself.'));
  assert.equal(none.cloud.calls.length, 1);
});

test('the prepared answer also works when the Nano provider is selected', async () => {
  const t = setup();
  t.store.update({ provider: 'nano' });
  await t.suggestions.request(turn('t1', 'Why should we hire you?'));
  assert.equal(t.state().suggestion.source, 'prepared');
  assert.equal(t.nano.calls.length, 0);
});

test('"Pedir a la IA" asks Gemini about the same turn even though a prepared answer matches', async () => {
  const t = setup();
  await t.suggestions.request(turn('t1', 'Tell me about yourself.'));
  await t.suggestions.askAi();
  assert.equal(t.cloud.calls.length, 1);
  assert.deepEqual(t.cloud.calls[0].payload.turns, ['Tell me about yourself.']);
  assert.equal(t.state().suggestion.source, undefined, 'the AI answer replaces the prepared one');
  assert.deepEqual(t.state().metrics.suggestion, [250]);
  assert.equal(t.state().history.length, 1, 'the history entry is replaced, not duplicated');
});

test('askAi with no turn yet does nothing', async () => {
  const t = setup();
  await t.suggestions.askAi();
  assert.equal(t.cloud.calls.length, 0);
});

test('a prepared match supersedes a request still in flight: its late answer never overwrites it', async () => {
  const resolvers = [];
  const cloud = createFakeSuggestionGateway(() => new Promise((r) => resolvers.push(r)));
  const t = setup({ cloud });
  const slow = t.suggestions.request(turn('t1', 'How would you build a payment gateway?'));
  await t.suggestions.request(turn('t2', 'What are your strengths?'));
  assert.equal(cloud.calls[0].signal.aborted, true);
  resolvers[0](SUGGESTION);
  await slow;
  assert.equal(t.state().suggestion.source, 'prepared');
  assert.equal(t.state().suggestion.preparedId, 'strengths');
});

test('cancel leaves a prepared answer on screen', async () => {
  const t = setup();
  await t.suggestions.request(turn('t1', 'What are your strengths?'));
  t.suggestions.cancel();
  assert.equal(t.state().suggestion.source, 'prepared');
});
