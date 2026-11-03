const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { store, skipReason } = require('./support/models');
const { readWav } = require('./support/wav');
const { wordErrorRate, hasKeywords } = require('./support/text');
const { pinkNoise, mixAtSnr } = require('./support/noise');
const { createEngine } = require('../local-ai/engine');
const { createTextTranslator, modelsFromPaths } = require('../local-ai/text-translator');
const phrases = require('./fixtures/phrases.json');

const audio = (id) => readWav(path.join(__dirname, 'fixtures', 'audio', `${id}.wav`));

let shared = null;
let translator = null;
// El traductor de texto se carga de forma asíncrona, como en el proceso utilitario
test.before(async () => {
  if (!skipReason) translator = await createTextTranslator({ models: modelsFromPaths(store.paths()) });
});

/** Un solo motor para todo el archivo: cargar el modelo cuesta ~1,5 s. */
function engine() {
  if (!shared) {
    const posted = [];
    shared = { posted, engine: createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m), translator }) };
  }
  return shared;
}

/** Pasa un audio por el motor como lo haría el renderer y devuelve los segmentos publicados. */
function hear(samples, lang, stream, target) {
  const { engine: e, posted } = engine();
  const from = posted.length;
  const padded = new Float32Array(samples.length + 16000);
  padded.set(samples);
  for (let i = 0; i < padded.length; i += 2048) e.handle({ type: 'audio', stream, lang, target, samples: padded.slice(i, i + 2048) });
  e.handle({ type: 'flush', stream, lang });
  return posted.slice(from).filter((m) => m.type === 'segment');
}

const textOf = (segments) => segments.map((s) => s.text).join(' ');

/** Traducción del motor: la de cada frase, o la de la frase entera si el trozo continuaba otra. */
function translate(segments) {
  const lines = [];
  for (const seg of segments) {
    if (seg.join && seg.join.translated) lines[lines.length - 1] = seg.join.translated;
    else lines.push(seg.translated || '');
  }
  return lines.join(' ');
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
    const translated = translate(hear(audio(p.id), 'es', `tr-es-${i}`, 'en'));
    console.log(`  ${p.id} -> "${translated}"`);
    if (!hasKeywords(translated, p.keywordsEn)) misses.push(`${p.id}: "${translated}" sin ${p.keywordsEn}`);
  });
  assert.deepEqual(misses, []);
});

