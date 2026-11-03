const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpeakerTracker, cosine } = require('../local-ai/speaker-tracker');

// Huellas sintéticas: tres personas claramente distintas y variaciones pequeñas de cada una
const A = [1, 0, 0, 0.1];
const B = [0, 1, 0, 0.1];
const C = [0, 0, 1, 0.1];
const near = (v, k) => v.map((x, i) => x + (i === k % v.length ? 0.15 : 0));

test('la similitud de coseno es 1 para la misma dirección y 0 para direcciones perpendiculares', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

test('cada voz nueva recibe un número y la misma voz vuelve a su número', () => {
  const t = createSpeakerTracker({ threshold: 0.7 });
  assert.deepEqual([t.assign(A, 3).id, t.assign(B, 3).id, t.assign(C, 3).id], [1, 2, 3]);
  assert.equal(t.assign(near(B, 1), 3).id, 2);
  assert.equal(t.assign(near(A, 2), 3).id, 1);
  assert.equal(t.count(), 3);
});

test('una frase corta va a la voz conocida más parecida y nunca abre una persona nueva', () => {
  const t = createSpeakerTracker({ threshold: 0.7, minSec: 1.5 });
  t.assign(A, 3);
  t.assign(B, 3);
  const short = t.assign(near(A, 3), 0.8); // tras hablar B, una frase corta de A
  assert.equal(short.id, 1);
  assert.equal(short.isNew, false);
  assert.equal(t.assign(C, 0.8).isNew, false); // una voz desconocida pero corta no crea a nadie
  assert.equal(t.count(), 2);
});

test('la primera frase, aunque sea corta, abre la persona 1', () => {
  const t = createSpeakerTracker({ minSec: 1.5 });
  assert.equal(t.assign(A, 0.6).id, 1);
});

test('sin huella (falló el cálculo) se hereda la persona anterior, o ninguna si no la hay', () => {
  const t = createSpeakerTracker();
  assert.equal(t.assign(null, 3).id, null);
  t.assign(A, 3);
  assert.equal(t.assign(null, 3).id, 1);
});

test('con el máximo de personas, una voz nueva va a la más parecida en vez de abrir otra', () => {
  const t = createSpeakerTracker({ threshold: 0.95, maxSpeakers: 2 });
  t.assign(A, 3);
  t.assign(B, 3);
  assert.equal(t.assign([0.1, 0.9, 0.4, 0], 3).id, 2);
  assert.equal(t.count(), 2);
});

test('reset olvida las voces: la siguiente reunión empieza en la persona 1', () => {
  const t = createSpeakerTracker();
  t.assign(A, 3);
  t.assign(B, 3);
  t.reset();
  assert.equal(t.assign(C, 3).id, 1);
});
