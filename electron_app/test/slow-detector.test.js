const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlowDetector } = require('../local-ai/slow-detector');

const slow = { sttMs: 3000, durationMs: 2000 };
const fast = { sttMs: 400, durationMs: 2000 };

test('avisa una sola vez cuando tres frases seguidas tardan más en transcribirse de lo que duran', () => {
  const d = createSlowDetector();
  assert.deepEqual([slow, slow, slow, slow, slow].map((s) => d.observe(s)), [false, false, true, false, false]);
});

test('una frase rápida entre medias reinicia la cuenta: un pico aislado no es un equipo lento', () => {
  const d = createSlowDetector();
  assert.deepEqual([slow, slow, fast, slow, slow].map((s) => d.observe(s)), [false, false, false, false, false]);
});

test('reset permite volver a avisar en una sesión nueva', () => {
  const d = createSlowDetector();
  [slow, slow, slow].forEach((s) => d.observe(s));
  d.reset();
  assert.deepEqual([slow, slow, slow].map((s) => d.observe(s)), [false, false, true]);
});
