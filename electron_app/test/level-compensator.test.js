const test = require('node:test');
const assert = require('node:assert/strict');
const { createLevelCompensator } = require('../level-compensator');

const tone = (amplitude, samples = 2048) => new Float32Array(samples).map((_, i) => amplitude * Math.sin(i / 3));
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Pasa varios trozos seguidos y devuelve el último ya procesado. */
function feed(compensator, amplitude, chunks) {
  let out = null;
  for (let i = 0; i < chunks; i++) out = compensator.process(tone(amplitude));
  return out;
}

test('un programa atenuado al 5 % vuelve a su nivel: se multiplica por 20', () => {
  const c = createLevelCompensator({ maxGain: 20 });
  const out = feed(c, 0.02, 10);
  assert.ok(Math.abs(peak(out) - 0.4) < 0.02, `pico ${peak(out)}`);
});

test('un programa que suena sin atenuar (acaba de abrirse) no se amplifica hasta saturar', () => {
  const c = createLevelCompensator({ maxGain: 20 });
  const first = c.process(tone(0.4)); // sin aviso previo, desde el primer trozo
  assert.ok(peak(first) <= 0.75, `pico ${peak(first)}`);
  const later = feed(c, 0.4, 5);
  assert.ok(peak(later) <= 0.75 && peak(later) >= 0.3, `pico ${peak(later)}`);
});

test('cuando ese programa queda atenuado, la ganancia sube en menos de un segundo', () => {
  const c = createLevelCompensator({ maxGain: 20 });
  feed(c, 0.4, 5); // sonaba fuerte
  const out = feed(c, 0.02, 8); // 8 trozos de 128 ms ≈ 1 s ya atenuado
  assert.ok(peak(out) > 0.3, `pico ${peak(out)}`);
});

test('el silencio sigue siendo silencio y nunca se supera el rango válido', () => {
  const c = createLevelCompensator({ maxGain: 20 });
  assert.equal(peak(c.process(new Float32Array(2048))), 0);
  for (const amplitude of [0.9, 0.001, 0.05, 1]) assert.ok(peak(feed(c, amplitude, 3)) <= 1);
});

test('con ganancia 1 no toca el audio', () => {
  const c = createLevelCompensator({ maxGain: 1 });
  const input = tone(0.3);
  assert.deepEqual(Array.from(c.process(input)), Array.from(input));
});
