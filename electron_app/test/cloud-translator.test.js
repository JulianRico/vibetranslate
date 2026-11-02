const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudTranslator, cleanLlmOutput, isPlausibleTranslation } = require('../cloud-translator');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Servidor falso: `google` y `groq` son funciones (cuerpo de la petición) → { status, body, delayMs, headers }. */
function fakeFetch({ google = () => ({ body: [[['hola']], null, 'en'] }), groq = () => ({ body: { choices: [{ message: { content: 'hola llm' } }] } }) } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const isGroq = url.includes('groq.com');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ to: isGroq ? 'groq' : 'google', model: body && body.model, body });
    const spec = (isGroq ? groq : google)(body, calls.length);
    if (spec.delayMs) await delay(spec.delayMs);
    if (spec.throws) throw new Error(spec.throws);
    const status = spec.status || 200;
    const headers = new Map(Object.entries(spec.headers || {}));
    return { ok: status < 300, status, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, json: async () => spec.body, text: async () => JSON.stringify(spec.body) };
  };
  return { impl, calls };
}

const make = (fetch, extra = {}) => createCloudTranslator({ fetchImpl: fetch.impl, getGroqKey: () => 'gsk_test_key', ...extra });

test('limpia lo que el LLM añade: razonamiento, comillas, prefijos y restos de etiquetas', () => {
  assert.equal(cleanLlmOutput('<think>hmm</think>"Hola a todos."'), 'Hola a todos.');
  assert.equal(cleanLlmOutput('Translation: Hola'), 'Hola');
  assert.equal(cleanLlmOutput('Así que,?>'), 'Así que,?');
  assert.equal(cleanLlmOutput('Let’s go'), "Let's go");
  assert.equal(cleanLlmOutput('«Vamos»'), 'Vamos');
});

test('reconoce respuestas que no son una traducción', () => {
  // casos reales de la evaluación: gpt-oss-20b devolvió el fragmento sin traducir
  const fragment = 'happen in a year, super intelligence, whatever, then humans will be useless, then AI will do everything. So,';
  assert.equal(isPlausibleTranslation(fragment, fragment, 'en', 'es'), false);
  assert.equal(isPlausibleTranslation('We need to review the quarterly budget.', 'We need to review the budget for this quarter.', 'en', 'es'), false, 'sigue en inglés');
  assert.equal(isPlausibleTranslation('Can you share your screen so we can all see the dashboard?', 'Sí.', 'en', 'es'), false, 'contesta en vez de traducir');
  assert.equal(isPlausibleTranslation('Sorry, you are breaking up.', '', 'en', 'es'), false);

  assert.equal(isPlausibleTranslation(fragment, 'pasar en un año, superinteligencia, lo que sea, entonces los humanos serán inútiles, entonces la IA lo hará todo. Así que,', 'en', 'es'), true);
  assert.equal(isPlausibleTranslation('Perdón, estaba en silencio.', 'Sorry, I was on mute.', 'es', 'en'), true);
  assert.equal(isPlausibleTranslation('Tokenizers.', 'Tokenizadores.', 'en', 'es'), true);
  assert.equal(isPlausibleTranslation('GitHub.', 'GitHub.', 'en', 'es'), true, 'un nombre propio se queda igual');
});

test('si el LLM responde bien no se espera a Google', async () => {
  const fetch = fakeFetch({ google: () => ({ body: [[['hola google']], null, 'en'], delayMs: 200 }), groq: () => ({ body: { choices: [{ message: { content: '¿Puedes compartir tu pantalla?' } }] } }) });
  const t0 = Date.now();
  const out = await make(fetch).translate('Can you share your screen?', 'en', 'es');
  assert.equal(out.translated, '¿Puedes compartir tu pantalla?');
  assert.equal(out.engine, 'groq');
  assert.equal(out.model, 'openai/gpt-oss-120b');
  assert.ok(Date.now() - t0 < 150, 'no espera a Google');
  const groqCall = fetch.calls.find((c) => c.to === 'groq');
  assert.equal(groqCall.body.reasoning_effort, 'low');
  assert.match(groqCall.body.messages[0].content, /English to Spanish.*informal "tú"/);
});

