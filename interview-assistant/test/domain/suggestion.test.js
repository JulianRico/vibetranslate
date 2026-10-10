import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSuggestion } from '../../src/domain/suggestion.js';
import { ValidationError } from '../../src/domain/errors.js';

const valid = () => ({
  questionEs: ' ¿Cuéntame de ti? ',
  intent: 'introducción',
  points: [{ en: 'Full Stack Lead', es: 'Líder Full Stack' }, { en: '14 years', es: '14 años' }],
  answer: { en: 'I lead teams building .NET and React products.', es: 'Lidero equipos que construyen productos .NET y React.' },
});

test('accepts a valid suggestion and trims strings', () => {
  const s = normalizeSuggestion(valid());
  assert.equal(s.questionEs, '¿Cuéntame de ti?');
  assert.equal(s.points.length, 2);
  assert.equal(s.answer.en, 'I lead teams building .NET and React products.');
});

test('keeps at most 4 points', () => {
  const raw = valid();
  raw.points = Array.from({ length: 7 }, (_, i) => ({ en: `p${i}`, es: `q${i}` }));
  assert.equal(normalizeSuggestion(raw).points.length, 4);
});

test('drops points missing a language, and fails when none remain', () => {
  const raw = valid();
  raw.points = [{ en: 'only english' }, { en: 'ok', es: 'ok' }];
  assert.equal(normalizeSuggestion(raw).points.length, 1);
  raw.points = [{ en: 'only english' }];
  assert.throws(() => normalizeSuggestion(raw), ValidationError);
});

test('requires an answer in both languages', () => {
  const raw = valid();
  raw.answer = { en: 'hello' };
  assert.throws(() => normalizeSuggestion(raw), /respuesta/);
  delete raw.answer;
  assert.throws(() => normalizeSuggestion(raw), ValidationError);
});

test('rejects answers over 60 words', () => {
  const raw = valid();
  raw.answer.en = Array(61).fill('word').join(' ');
  assert.throws(() => normalizeSuggestion(raw), /60 palabras/);
});

test('rejects unfilled [placeholders] anywhere', () => {
  const raw = valid();
  raw.answer.en = 'I am strong in [mention 1-2 key skills].';
  assert.throws(() => normalizeSuggestion(raw), /marcadores/);
  const raw2 = valid();
  raw2.points[0].es = 'Experto en [tecnología]';
  assert.throws(() => normalizeSuggestion(raw2), /marcadores/);
});

test('rejects non-objects', () => {
  for (const bad of [null, undefined, 'texto', 42, [], true]) assert.throws(() => normalizeSuggestion(bad), ValidationError);
});

test('missing questionEs and intent become empty strings', () => {
  const raw = valid();
  delete raw.questionEs;
  delete raw.intent;
  const s = normalizeSuggestion(raw);
  assert.equal(s.questionEs, '');
  assert.equal(s.intent, '');
});
