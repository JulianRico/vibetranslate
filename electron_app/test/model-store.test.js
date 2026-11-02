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

function fakeFetch(bodies, { failUrl = null, breakUrl = null, ignoreRange = false } = {}) {
  const calls = [];
  const ranges = [];
  const impl = async (url, options = {}) => {
    calls.push(url);
    const range = options.headers && options.headers.Range;
    ranges.push(range || null);
    if (url === failUrl) return { ok: false, status: 503, body: null };
    const from = range && !ignoreRange ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const data = bodies[url].subarray(from);
    return {
      ok: true,
      status: from > 0 ? 206 : 200,
      body: (async function* () {
        yield data.subarray(0, 5);
        if (url === breakUrl) throw new Error('socket hang up');
        yield data.subarray(5);
      })()
    };
  };
  return { impl, calls, ranges };
}

test('la lista real declara voz, transcripción y traducción EN↔ES con tamaño y suma', () => {
  assert.deepEqual(MODEL_FILES.map((f) => f.id), [
    'vad', 'encoder', 'decoder', 'tokens',
    'mtEnEs', 'mtEnEsLex', 'mtEnEsVocab', 'mtEsEn', 'mtEsEnLex', 'mtEsEnVocab'
  ]);
  for (const f of MODEL_FILES) {
    assert.match(f.url, /^https:\/\//);
    // una rama puede cambiar de contenido y romper todas las instalaciones: se fija la revisión
    assert.doesNotMatch(f.url, /\/resolve\/main\//);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.size > 0);
    if (f.gzip) {
      assert.match(f.url, /\.gz$/);
      assert.ok(f.downloadSize > 0 && f.downloadSize < f.size, `${f.file}: lo comprimido ocupa menos`);
    }
  }
  assert.equal(new Set(MODEL_FILES.map((f) => f.file)).size, MODEL_FILES.length, 'cada archivo con su nombre');
});

/** Un modelo que el servidor entrega comprimido con gzip. */
function gzipFixture() {
  const zlib = require('node:zlib');
  const plain = Buffer.from('modelo de traducción '.repeat(50));
  const packed = zlib.gzipSync(plain);
  const files = [{ id: 'mt', file: 'mt.bin', url: 'https://example.test/mt.gz', gzip: true, downloadSize: packed.length, size: plain.length, sha256: sha(plain) }];
  return { files, plain, packed, bodies: { 'https://example.test/mt.gz': packed } };
}

test('un modelo comprimido se descarga, se descomprime y se verifica sobre el archivo final', async () => {
  const { files, plain, packed, bodies } = gzipFixture();
  const dir = tmpDir();
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  assert.equal(store.status().missingBytes, packed.length, 'se informa lo que se va a bajar, no lo que ocupará');

  const progress = [];
  await store.ensure((p) => progress.push(p));
  assert.deepEqual(fs.readFileSync(store.paths().mt), plain);
  assert.deepEqual(fs.readdirSync(dir), ['mt.bin'], 'no quedan parciales');
  assert.equal(progress[progress.length - 1].overallLoaded, packed.length);
  assert.equal(progress[progress.length - 1].overallTotal, packed.length);
  assert.equal(store.status().ready, true);
});

test('un comprimido cortado se reanuda donde se quedó', async () => {
  const { files, plain, bodies } = gzipFixture();
  const dir = tmpDir();
  const url = files[0].url;
  await assert.rejects(createModelStore({ dir, files, fetchImpl: fakeFetch(bodies, { breakUrl: url }).impl }).ensure(), /socket hang up/);
  assert.deepEqual(fs.readdirSync(dir), ['mt.bin.gz.part']);

  const server = fakeFetch(bodies);
  const store = createModelStore({ dir, files, fetchImpl: server.impl });
  await store.ensure();
  assert.equal(server.ranges[0], 'bytes=5-');
  assert.deepEqual(fs.readFileSync(store.paths().mt), plain);
});

test('un comprimido que no descomprime o no verifica no deja nada a medias', async () => {
  const { files, packed } = gzipFixture();
  const garbage = Buffer.alloc(packed.length, 7); // mismo tamaño, pero no es gzip
  const dir = tmpDir();
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch({ [files[0].url]: garbage }).impl });
  await assert.rejects(store.ensure(), /Descarga corrupta de mt\.bin/);
  assert.deepEqual(fs.readdirSync(dir), []);

  const wrongSum = [{ ...files[0], sha256: '0'.repeat(64) }];
  const other = createModelStore({ dir, files: wrongSum, fetchImpl: fakeFetch({ [files[0].url]: packed }).impl });
  await assert.rejects(other.ensure(), /suma de verificación/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(other.status().ready, false);
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

test('una descarga cortada no deja el modelo a medias como válido y el reintento continúa donde se quedó', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const broken = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies, { breakUrl: 'https://example.test/a' }).impl });
  await assert.rejects(broken.ensure(), /socket hang up/);
  assert.deepEqual(fs.readdirSync(dir), ['a.onnx.part']);
  assert.equal(broken.status().ready, false);

  const server = fakeFetch(bodies);
  const retry = createModelStore({ dir, files, fetchImpl: server.impl });
  await retry.ensure();
  assert.equal(server.ranges[0], 'bytes=5-', 'debe pedir solo lo que falta');
  assert.equal(fs.readFileSync(retry.paths().vad, 'utf8'), 'aaaaaaaaaa');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.onnx']);
});

