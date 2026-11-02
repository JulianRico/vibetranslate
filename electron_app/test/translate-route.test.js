const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranslateRouter } = require('../local-ai/translate-route');

const PAIR = { source: 'es', target: 'en' };
const REQUEST = { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en', segmentId: 7, pair: PAIR };
const CLOUD_OK = { original: 'Hola.', translated: 'Hello.', detectedLang: 'es', targetLang: 'en', elapsedMs: 120, engine: 'google' };
const CLOUD_FAILED = { original: 'Hola.', translated: 'Hola.', detectedLang: 'es', targetLang: 'en', elapsedMs: 11000, engine: 'none' };

function setup({ cloudResult = CLOUD_OK, localResult = { ok: true, translated: 'Hi.', elapsedMs: 410 }, online = true, mode = 'auto' } = {}) {
  const calls = [];
  const clock = { now: 1000 };
  const translate = createTranslateRouter({
    now: () => clock.now,
    cloud: async (req) => { calls.push(['cloud', req]); return cloudResult; },
    local: async (req) => { calls.push(['local', req]); if (localResult instanceof Error) throw localResult; return localResult; },
    isOnline: () => online,
    getMode: () => mode
  });
  return { translate, calls, clock };
}

test('con red y modo auto traduce en la nube y no toca el motor local', async () => {
  const t = setup();
  assert.deepEqual(await t.translate(REQUEST), CLOUD_OK);
  assert.deepEqual(t.calls, [['cloud', { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }]]);
});

test('sin red va directo al motor local, sin esperar a la nube', async () => {
  const t = setup({ online: false });
  assert.deepEqual(await t.translate(REQUEST), { original: 'Hola.', translated: 'Hi.', detectedLang: 'es', targetLang: 'en', elapsedMs: 410, engine: 'local' });
  // el texto viaja al motor local; el identificador de la frase sirve si no hay traductor de texto
  assert.deepEqual(t.calls, [['local', { text: 'Hola.', source: 'es', target: 'en', segmentId: 7 }]]);
});

test('en modo local traduce siempre en local aunque haya red', async () => {
  const t = setup({ mode: 'local' });
  assert.equal((await t.translate(REQUEST)).engine, 'local');
  assert.equal(t.calls.length, 1);
});

test('si la nube falla en todos sus niveles, recurre al motor local', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED });
  assert.equal((await t.translate(REQUEST)).translated, 'Hi.');
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud', 'local']);
});

test('si el motor local falla estando sin red, se intenta la nube igualmente', async () => {
  const t = setup({ online: false, localResult: new Error('motor detenido') });
  assert.deepEqual(await t.translate(REQUEST), CLOUD_OK);
  assert.deepEqual(t.calls.map((c) => c[0]), ['local', 'cloud']);
});

const NO_TRANSLATION = { original: 'Hola.', translated: '', detectedLang: 'es', targetLang: 'en', engine: 'none' };
const outcome = ({ elapsedMs, error, ...rest }) => rest;

test('en modo local nada sale del equipo: si el motor local falla no se llama a la nube', async () => {
  for (const localResult of [{ ok: true, translated: '  ' }, { ok: false, error: 'ya no está' }, new Error('motor detenido')]) {
    const t = setup({ mode: 'local', localResult });
    const result = await t.translate(REQUEST);
    assert.deepEqual(outcome(result), NO_TRANSLATION);
    assert.ok(result.error);
    assert.deepEqual(t.calls.map((c) => c[0]), ['local']);
  }
});

test('si fallan la nube y el local no se presenta el texto original como traducción', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED, localResult: new Error('x') });
  assert.deepEqual(outcome(await t.translate(REQUEST)), NO_TRANSLATION);
});

test('tras un fallo de la nube las frases siguientes van directas al local durante 30 s (Wi-Fi conectado sin internet)', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED });
  await t.translate(REQUEST);
  await t.translate(REQUEST);
  t.clock.now += 29000;
  await t.translate(REQUEST);
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud', 'local', 'local', 'local']);
  t.clock.now += 2000;
  await t.translate(REQUEST);
  assert.deepEqual(t.calls.map((c) => c[0]).slice(4), ['cloud', 'local']);
});

test('sin identificador de segmento (motores en la nube) solo existe la nube', async () => {
  const t = setup({ online: false, mode: 'local', cloudResult: CLOUD_FAILED });
  assert.deepEqual(await t.translate({ text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }), CLOUD_FAILED);
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud']);
});
