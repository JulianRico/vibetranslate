const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWav, writeWav } = require('./support/wav');
const { normalizeText, wordErrorRate, hasKeywords } = require('./support/text');
const { pinkNoise, mixAtSnr, rms } = require('./support/noise');

test('writeWav y readWav son inversos (con el error de 16 bits)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-wav-')), 't.wav');
  const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
  writeWav(file, samples);
  const back = readWav(file);
  assert.equal(back.length, 4);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back[i] - samples[i]) < 1e-3);
});

test('readWav lee los audios generados: mono, 16 kHz, más de 1 s', () => {
  const samples = readWav(path.join(__dirname, 'fixtures', 'audio', 'es1.wav'));
  assert.ok(samples.length > 16000);
  assert.ok(rms(samples) > 0.01);
});

test('normalizeText quita mayúsculas, tildes y puntuación', () => {
  assert.equal(normalizeText('¿Puedes enviarme el INFORME, por favor?'), 'puedes enviarme el informe por favor');
  assert.equal(normalizeText('Reunión de hoy.'), 'reunion de hoy');
});

test('wordErrorRate cuenta sustituciones, inserciones y omisiones sobre la referencia', () => {
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno dos tres cuatro'), 0);
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno dos tres'), 0.25);
  assert.equal(wordErrorRate('uno dos tres cuatro', 'uno DOS, tres cinco'), 0.25);
  assert.equal(wordErrorRate('uno dos', ''), 1);
});

test('hasKeywords ignora tildes y mayúsculas y exige todas', () => {
  assert.equal(hasKeywords('La Reunion es hoy', ['reunión', 'hoy']), true);
  assert.equal(hasKeywords('La reunión es mañana', ['reunión', 'hoy']), false);
});

test('pinkNoise es determinista y mixAtSnr respeta la relación pedida', () => {
  assert.deepEqual(Array.from(pinkNoise(100, 7)), Array.from(pinkNoise(100, 7)));
  const speech = new Float32Array(16000).map((_, i) => 0.3 * Math.sin(i / 5));
  const noise = pinkNoise(16000, 1);
  const mixed = mixAtSnr(speech, noise, 10);
  const residual = mixed.map((v, i) => v - speech[i]);
  const snr = 20 * Math.log10(rms(speech) / rms(residual));
  assert.ok(Math.abs(snr - 10) < 0.2, `snr=${snr}`);
});