test('si el servidor no admite reanudar y lo envía todo de nuevo, se empieza de cero sin duplicar bytes', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx.part'), 'aaaaa');
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies, { ignoreRange: true }).impl });
  await store.ensure();
  assert.equal(fs.readFileSync(store.paths().vad, 'utf8'), 'aaaaaaaaaa');
});

test('un parcial dañado se descarta al verificar y el siguiente intento descarga limpio', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.onnx.part'), 'XXXXX');
  const store = createModelStore({ dir, files, fetchImpl: fakeFetch(bodies).impl });
  await assert.rejects(store.ensure(), /Descarga corrupta de a\.onnx/);
  assert.deepEqual(fs.readdirSync(dir), []);
  await store.ensure();
  assert.equal(store.status().ready, true);
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

test('dos ensure a la vez comparten una sola descarga: nunca dos escritores sobre el mismo archivo', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const { impl, calls } = fakeFetch(bodies);
  const store = createModelStore({ dir, files, fetchImpl: impl });
  await Promise.all([store.ensure(), store.ensure()]);
  assert.deepEqual(calls, ['https://example.test/a', 'https://example.test/b']);
  assert.equal(fs.readFileSync(store.paths().encoder, 'utf8'), 'bbbbbbbbbbbbbbbbbbbb');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.onnx', 'b.onnx']);
});

test('una descarga que deja de enviar datos se corta con error en vez de quedarse esperando', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  const stalled = async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield bodies['https://example.test/a'].subarray(0, 5);
      await new Promise(() => {}); // el servidor deja de responder
    })()
  });
  const store = createModelStore({ dir, files, fetchImpl: stalled, stallMs: 50 });
  await assert.rejects(store.ensure(), /a\.onnx.*sin recibir datos/);
  assert.deepEqual(fs.readdirSync(dir), ['a.onnx.part']); // se conserva para reanudar
  assert.equal(store.status().ready, false);
});

test('se verifica lo que quedó en disco, no solo lo que llegó por la red', async () => {
  const { files, bodies } = fixture();
  const dir = tmpDir();
  // Otro proceso pisa el parcial mientras se descarga: el tamaño coincide pero el contenido no
  const tamper = async (url) => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield bodies[url];
      for (const name of fs.readdirSync(dir)) {
        if (name.includes('.part')) fs.writeFileSync(path.join(dir, name), 'X'.repeat(bodies[url].length));
      }
    })()
  });
  const store = createModelStore({ dir, files, fetchImpl: tamper });
  await assert.rejects(store.ensure(), /a\.onnx/);
  assert.equal(store.status().ready, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});
