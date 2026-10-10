import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREPARED, seedPrepared } from '../../src/domain/default-prepared.js';
import { PREPARED_LIMITS } from '../../src/domain/prepared.js';

const NOW = '2026-10-05T10:00:00.000Z';
const wordCount = (s) => s.trim().split(/\s+/).length;

test('the starter bank has 31 questions with unique ids and questions', () => {
  assert.equal(DEFAULT_PREPARED.length, 31);
  assert.equal(new Set(DEFAULT_PREPARED.map((p) => p.id)).size, 31);
  assert.equal(new Set(DEFAULT_PREPARED.map((p) => p.question)).size, 31);
  assert.ok(DEFAULT_PREPARED.length <= PREPARED_LIMITS.MAX_ITEMS);
});

test('the most requested questions are present', () => {
  const ids = DEFAULT_PREPARED.map((p) => p.id);
  for (const id of ['tell-me-about-yourself', 'strengths', 'biggest-weakness', 'why-this-job', 'salary-expectations', 'questions-for-us']) {
    assert.ok(ids.includes(id), id);
  }
});

test('every starter answer is complete: English and Spanish, at most 60 English words, 1 to 4 points', () => {
  for (const p of DEFAULT_PREPARED) {
    assert.ok(p.answer.en.length > 0 && p.answer.es.length > 0, p.id);
    assert.ok(wordCount(p.answer.en) <= 60, `${p.id}: ${wordCount(p.answer.en)} words`);
    assert.ok(p.points.length >= 1 && p.points.length <= 4, p.id);
    for (const pt of p.points) assert.ok(pt.en && pt.es, p.id);
  }
});

test('texts contain no unfilled [placeholders]', () => {
  const all = DEFAULT_PREPARED.flatMap((p) => [p.question, p.answer.en, p.answer.es, ...p.points.flatMap((x) => [x.en, x.es])]);
  for (const text of all) assert.doesNotMatch(text, /\[[^\]]*\]/, text);
});

test('texts invent no figures: the only number allowed is 14 (as in "14+ years")', () => {
  const all = DEFAULT_PREPARED.flatMap((p) => [p.answer.en, p.answer.es, ...p.points.flatMap((x) => [x.en, x.es])]);
  for (const text of all) {
    for (const found of text.match(/\d+/g) ?? []) assert.equal(found, '14', text);
  }
});

test('texts only claim facts that are in the CV: no employers, cities or invented technologies', () => {
  const forbidden = /\b(amazon|aws|google|microsoft corp|sharepoint|spfx|java\b|python|kubernetes|docker|angular|vue|node\.js|startup|million|percent|%)/i;
  const all = DEFAULT_PREPARED.flatMap((p) => [p.answer.en, p.answer.es, ...p.points.flatMap((x) => [x.en, x.es])]);
  for (const text of all) assert.doesNotMatch(text, forbidden, text);
});

test('every question has valid triggers (1 to 12, at most 60 characters, unique)', () => {
  for (const p of DEFAULT_PREPARED) {
    assert.ok(p.triggers.length >= 1 && p.triggers.length <= PREPARED_LIMITS.TRIGGERS, p.id);
    assert.equal(new Set(p.triggers.map((t) => t.toLowerCase())).size, p.triggers.length, p.id);
    for (const t of p.triggers) assert.ok(t.length > 0 && t.length <= PREPARED_LIMITS.TRIGGER, `${p.id}: ${t}`);
  }
});

test('the bank is frozen so nothing can change it by accident', () => {
  assert.ok(Object.isFrozen(DEFAULT_PREPARED));
  assert.ok(DEFAULT_PREPARED.every((p) => Object.isFrozen(p)));
});

test('seedPrepared turns the bank into storable items: all templates, with the given timestamp', () => {
  const items = seedPrepared(NOW);
  assert.equal(items.length, 31);
  for (const item of items) {
    assert.equal(item.status, 'template');
    assert.equal(item.generatedAt, null);
    assert.equal(item.updatedAt, NOW);
    assert.ok(item.answer && item.points.length >= 1);
  }
  assert.notEqual(items[0], DEFAULT_PREPARED[0], 'items are copies, not the frozen entries');
});

test('the three examples from the spec are worded as agreed', () => {
  const byId = Object.fromEntries(DEFAULT_PREPARED.map((p) => [p.id, p]));
  assert.match(byId['tell-me-about-yourself'].answer.en, /^I'm a Full Stack Lead with more than fourteen years of experience building software and leading teams\./);
  assert.match(byId.strengths.answer.en, /^My main strengths are leading teams and turning client needs into clear technical solutions\./);
  assert.match(byId['biggest-weakness'].answer.en, /^I used to take too much on myself instead of delegating\./);
});
