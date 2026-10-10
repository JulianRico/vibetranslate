import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createListPrepared, createAddPrepared, createUpdatePrepared, createDeletePrepared, createGeneratePrepared,
} from '../../src/application/use-cases/prepared.js';
import { createPrepared, PREPARED_LIMITS } from '../../src/domain/prepared.js';
import { NotConfiguredError, NotFoundError, UpstreamError, ValidationError } from '../../src/domain/errors.js';
import { createMemoryPreparedRepository, sequentialIds, fixedClock } from '../support/fakes.js';

const NOW = '2026-10-05T12:00:00.000Z';
const SUGGESTION = {
  questionEs: 'q', intent: 'i',
  points: [{ en: 'Lead teams', es: 'Liderar equipos' }],
  answer: { en: 'I lead teams with .NET and Azure.', es: 'Lidero equipos con .NET y Azure.' },
};

function setup({ initial = null, suggestAnswer } = {}) {
  const preparedRepo = createMemoryPreparedRepository(initial);
  const clock = fixedClock(NOW);
  const ids = sequentialIds('p_');
  const calls = [];
  const fakeSuggest = suggestAnswer ?? (async (args) => { calls.push(args); return { suggestion: SUGGESTION, usedContext: [], omittedContext: [] }; });
  return {
    preparedRepo, calls,
    list: createListPrepared({ preparedRepo, clock }),
    add: createAddPrepared({ preparedRepo, ids, clock }),
    update: createUpdatePrepared({ preparedRepo, clock }),
    remove: createDeletePrepared({ preparedRepo, clock }),
    generate: createGeneratePrepared({ preparedRepo, suggestAnswer: fakeSuggest, clock }),
  };
}

const one = (over = {}) => createPrepared({ id: 'x1', question: 'Why us?', triggers: ['why us'], now: NOW, ...over });

test('the first list seeds the starter bank (all templates), once', async () => {
  const t = setup();
  const { items } = await t.list();
  assert.equal(items.length, 31);
  assert.ok(items.every((i) => i.status === 'template' && i.updatedAt === NOW));
  await t.list();
  assert.equal(t.preparedRepo.calls.replaceAll, 1, 'seeded only once');
});

test('an existing list is respected, even an empty one', async () => {
  const empty = setup({ initial: [] });
  assert.deepEqual((await empty.list()).items, []);
  assert.equal(empty.preparedRepo.calls.replaceAll, 0);
  const some = setup({ initial: [one()] });
  assert.equal((await some.list()).items.length, 1);
});

test('adding a question before ever listing still starts from the starter bank', async () => {
  const t = setup();
  const item = await t.add({ question: '  Tell me about Kubernetes ', triggers: ['kubernetes', 'kubernetes experience'] });
  assert.deepEqual([item.id, item.question, item.status, item.answer], ['p_1', 'Tell me about Kubernetes', 'empty', null]);
  assert.equal((await t.list()).items.length, 32);
});

test('adding validates the question and the triggers and enforces the limit', async () => {
  const t = setup({ initial: [] });
  await assert.rejects(t.add({ question: '', triggers: ['x'] }), ValidationError);
  await assert.rejects(t.add({ question: 'q', triggers: [] }), /al menos un trigger/);
  const full = setup({ initial: Array.from({ length: PREPARED_LIMITS.MAX_ITEMS }, (_, i) => one({ id: `x${i}` })) });
  await assert.rejects(full.add({ question: 'q', triggers: ['q'] }), /Máximo 60/);
});

test('updating an answer marks the item edited; unknown ids and invalid edits are rejected', async () => {
  const t = setup({ initial: [one({ answer: { en: 'A', es: 'B' } })] });
  const out = await t.update({ id: 'x1', patch: { answer: { en: 'Mine', es: 'Mía' } } });
  assert.deepEqual([out.status, out.answer.en], ['edited', 'Mine']);
  assert.equal((await t.preparedRepo.get('x1')).status, 'edited');
  await assert.rejects(t.update({ id: 'nope', patch: { question: 'x' } }), NotFoundError);
  await assert.rejects(t.update({ id: 'x1', patch: { question: '' } }), ValidationError);
  assert.equal((await t.preparedRepo.get('x1')).question, 'Why us?', 'a rejected edit changes nothing');
});

