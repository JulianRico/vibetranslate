const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const segmenterModule = require('../local-ai/segmenter');

const SR = 16000;

/** Ruido «de voz» a 0,1 de amplitud y pausas a 0,002 (26 dB más bajas), con un generador fijo. */
function signal(parts) {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const total = parts.reduce((n, [, sec]) => n + Math.round(sec * SR), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    const level = kind === 'voz' ? 0.2 : 0.004;
    for (let i = 0; i < n; i++) out[at + i] = rand() * level;
    at += n;
  }
  return out;
}

test('un segmento se corta en una pausa de verdad de 0,5 s, con 100 ms de margen antes de la segunda voz', () => {
  const { splitAtQuiet } = segmenterModule;
  assert.equal(typeof splitAtQuiet, 'function');
  const pieces = splitAtQuiet(signal([['voz', 1.5], ['pausa', 0.5], ['voz', 1.5]]), 1000);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].start, 1000);
  const quietEnd = 1000 + 2.0 * SR;
  assert.ok(Math.abs(pieces[1].start - (quietEnd - 1600)) <= 512, `segundo trozo en ${pieces[1].start}`);
  assert.ok(pieces[0].start + pieces[0].samples.length <= 1000 + 1.5 * SR + 512);
});

test('una pausa corta entre palabras (0,2 s) no corta el segmento', () => {
  const pieces = segmenterModule.splitAtQuiet(signal([['voz', 1.5], ['pausa', 0.2], ['voz', 1.5]]), 0);
  assert.equal(pieces.length, 1);
});

test('no se corta si a un lado quedaría menos de 0,6 s de audio', () => {
  const pieces = segmenterModule.splitAtQuiet(signal([['voz', 0.4], ['pausa', 0.5], ['voz', 2]]), 0);
  assert.equal(pieces.length, 1);
});

// Turno real de la prueba de panel: Michael termina «…Sarah, over to you.», 0,75 s de pausa con ruido tenue y Sarah
// empieza «Thank you, Andrea…». Silero, tras varios segundos de voz, no baja de su umbral en la pausa y une a los dos.
test('la pausa entre dos personas no queda dentro de un mismo segmento', { skip: skipReason }, () => {
  const sherpa = require('sherpa-onnx-node');
  const dir = path.join(__dirname, 'fixtures', 'audio');
  const samples = readWav(path.join(dir, 'en-two-voices.wav'));
  const { voices } = JSON.parse(fs.readFileSync(path.join(dir, 'en-two-voices.json'), 'utf8'));
  const segmenter = segmenterModule.createSegmenter({ sherpa, modelPath: store.paths().vad, splitQuiet: true });
  const segments = [];
  for (let i = 0; i < samples.length; i += 1600) segments.push(...segmenter.push(samples.slice(i, i + 1600)));
  segments.push(...segmenter.flush());
  const gapFrom = voices[0].end * SR;
  const gapTo = voices[1].start * SR;
  const bridging = segments.filter((s) => s.start < gapFrom - SR / 4 && s.start + s.samples.length > gapTo + SR / 4);
  assert.equal(bridging.length, 0, `segmento que une a las dos personas: ${bridging.map((s) => `${(s.start / SR).toFixed(2)}-${((s.start + s.samples.length) / SR).toFixed(2)} s`).join(', ')}`);
});