test('si el LLM devuelve algo descartable, se usa Google sin esperar más', async () => {
  const fetch = fakeFetch({ groq: () => ({ body: { choices: [{ message: { content: 'We need to review the quarterly budget.' } }] } }), google: () => ({ body: [[['Tenemos que revisar el presupuesto trimestral.']], null, 'en'] }) });
  const logs = [];
  const out = await make(fetch, { logger: (m) => logs.push(m) }).translate('We need to review the quarterly budget.', 'en', 'es');
  assert.equal(out.engine, 'google');
  assert.equal(out.translated, 'Tenemos que revisar el presupuesto trimestral.');
  assert.match(logs.join(' '), /descartada/);
});

test('si el LLM tarda, Google gana pasado el margen de espera', async () => {
  const fetch = fakeFetch({ groq: () => ({ body: { choices: [{ message: { content: 'tarde' } }] }, delayMs: 2500 }) });
  const t0 = Date.now();
  const out = await make(fetch).translate('hello there my friend', 'en', 'es');
  assert.equal(out.engine, 'google');
  const waited = Date.now() - t0;
  assert.ok(waited >= 950 && waited < 1900, `esperó ${waited} ms`);
});

test('sin clave de Groq, Google responde solo', async () => {
  const fetch = fakeFetch();
  const out = await createCloudTranslator({ fetchImpl: fetch.impl, getGroqKey: () => '' }).translate('hello', 'en', 'es');
  assert.equal(out.engine, 'google');
  assert.deepEqual(fetch.calls.map((c) => c.to), ['google']);
});

test('con el LLM en su límite (429) se pasa al modelo pequeño y se respeta la espera indicada', async () => {
  let clock = 1000;
  const fetch = fakeFetch({
    groq: (body) => (body.model === 'openai/gpt-oss-120b'
      ? { status: 429, headers: { 'retry-after': '30' }, body: {} }
      : { body: { choices: [{ message: { content: 'hola desde 20b' } }] } })
  });
  const cloud = make(fetch, { now: () => clock });
  await cloud.translate('hello there', 'en', 'es'); // 120b responde 429 → Google
  const second = await cloud.translate('hello there', 'en', 'es');
  assert.equal(second.model, 'openai/gpt-oss-20b');
  clock += 31000;
  await cloud.translate('hello there', 'en', 'es');
  const models = fetch.calls.filter((c) => c.to === 'groq').map((c) => c.model);
  assert.deepEqual(models, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
});

test('no pasa de 28 peticiones por minuto y modelo: después va al siguiente modelo y luego solo a Google', async () => {
  const clock = 5000;
  const fetch = fakeFetch();
  const cloud = make(fetch, { now: () => clock });
  for (let i = 0; i < 60; i++) await cloud.translate(`hello number ${i}`, 'en', 'es');
  const byModel = {};
  for (const c of fetch.calls.filter((x) => x.to === 'groq')) byModel[c.model] = (byModel[c.model] || 0) + 1;
  assert.deepEqual(byModel, { 'openai/gpt-oss-120b': 28, 'openai/gpt-oss-20b': 28 });
  assert.equal(fetch.calls.filter((x) => x.to === 'google').length, 60);
});

test('si fallan los dos, rechaza', async () => {
  const fetch = fakeFetch({ google: () => ({ throws: 'sin red' }), groq: () => ({ throws: 'sin red' }) });
  await assert.rejects(make(fetch).translate('hello', 'en', 'es'), /Fallaron/);
});

test('el LLM sabe que habla entre desarrolladores y recibe las pistas de términos mal oídos', async () => {
  const fetch = fakeFetch({ groq: () => ({ body: { choices: [{ message: { content: 'For the tests we use Testcontainers with real Postgres and Kafka.' } }] } }) });
  await make(fetch).translate('Para las pruebas usamos Testcontainers con postres y café reales.', 'es', 'en', {
    hints: [{ heard: 'postres', term: 'PostgreSQL' }, { heard: 'café', term: 'Kafka' }]
  });
  const prompt = fetch.calls.find((c) => c.to === 'groq').body.messages[0].content;
  assert.match(prompt, /software developers/);
  assert.match(prompt, /SharePoint/);
  assert.match(prompt, /"postres" may be PostgreSQL; "café" may be Kafka/);
});

test('sin pistas el prompt no las menciona', async () => {
  const fetch = fakeFetch();
  await make(fetch).translate('hello there', 'en', 'es');
  assert.doesNotMatch(fetch.calls.find((c) => c.to === 'groq').body.messages[0].content, /misheard/);
  // en inglés no hay términos escritos de oído: la indicación hacía ver «Vite» en «a bit garbled»
  assert.doesNotMatch(fetch.calls.find((c) => c.to === 'groq').body.messages[0].content, /phonetically/);
});