test('deleting removes the item; unknown ids are reported', async () => {
  const t = setup({ initial: [one()] });
  await t.remove({ id: 'x1' });
  assert.deepEqual((await t.list()).items, []);
  await assert.rejects(t.remove({ id: 'x1' }), NotFoundError);
});

test('generate asks the coach for the question itself, stores the answer and marks it generated', async () => {
  const t = setup({ initial: [one()] });
  const ctl = new AbortController();
  const out = await t.generate({ id: 'x1', signal: ctl.signal });
  assert.deepEqual(t.calls, [{ turns: ['Why us?'], signal: ctl.signal }]);
  assert.deepEqual([out.status, out.answer, out.points, out.generatedAt], ['generated', SUGGESTION.answer, SUGGESTION.points, NOW]);
  assert.equal((await t.preparedRepo.get('x1')).status, 'generated');
});

test('generate refuses to overwrite an edited answer unless forced', async () => {
  const t = setup({ initial: [one({ answer: { en: 'Mine', es: 'Mía' }, status: 'edited' })] });
  await assert.rejects(t.generate({ id: 'x1' }), /editaste tú/);
  assert.equal(t.calls.length, 0, 'the coach was not even called');
  assert.equal((await t.preparedRepo.get('x1')).answer.en, 'Mine');
  const out = await t.generate({ id: 'x1', force: true });
  assert.equal(out.status, 'generated');
});

test('generate can regenerate templates and generated answers without force', async () => {
  const t = setup({ initial: [one({ answer: { en: 'A', es: 'B' }, status: 'template' }), one({ id: 'x2', answer: { en: 'A', es: 'B' }, status: 'generated' })] });
  assert.equal((await t.generate({ id: 'x1' })).status, 'generated');
  assert.equal((await t.generate({ id: 'x2' })).status, 'generated');
});

test('generate: unknown id is 404; coach failures propagate and leave the item untouched', async () => {
  const missing = setup({ initial: [] });
  await assert.rejects(missing.generate({ id: 'nope' }), NotFoundError);
  for (const error of [new NotConfiguredError('Sin clave'), new UpstreamError('Gemini HTTP 503')]) {
    const t = setup({ initial: [one()], suggestAnswer: async () => { throw error; } });
    await assert.rejects(t.generate({ id: 'x1' }), (e) => e === error);
    const stored = await t.preparedRepo.get('x1');
    assert.deepEqual([stored.status, stored.answer], ['empty', null]);
  }
});

test('generate never overwrites a hand edit saved while the AI was still answering', async () => {
  let t;
  t = setup({
    initial: [one({ answer: { en: 'A', es: 'B' }, status: 'template' })],
    suggestAnswer: async () => {
      await t.update({ id: 'x1', patch: { answer: { en: 'MY HAND EDIT', es: 'MI EDICIÓN' } } }); // the user saves while Gemini works
      return { suggestion: SUGGESTION, usedContext: [], omittedContext: [] };
    },
  });
  await assert.rejects(t.generate({ id: 'x1' }), (e) => e instanceof ValidationError && /cambió mientras/.test(e.message));
  const stored = await t.preparedRepo.get('x1');
  assert.deepEqual([stored.status, stored.answer.en], ['edited', 'MY HAND EDIT']);
});

test('generate: an item deleted while the AI was answering is 404 and is not brought back', async () => {
  let t;
  t = setup({
    initial: [one({ answer: { en: 'A', es: 'B' }, status: 'template' })],
    suggestAnswer: async () => {
      await t.remove({ id: 'x1' });
      return { suggestion: SUGGESTION, usedContext: [], omittedContext: [] };
    },
  });
  await assert.rejects(t.generate({ id: 'x1' }), NotFoundError);
  assert.equal(await t.preparedRepo.get('x1'), null);
});
