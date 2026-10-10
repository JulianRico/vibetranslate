import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, assertKind, defaultKind, sanitizeName, normalizeText, createContextItem, updateItem, toSummary,
} from '../../src/domain/context-item.js';
import { ValidationError } from '../../src/domain/errors.js';

test('defaultKind: audio is a transcript, everything else is other', () => {
  assert.equal(defaultKind('audio'), 'transcript');
  assert.equal(defaultKind('pdf'), 'other');
  assert.equal(defaultKind('text'), 'other');
});

test('assertKind accepts known kinds and rejects others', () => {
  assert.equal(assertKind('job'), 'job');
  assert.throws(() => assertKind('secret'), ValidationError);
});

test('sanitizeName drops paths, control characters and markup characters', () => {
  assert.equal(sanitizeName('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(sanitizeName('C:\\Users\\x\\oferta.pdf'), 'oferta.pdf');
  assert.equal(sanitizeName('a\u0000b<c>"d".txt'), 'abcd.txt');
  assert.equal(sanitizeName('   '), 'Sin nombre');
  assert.equal(sanitizeName(undefined), 'Sin nombre');
});

test('sanitizeName caps the length without splitting emoji', () => {
  const name = sanitizeName('😀'.repeat(300));
  assert.equal([...name].length, LIMITS.MAX_NAME_CHARS);
  assert.ok(!/[\ud800-\udbff]$/.test(name));
});

test('normalizeText strips BOM and NUL, unifies newlines and collapses blank lines', () => {
  const { text, warnings } = normalizeText('\uFEFFhola\u0000 mundo\r\n\r\n\r\n\r\nfin  \r\n');
  assert.equal(text, 'hola mundo\n\nfin');
  assert.deepEqual(warnings, []);
});

test('normalizeText truncates at MAX_ITEM_CHARS with a warning and never splits a surrogate pair', () => {
  const raw = 'a'.repeat(LIMITS.MAX_ITEM_CHARS - 1) + '😀' + 'tail';
  const { text, warnings } = normalizeText(raw);
  assert.ok(text.length <= LIMITS.MAX_ITEM_CHARS);
  assert.ok(!/[\ud800-\udbff]$/.test(text));
  assert.deepEqual(warnings, ['truncated']);
});

test('createContextItem builds an active item with its size', () => {
  const item = createContextItem({ id: 'c_1', name: 'x/oferta.pdf', kind: 'job', source: 'pdf', text: 'Texto', now: 'T0' });
  assert.deepEqual(item, {
    id: 'c_1', name: 'oferta.pdf', kind: 'job', source: 'pdf', text: 'Texto', chars: 5,
    active: true, createdAt: 'T0', warnings: [],
  });
});

test('createContextItem rejects empty text, bad kind and bad source', () => {
  const base = { id: 'c_1', name: 'x', kind: 'job', source: 'pdf', text: 'ok', now: 'T0' };
  assert.throws(() => createContextItem({ ...base, text: '' }), /No se encontró texto/);
  assert.throws(() => createContextItem({ ...base, kind: 'nope' }), ValidationError);
  assert.throws(() => createContextItem({ ...base, source: 'exe' }), ValidationError);
});

test('updateItem applies name, kind, active and re-normalizes text', () => {
  const item = createContextItem({ id: 'c_1', name: 'a', kind: 'other', source: 'text', text: 'viejo', now: 'T0' });
  const next = updateItem(item, { name: 'b', kind: 'notes', active: false, text: 'nuevo\r\n\r\n\r\n\r\ntexto' });
  assert.equal(next.name, 'b');
  assert.equal(next.kind, 'notes');
  assert.equal(next.active, false);
  assert.equal(next.text, 'nuevo\n\ntexto');
  assert.equal(next.chars, next.text.length);
  assert.equal(item.text, 'viejo', 'the original is not mutated');
});

test('updateItem rejects invalid patches', () => {
  const item = createContextItem({ id: 'c_1', name: 'a', kind: 'other', source: 'text', text: 'x', now: 'T0' });
  assert.throws(() => updateItem(item, { active: 'yes' }), ValidationError);
  assert.throws(() => updateItem(item, { text: '   ' }), ValidationError);
  assert.throws(() => updateItem(item, { kind: 'nope' }), ValidationError);
});

test('updateItem recomputes the truncated warning when the text changes', () => {
  const item = createContextItem({ id: 'c_1', name: 'a', kind: 'other', source: 'text', text: 'x', warnings: ['truncated', 'partial'], now: 'T0' });
  assert.deepEqual(updateItem(item, { text: 'corto' }).warnings, ['partial']);
});

test('toSummary drops the text and adds a preview', () => {
  const long = createContextItem({ id: 'c_1', name: 'a', kind: 'other', source: 'text', text: 'z'.repeat(500), now: 'T0' });
  const s = toSummary(long);
  assert.equal('text' in s, false);
  assert.equal(s.preview.length, LIMITS.PREVIEW_CHARS + 1);
  assert.ok(s.preview.endsWith('…'));
  const short = createContextItem({ id: 'c_2', name: 'a', kind: 'other', source: 'text', text: 'hola', now: 'T0' });
  assert.equal(toSummary(short).preview, 'hola');
});

test('"stories" (STAR stories) is a valid context kind', () => {
  assert.equal(assertKind('stories'), 'stories');
  const item = createContextItem({ id: 'c_1', name: 'Mis historias', kind: 'stories', source: 'text', text: 'Situación: ...', now: 'T0' });
  assert.equal(item.kind, 'stories');
  assert.match(String(assertKindError()), /stories/);
});
function assertKindError() { try { assertKind('nope'); } catch (e) { return e.message; } return ''; }
