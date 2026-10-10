const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createModelStore, MODEL_FILES } = require('../local-ai/model-store');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-models-'));

function fixture() {
  const a = Buffer.from('aaaaaaaaaa');
  const b = Buffer.from('bbbbbbbbbbbbbbbbbbbb');
  const files = [
    { id: 'vad', file: 'a.onnx', url: 'https://example.test/a', size: a.length, sha256: sha(a) },
    { id: 'encoder', file: 'b.onnx', url: 'https://example.test/b', size: b.length, sha256: sha(b) }
  ];
  const bodies = { 'https://example.test/a': a, 'https://example.test/b': b };
  return { files, bodies };
}

function fakeFetch(bodies, { failUrl = null, breakUrl = null } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === failUrl) return { ok: false, status: 503, body: null };
    const data = bodies[url];
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield data.subarray(0, 5);
        if (url === breakUrl) throw new Error('socket hang up');
        yield data.subarray(5);
      })()
    };
  };
  return { impl, calls };
}

test('la lista real declara los cuatro archivos con tamaño y suma', () => {
  assert.deepEqual(MODEL_FILES.map((f) => f.id), ['vad', 'encoder', 'decoder', 'tokens']);
  for (const f of MODEL_FILES) {
    assert.match(f.url, /^https:\/\//);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 0);
  }
});

test('status informa lo que falta y ensure lo descarga con progreso', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const { impl } = fakeFetch(bodies);
  const store = createModelStore({ dir, files, fetchImpl: impl });

  assert.deepEqual(store.status(), {
    ready: false,
    missing: [{ id: 'vad', file: 'a.onnx', size: 10 }, { id: 'encoder', file: 'b.onnx', size: 20 }],
    missingBytes: 30
  });

  const progress = [];
  await store.ensure((p) => progress.push(p));

  assert.equal(store.status().ready, true);
  assert.equal(fs.readFileSync(store.paths().vad, 'utf8'), 'aaaaaaaaaa');
  const last = progress[progress.length - 1];
  assert.equal(last.overallLoaded, 30);
  assert.equal(last.overallTotal, 30);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.onnx']);
});

test('ensure no vuelve a descargar lo que ya está completo', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx'), bodies['https://example.test/a']);
  const { impl, calls } = fakeFetch(bodies);
  await createModelStore({ dir, files, fetchImpl: impl }).ensure();
  assert.deepEqual(calls, ['https://example.test/b']);
});

test('una suma incorrecta borra el parcial y deja el modelo como faltante', async () => {
  const { files, bodies } = fixture();
  files[0].sha256 = '0'.repeat(64);
  const dir = tmpDir();
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  await assert.rejects(store.ensure(), /a\.onnx/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(store.status().ready, false);
});

test('una descarga cortada a mitad no deja archivo y el reintento funciona', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const broken = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies, { breakUrl: 'https://example.test/a' }).impl });
  await assert.rejects(broken.ensure(), /socket hang up/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const retry = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  await retry.ensure();
  assert.equal(retry.status().ready, true);
});

test('un archivo truncado en disco cuenta como faltante', () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx'), 'aaa');
  fs.writeFileSync(path.join(dir, 'b.onnx'), bodies['https://example.test/b']);
  const status = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl }).status();
  assert.deepEqual(status.missing.map((m) => m.id), ['vad']);
});

test('una respuesta HTTP de error se informa con el archivo y el código', async () => {
  const { files, bodies } = fixture();
  const store = createModelStore({ dir: tmpDir(), files, fetchImpl: fakeFetch(bodies, { failUrl: 'https://example.test/a' }).impl });
  await assert.rejects(store.ensure(), /a\.onnx.*503/);
});
