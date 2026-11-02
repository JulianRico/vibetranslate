const test = require('node:test');
const assert = require('node:assert/strict');
const { store, skipReason } = require('./support/models');
const { hasKeywords } = require('./support/text');
const { createTextTranslator, modelsFromPaths } = require('../local-ai/text-translator');
const phrases = require('./fixtures/phrases.json');

let shared = null;
/** Un traductor para todo el archivo: cargar los dos modelos tarda ~0,5 s. */
async function translator() {
  if (!shared) shared = await createTextTranslator({ models: modelsFromPaths(store.paths()) });
  return shared;
}

test('carga los dos sentidos EN↔ES a partir de las rutas del almacén', { skip: skipReason }, async () => {
  const t = await translator();
  assert.deepEqual(t.pairs().sort(), ['en-es', 'es-en']);
});

for (const [from, to, key] of [['en', 'es', 'keywordsEs'], ['es', 'en', 'keywordsEn']]) {
  test(`traduce las 5 frases de ${from} a ${to} con sus palabras clave`, { skip: skipReason }, async () => {
    const t = await translator();
    for (const p of phrases[from]) {
      const out = t.translate(p.text, from, to);
      console.log(`  ${p.id} ${out.ms}ms "${out.text}"`);
      assert.ok(hasKeywords(out.text, p[key]), `"${out.text}" debería contener ${p[key].join(', ')}`);
    }
  });
}

test('frases reales de las sesiones de prueba: mejor que la traducción directa de Canary', { skip: skipReason }, async () => {
  const t = await translator();
  // Casos que Canary traducía mal en las sesiones del 10/10/2026
  const cases = [
    ['esa tendencia que está al alza.', 'es', 'en', /trend/i, /Tendency That/],
    ['Join our school community where we simulate real AI research lab.', 'en', 'es', /laboratorio de investigación/i, /\bAI\b/],
    ['then AI will do everything.', 'en', 'es', /\bIA\b/, /\bAI\b/]
  ];
  for (const [text, from, to, must, mustNot] of cases) {
    const out = t.translate(text, from, to).text;
    assert.match(out, must, out);
    assert.doesNotMatch(out, mustNot, out);
  }
});

test('es rápido: una frase de reunión tarda bastante menos que medio segundo', { skip: skipReason }, async () => {
  const t = await translator();
  const times = phrases.en.map((p) => t.translate(p.text, 'en', 'es').ms).sort((a, b) => a - b);
  console.log(`  tiempos EN→ES: ${times.join(', ')} ms`);
  assert.ok(times[Math.floor(times.length / 2)] < 300, `mediana ${times[2]} ms`);
});

test('varios textos de una vez conservan el orden; los vacíos quedan vacíos', { skip: skipReason }, async () => {
  const t = await translator();
  const out = t.translateMany(['Good morning.', '', '  ', 'Thank you.'], 'en', 'es');
  assert.equal(out.length, 4);
  assert.match(out[0], /buenos días/i);
  assert.equal(out[1], '');
  assert.equal(out[2], '');
  assert.match(out[3], /gracias/i);
});

test('las comillas tipográficas salen rectas, para la voz y el registro', { skip: skipReason }, async () => {
  const t = await translator();
  const out = t.translate('vamos a revisar un poco esa tendencia que está al alza.', 'es', 'en').text;
  assert.doesNotMatch(out, /[‘’“”]/);
});

test('un par sin modelo falla con un mensaje claro', { skip: skipReason }, async () => {
  const t = await translator();
  assert.throws(() => t.translate('Bonjour', 'fr', 'es'), /fr → es/);
});
