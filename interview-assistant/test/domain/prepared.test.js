import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREPARED_LIMITS, createPrepared, normalizeQuestion, normalizeTriggers, normalizeAnswer, normalizePoints, applyGenerated, applyEdit,
} from '../../src/domain/prepared.js';
import { ValidationError } from '../../src/domain/errors.js';

const NOW = '2026-10-05T10:00:00.000Z';
const LATER = '2026-10-05T11:00:00.000Z';
const base = () => createPrepared({ id: 'p_1', question: ' Tell me about yourself ', triggers: ['Tell me about yourself', 'about yourself'], now: NOW });

test('a new question starts empty, with trimmed question and triggers', () => {
  assert.deepEqual(base(), {
    id: 'p_1', question: 'Tell me about yourself', triggers: ['Tell me about yourself', 'about yourself'],
    answer: null, points: [], status: 'empty', generatedAt: null, updatedAt: NOW,
  });
});

test('a question created with an answer is a template unless another status is given', () => {
  const answer = { en: 'I lead teams.', es: 'Lidero equipos.' };
  assert.equal(createPrepared({ id: 'a', question: 'q', triggers: ['q'], answer, now: NOW }).status, 'template');
  assert.equal(createPrepared({ id: 'a', question: 'q', triggers: ['q'], answer, status: 'edited', now: NOW }).status, 'edited');
});

test('question: required and limited', () => {
  assert.throws(() => normalizeQuestion('   '), ValidationError);
  assert.throws(() => normalizeQuestion(undefined), ValidationError);
  assert.throws(() => normalizeQuestion('x'.repeat(PREPARED_LIMITS.QUESTION + 1)), /excede 200/);
  assert.equal(normalizeQuestion('  Why? '), 'Why?');
});

test('triggers: trimmed, de-duplicated ignoring case, empties dropped, at least one, at most 12, each at most 60 characters', () => {
  assert.deepEqual(normalizeTriggers([' Weakness ', 'weakness', '', 'biggest weakness']), ['Weakness', 'biggest weakness']);
  assert.throws(() => normalizeTriggers([]), /al menos un trigger/);
  assert.throws(() => normalizeTriggers(['  ', '']), /al menos un trigger/);
  assert.throws(() => normalizeTriggers('weakness'), ValidationError);
  assert.throws(() => normalizeTriggers(Array.from({ length: 13 }, (_, i) => `t${i}`)), /Máximo 12/);
  assert.throws(() => normalizeTriggers(['x'.repeat(61)]), /excede 60/);
});

test('answer: null is allowed; otherwise both languages are required and the English text has at most 60 words', () => {
  assert.equal(normalizeAnswer(null), null);
  assert.deepEqual(normalizeAnswer({ en: ' Hi ', es: ' Hola ' }), { en: 'Hi', es: 'Hola' });
  assert.throws(() => normalizeAnswer({ en: 'only english' }), /inglés y en español/);
  assert.throws(() => normalizeAnswer({ en: Array(61).fill('word').join(' '), es: 'x' }), /60 palabras/);
  assert.throws(() => normalizeAnswer({ en: 'x'.repeat(601), es: 'x' }), /600 caracteres/);
});

test('points: pairs missing a language are dropped and at most 4 are kept', () => {
  assert.deepEqual(normalizePoints(undefined), []);
  const raw = [{ en: 'a', es: 'b' }, { en: 'only' }, ...Array.from({ length: 6 }, (_, i) => ({ en: `p${i}`, es: `q${i}` }))];
  const points = normalizePoints(raw);
  assert.equal(points.length, 4);
  assert.deepEqual(points[0], { en: 'a', es: 'b' });
  assert.throws(() => normalizePoints('nope'), ValidationError);
});

test('applyGenerated stores the answer and points, marks it generated and keeps question and triggers', () => {
  const item = base();
  const out = applyGenerated(item, { answer: { en: 'A', es: 'B' }, points: [{ en: 'p', es: 'q' }] }, LATER);
  assert.deepEqual([out.answer, out.points, out.status, out.generatedAt, out.updatedAt], [{ en: 'A', es: 'B' }, [{ en: 'p', es: 'q' }], 'generated', LATER, LATER]);
  assert.equal(out.question, item.question);
  assert.deepEqual(out.triggers, item.triggers);
  assert.equal(item.status, 'empty', 'the original is not mutated');
});

test('applyEdit: touching the answer makes the item edited; question and trigger edits keep the status', () => {
  const generated = applyGenerated(base(), { answer: { en: 'A', es: 'B' }, points: [] }, LATER);
  const renamed = applyEdit(generated, { question: 'Introduce yourself', triggers: ['introduce yourself'] }, LATER);
  assert.deepEqual([renamed.question, renamed.triggers, renamed.status], ['Introduce yourself', ['introduce yourself'], 'generated']);
  const edited = applyEdit(generated, { answer: { en: 'Mine', es: 'Mía' } }, LATER);
  assert.deepEqual([edited.answer, edited.status], [{ en: 'Mine', es: 'Mía' }, 'edited']);
  const pointsOnly = applyEdit(generated, { points: [{ en: 'x', es: 'y' }] }, LATER);
  assert.equal(pointsOnly.status, 'edited');
});

test('applyEdit: answer null clears the answer and the points; invalid edits are rejected and change nothing', () => {
  const generated = applyGenerated(base(), { answer: { en: 'A', es: 'B' }, points: [{ en: 'p', es: 'q' }] }, LATER);
  const cleared = applyEdit(generated, { answer: null }, LATER);
  assert.deepEqual([cleared.answer, cleared.points, cleared.status], [null, [], 'empty']);
  assert.throws(() => applyEdit(generated, { question: '' }), ValidationError);
  assert.throws(() => applyEdit(generated, { answer: { en: 'solo inglés' } }), ValidationError);
  assert.equal(generated.status, 'generated');
});

test('points on a question without an answer do not make it edited', () => {
  const out = applyEdit(base(), { points: [{ en: 'x', es: 'y' }] }, LATER);
  assert.equal(out.status, 'empty');
});
