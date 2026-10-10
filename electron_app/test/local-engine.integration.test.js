const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const { wordErrorRate, hasKeywords } = require('./support/text');
const { pinkNoise, mixAtSnr } = require('./support/noise');
const { createEngine } = require('../local-ai/engine');
const phrases = require('./fixtures/phrases.json');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));

let shared = null;
/** Un solo motor para todo el archivo: cargar el modelo cuesta ~1,5 s. */
function engine() {
  if (!shared) {
    const posted = [];
    shared = { posted, engine: createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m) }) };
  }
  return shared;
}

/** Pasa un audio por el motor como lo haría el renderer y devuelve los segmentos publicados. */
function hear(samples, lang, stream) {
  const { engine: e, posted } = engine();
  const from = posted.length;
  const padded = new Float32Array(samples.length + 16000);
  padded.set(samples);
  for (let i = 0; i < padded.length; i += 2048) e.handle({ type: 'audio', stream, lang, samples: padded.slice(i, i + 2048) });
  e.handle({ type: 'flush', stream, lang });
  return posted.slice(from).filter((m) => m.type === 'segment');
}

const textOf = (segments) => segments.map((s) => s.text).join(' ');

function translate(segments, target) {
  const { engine: e, posted } = engine();
  return segments.map((s) => {
    e.handle({ type: 'translate', id: s.id, target });
    return posted[posted.length - 1].text;
  }).join(' ');
}

for (const lang of ['es', 'en']) {
  test(`transcribe las 5 frases en ${lang} con error de palabras medio ≤ 10 %`, { skip: skipReason }, () => {
    const rates = phrases[lang].map((p, i) => {
      const heard = textOf(hear(audio(p.id), lang, `clean-${lang}-${i}`));
      const rate = wordErrorRate(p.text, heard);
      console.log(`  ${p.id} WER=${rate.toFixed(2)} "${heard}"`);
      return rate;
    });
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    assert.ok(mean <= 0.10, `error medio ${mean.toFixed(3)}`);
  });

  test(`con ruido rosa a 10 dB el error medio en ${lang} es ≤ 20 %`, { skip: skipReason }, () => {
    const noise = pinkNoise(16000 * 12, 11);
    const rates = phrases[lang].map((p, i) => {
      const heard = textOf(hear(mixAtSnr(audio(p.id), noise, 10), lang, `noisy-${lang}-${i}`));
      const rate = wordErrorRate(p.text, heard);
      console.log(`  ${p.id} 10dB WER=${rate.toFixed(2)} "${heard}"`);
      return rate;
    });
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    assert.ok(mean <= 0.20, `error medio ${mean.toFixed(3)}`);
  });
}

test('traduce ES→EN en local: cada frase conserva sus palabras clave', { skip: skipReason }, () => {
  const misses = [];
  phrases.es.forEach((p, i) => {
    const translated = translate(hear(audio(p.id), 'es', `tr-es-${i}`), 'en');
    console.log(`  ${p.id} -> "${translated}"`);
    if (!hasKeywords(translated, p.keywordsEn)) misses.push(`${p.id}: "${translated}" sin ${p.keywordsEn}`);
  });
  assert.deepEqual(misses, []);
});

test('traduce EN→ES en local: cada frase conserva sus palabras clave', { skip: skipReason }, () => {
  const misses = [];
  phrases.en.forEach((p, i) => {
    const translated = translate(hear(audio(p.id), 'en', `tr-en-${i}`), 'es');
    console.log(`  ${p.id} -> "${translated}"`);
    if (!hasKeywords(translated, p.keywordsEs)) misses.push(`${p.id}: "${translated}" sin ${p.keywordsEs}`);
  });
  assert.deepEqual(misses, []);
});

test('solo ruido durante 5 s no publica ninguna frase', { skip: skipReason }, () => {
  assert.deepEqual(hear(pinkNoise(80000, 5).map((v) => v * 4), 'es', 'only-noise'), []);
});

test('un golpe de 200 ms no publica ninguna frase', { skip: skipReason }, () => {
  const blip = new Float32Array(32000);
  blip.set(audio('en1').slice(8000, 11200), 8000);
  assert.deepEqual(hear(blip, 'en', 'blip'), []);
});

test('habla seguida de 15 s se entiende entera aunque se corte en varios segmentos', { skip: skipReason }, () => {
  const ids = ['es2', 'es3', 'es4', 'es5'];
  const parts = ids.map(audio);
  const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { joined.set(p, offset); offset += p.length; }
  const heard = textOf(hear(joined, 'es', 'long'));
  const reference = ids.map((id) => phrases.es.find((p) => p.id === id).text).join(' ');
  const rate = wordErrorRate(reference, heard);
  console.log(`  largo WER=${rate.toFixed(2)} "${heard}"`);
  assert.ok(rate <= 0.15, `error ${rate.toFixed(3)}`);
});

test('micrófono en español y receptor en inglés a la vez no se mezclan', { skip: skipReason }, () => {
  const { engine: e, posted } = engine();
  const from = posted.length;
  const mic = audio('es3');
  const incoming = audio('en3');
  const length = Math.max(mic.length, incoming.length) + 16000;
  const pad = (a) => { const out = new Float32Array(length); out.set(a); return out; };
  const a = pad(mic);
  const b = pad(incoming);
  for (let i = 0; i < length; i += 2048) {
    e.handle({ type: 'audio', stream: 'mix-mic', lang: 'es', samples: a.slice(i, i + 2048) });
    e.handle({ type: 'audio', stream: 'mix-in', lang: 'en', samples: b.slice(i, i + 2048) });
  }
  e.handle({ type: 'flush', stream: 'mix-mic', lang: 'es' });
  e.handle({ type: 'flush', stream: 'mix-in', lang: 'en' });
  const segments = posted.slice(from).filter((m) => m.type === 'segment');
  const heardMic = textOf(segments.filter((s) => s.stream === 'mix-mic'));
  const heardIn = textOf(segments.filter((s) => s.stream === 'mix-in'));
  assert.ok(wordErrorRate(phrases.es[2].text, heardMic) <= 0.2, heardMic);
  assert.ok(wordErrorRate(phrases.en[2].text, heardIn) <= 0.2, heardIn);
});
