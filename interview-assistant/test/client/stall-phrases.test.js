import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALL_PHRASES } from '../../public/domain/stall-phrases.js';

test('there are 8 stalling phrases, each with an English line and its Spanish translation', () => {
  assert.equal(STALL_PHRASES.length, 8);
  for (const { en, es } of STALL_PHRASES) {
    assert.equal(typeof en, 'string');
    assert.equal(typeof es, 'string');
    assert.ok(en.trim().length > 10 && es.trim().length > 10);
    assert.notEqual(en, es);
  }
});

test('phrases are unique and cover repeating, clarifying and buying thinking time', () => {
  const english = STALL_PHRASES.map((p) => p.en);
  assert.equal(new Set(english).size, english.length);
  const all = english.join(' ').toLowerCase();
  for (const needle of ['think about that', 'repeat the question', 'clarify', 'example', 'line']) {
    assert.ok(all.includes(needle), `missing a phrase about "${needle}"`);
  }
});

test('the list is frozen so the UI cannot change it by accident', () => {
  assert.ok(Object.isFrozen(STALL_PHRASES));
  assert.ok(STALL_PHRASES.every((p) => Object.isFrozen(p)));
});