test('traduce EN→ES en local: cada frase conserva sus palabras clave', { skip: skipReason }, () => {
  const misses = [];
  phrases.en.forEach((p, i) => {
    const translated = translate(hear(audio(p.id), 'en', `tr-en-${i}`, 'es'));
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

/** Inserta 500 ms de silencio en el punto más tranquilo cerca de `fraction` del audio: la frase llega en dos trozos. */
function splitAt(samples, fraction) {
  const win = 320; // 20 ms
  let best = -1;
  let bestEnergy = Infinity;
  for (let i = Math.floor(samples.length * (fraction - 0.05)); i < samples.length * (fraction + 0.05); i += 160) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += samples[j] * samples[j];
    if (e < bestEnergy) { bestEnergy = e; best = i + win / 2; }
  }
  const out = new Float32Array(samples.length + 8000);
  out.set(samples.subarray(0, best));
  out.set(samples.subarray(best), best + 8000);
  return out;
}

// Cortes entre dos palabras de la misma frase («The customer wants a | demonstration next week.»)
for (const [id, lang, target, fraction, key] of [['en4', 'en', 'es', 0.3, 'keywordsEs'], ['es2', 'es', 'en', 0.7, 'keywordsEn']]) {
  test(`una frase cortada por una pausa breve se une y se traduce entera (${id})`, { skip: skipReason }, () => {
    const phrase = phrases[lang].find((p) => p.id === id);
    const segments = hear(splitAt(audio(id), fraction), lang, `split-${id}`, target);
    console.log(segments.map((s) => `  [${s.gapMs ?? '-'} ms] "${s.text}" → "${s.translated}"${s.join ? ` | frase: "${s.join.text}" → "${s.join.translated}"` : ''}`).join('\n'));
    // El detector también corta en las pausas naturales (la coma de «Buenos días a todos, …»): puede haber más de
    // dos trozos, pero el que sigue a la pausa insertada continúa su frase y la frase llega entera
    assert.ok(segments.length >= 2, 'el detector de voz la corta en la pausa');
    const last = segments[segments.length - 1];
    const before = segments[segments.length - 2];
    assert.ok(last.join, 'el trozo tras la pausa continúa la frase');
    assert.equal(last.join.lineId, before.id);
    // el detector cuenta el margen previo de cada frase: mide algo menos que los 500 ms de silencio insertados
    assert.ok(last.gapMs > 100 && last.gapMs <= 500, `pausa medida ${last.gapMs} ms`);
    const lines = [...segments.slice(0, -2).filter((sg) => !sg.join).map((sg) => sg), { text: last.join.text, translated: last.join.translated }];
    const heard = lines.map((l) => l.text).join(' ');
    assert.ok(wordErrorRate(phrase.text, heard) <= 0.2, heard);
    const said = lines.map((l) => l.translated).join(' ');
    assert.ok(hasKeywords(said, phrase[key]), said);
  });
}

test('dos frases completas seguidas no se unen', { skip: skipReason }, () => {
  const a = audio('es3');
  const b = audio('es4');
  const both = new Float32Array(a.length + 8000 + b.length);
  both.set(a);
  both.set(b, a.length + 8000);
  const segments = hear(both, 'es', 'two-es', 'en');
  assert.equal(segments.length, 2);
  assert.equal(segments[1].join, undefined, `"${segments[0].text}" + "${segments[1].text}"`);
});

// «Hi,» o «Sí,» seguidos de pausa no llegan a los 400 ms de voz que pide el detector: antes la frase empezaba en la
// palabra siguiente (pasó en 9 de 18 turnos de la entrevista de prueba)
for (const lang of ['en', 'es']) {
  test(`la palabra corta del comienzo, seguida de una pausa, no se pierde (${lang})`, { skip: skipReason }, () => {
    for (const phrase of phrases.shortStart[lang]) {
      const speech = audio(phrase.id);
      const samples = pinkNoise(16000 + speech.length, 4).map((v) => v * 0.02); // 1 s de sala antes de hablar
      for (let i = 0; i < speech.length; i++) samples[16000 + i] += speech[i];
      const heard = textOf(hear(samples, lang, `short-${phrase.id}`));
      console.log(`  ${phrase.id}: "${heard}"`);
      const firstWords = heard.toLowerCase().split(/\s+/).slice(0, 2).map((w) => w.replace(/[^\p{L}]/gu, ''));
      assert.ok(firstWords.includes(phrase.first), `"${heard}" debería empezar por «${phrase.first}»`);
    }
  });
}

// Jerga técnica dicha con voz real: el diccionario corrige lo que el reconocedor escribe a su manera y la traducción
// local conserva los términos que se dicen en inglés
const { createTechGlossary, translatorWordCheck } = require('../local-ai/tech-glossary');
const { loadLexicon } = require('../local-ai/spm-lexicon');

for (const [lang, target] of [['es', 'en'], ['en', 'es']]) {
  test(`frases técnicas (${lang}): términos corregidos en lo oído y conservados en la traducción`, { skip: skipReason }, () => {
    const lexicon = loadLexicon(store.paths().mtEsEnVocab);
    const glossary = createTechGlossary({ isKnownWord: (w) => lexicon.has(w), isWord: translatorWordCheck(translator) });
    const posted = [];
    const e = createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m), translator, glossary });
    const lower = (s) => s.toLowerCase();
    for (const phrase of phrases.tech[lang]) {
      const padded = new Float32Array(audio(phrase.id).length + 16000);
      padded.set(audio(phrase.id));
      const from = posted.length;
      for (let i = 0; i < padded.length; i += 2048) e.handle({ type: 'audio', stream: `tech-${phrase.id}`, lang, target, samples: padded.slice(i, i + 2048) });
      e.handle({ type: 'flush', stream: `tech-${phrase.id}` });
      const segments = posted.slice(from).filter((m) => m.type === 'segment');
      const heard = textOf(segments);
      const translated = translate(segments);
      console.log(`  ${phrase.id}: oído "${segments.map((s) => s.heard || s.text).join(' ')}"\n      corregido "${heard}"\n      → "${translated}"`);
      const missing = phrase.terms.filter((t) => !lower(heard).includes(lower(t)));
      const lost = phrase.terms.filter((t) => lower(heard).includes(lower(t)) && !lower(translated).includes(lower(t)));
      assert.ok(missing.length <= 1, `faltan en lo oído: ${missing.join(', ')}`);
      assert.deepEqual(lost, [], 'términos oídos que la traducción no conservó');
    }
  });
}
