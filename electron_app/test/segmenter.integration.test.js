const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const { pinkNoise } = require('./support/noise');
const { createSegmenter } = require('../local-ai/segmenter');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));

/** Envía el audio en tramas de 2048 muestras, como el renderer, y añade 1 s de silencio final. */
function run(samples) {
  const sherpa = require('sherpa-onnx-node');
  const segmenter = createSegmenter({ sherpa, modelPath: store.paths().vad });
  const padded = new Float32Array(samples.length + 16000);
  padded.set(samples);
  const segments = [];
  for (let i = 0; i < padded.length; i += 2048) segments.push(...segmenter.push(padded.slice(i, i + 2048)));
  segments.push(...segmenter.flush());
  return segments;
}

test('una frase produce al menos un segmento y cubre casi toda la voz', { skip: skipReason }, () => {
  const samples = audio('es1');
  const segments = run(samples);
  assert.ok(segments.length >= 1);
  const total = segments.reduce((n, s) => n + s.samples.length, 0);
  assert.ok(total > samples.length * 0.5, `solo ${total} de ${samples.length} muestras`);
});

test('cinco segundos de solo ruido no producen ningún segmento', { skip: skipReason }, () => {
  const noise = pinkNoise(80000, 3).map((v) => v * 4);
  assert.equal(run(noise).length, 0);
});

test('un golpe de 200 ms no produce ningún segmento', { skip: skipReason }, () => {
  const blip = new Float32Array(32000);
  blip.set(audio('es1').slice(8000, 11200), 8000);
  assert.equal(run(blip).length, 0);
});

test('habla larga y seguida se corta en segmentos de 7 s como máximo', { skip: skipReason }, () => {
  const parts = ['es2', 'es3', 'es4', 'es5'].map(audio);
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { joined.set(p, offset); offset += p.length; }
  const segments = run(joined);
  assert.ok(segments.length >= 2);
  for (const s of segments) assert.ok(s.samples.length <= 7 * 16000, `segmento de ${s.samples.length / 16000}s`);
});

test('el segmento empieza al menos 100 ms antes del primer sonido: sin ese margen se pierde la primera palabra', { skip: skipReason }, () => {
  const speech = audio('es1');
  const onsetInFile = speech.findIndex((v) => Math.abs(v) > 0.02);
  for (const lead of [48000, 96111]) {
    const samples = pinkNoise(lead + speech.length, 21).map((v) => v * 0.02);
    for (let i = 0; i < speech.length; i++) samples[lead + i] += speech[i];
    const [first] = run(samples);
    const onset = lead + onsetInFile;
    assert.ok(first.start <= onset - 1600, `el segmento empieza en ${first.start}, el primer sonido en ${onset}`);
    assert.ok(first.start >= onset - 16000, `demasiado audio previo: empieza en ${first.start}`);
    // lo que se entrega es exactamente el audio de la señal desde ese punto
    for (const k of [0, 1000, 5000]) assert.ok(Math.abs(first.samples[k] - samples[first.start + k]) < 1e-6);
  }
});

test('el audio previo nunca repite el final de la frase anterior', { skip: skipReason }, () => {
  const a = audio('es3');
  const b = audio('es4');
  const joined = new Float32Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  const segments = run(joined);
  assert.ok(segments.length >= 2);
  for (let i = 1; i < segments.length; i++) {
    const previousEnd = segments[i - 1].start + segments[i - 1].samples.length;
    assert.ok(segments[i].start >= previousEnd, `el segmento ${i} empieza en ${segments[i].start}, antes de ${previousEnd}`);
  }
});

test('durante una frase se puede consultar el audio acumulado, para mostrar texto provisional', { skip: skipReason }, () => {
  const sherpa = require('sherpa-onnx-node');
  const segmenter = createSegmenter({ sherpa, modelPath: store.paths().vad });
  const speech = audio('es2');
  assert.equal(segmenter.peek(), null);
  for (let i = 0; i < 40000; i += 2048) segmenter.push(speech.slice(i, i + 2048)); // 2,5 s de una frase de 4,3 s
  const pending = segmenter.peek();
  assert.ok(pending && pending.length >= 16000 * 1.5 && pending.length <= 40960, `acumulado: ${pending && pending.length}`);
  assert.ok(segmenter.position() >= 39936 && segmenter.position() <= 40960);
  segmenter.flush();
  assert.equal(segmenter.peek(), null);
});
