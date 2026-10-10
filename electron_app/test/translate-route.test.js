const test = require('node:test');
const assert = require('node:assert/strict');
const { createTranslateRouter } = require('../local-ai/translate-route');

const PAIR = { source: 'es', target: 'en' };
const REQUEST = { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en', segmentId: 7, pair: PAIR };
const CLOUD_OK = { original: 'Hola.', translated: 'Hello.', detectedLang: 'es', targetLang: 'en', elapsedMs: 120, engine: 'google' };
const CLOUD_FAILED = { original: 'Hola.', translated: 'Hola.', detectedLang: 'es', targetLang: 'en', elapsedMs: 11000, engine: 'none' };

function setup({ cloudResult = CLOUD_OK, localResult = { ok: true, translated: 'Hi.', elapsedMs: 410 }, online = true, mode = 'auto' } = {}) {
  const calls = [];
  const translate = createTranslateRouter({
    cloud: async (req) => { calls.push(['cloud', req]); return cloudResult; },
    local: async (req) => { calls.push(['local', req]); if (localResult instanceof Error) throw localResult; return localResult; },
    isOnline: () => online,
    getMode: () => mode
  });
  return { translate, calls };
}

test('con red y modo auto traduce en la nube y no toca el motor local', async () => {
  const t = setup();
  assert.deepEqual(await t.translate(REQUEST), CLOUD_OK);
  assert.deepEqual(t.calls, [['cloud', { text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }]]);
});

test('sin red va directo al motor local, sin esperar a la nube', async () => {
  const t = setup({ online: false });
  assert.deepEqual(await t.translate(REQUEST), { original: 'Hola.', translated: 'Hi.', detectedLang: 'es', targetLang: 'en', elapsedMs: 410, engine: 'local' });
  assert.deepEqual(t.calls, [['local', { id: 7, target: 'en' }]]);
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

test('una respuesta local vacía o con error no se da por buena', async () => {
  const empty = setup({ mode: 'local', localResult: { ok: true, translated: '  ' } });
  assert.equal((await empty.translate(REQUEST)).engine, 'google');
  const failed = setup({ mode: 'local', localResult: { ok: false, error: 'ya no está' } });
  assert.equal((await failed.translate(REQUEST)).engine, 'google');
});

test('si fallan la nube y el local devuelve el resultado de la nube (texto original)', async () => {
  const t = setup({ cloudResult: CLOUD_FAILED, localResult: new Error('x') });
  assert.deepEqual(await t.translate(REQUEST), CLOUD_FAILED);
});

test('sin identificador de segmento (motores en la nube) solo existe la nube', async () => {
  const t = setup({ online: false, mode: 'local', cloudResult: CLOUD_FAILED });
  assert.deepEqual(await t.translate({ text: 'Hola.', sourceLang: 'es-ES', targetLang: 'en' }), CLOUD_FAILED);
  assert.deepEqual(t.calls.map((c) => c[0]), ['cloud']);
});
