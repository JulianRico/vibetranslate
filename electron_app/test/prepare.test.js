const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrepare } = require('../local-ai/prepare');

function setup({ ready = true, ensureError = null, startError = null } = {}) {
  const calls = [];
  let releaseDownload = null;
  const store = {
    status: () => ({ ready, missing: [], missingBytes: ready ? 0 : 1000 }),
    ensure: (onProgress) => {
      calls.push('ensure');
      return new Promise((resolve, reject) => {
        releaseDownload = () => {
          onProgress({ file: 'm', overallLoaded: 1000, overallTotal: 1000 });
          if (ensureError) reject(ensureError); else resolve();
        };
      });
    },
    paths: () => ({ vad: 'v' })
  };
  const client = {
    start: async (init) => { calls.push(['start', init]); if (startError) throw startError; return { loadMs: 1400 }; },
    stop: () => { calls.push('stop'); }
  };
  const progress = [];
  const session = createPrepare({ store, client, onProgress: (p) => progress.push(p) });
  return { session, calls, progress, finishDownload: () => releaseDownload() };
}

test('con los modelos presentes arranca el motor sin descargar', async () => {
  const t = setup();
  assert.deepEqual(await t.session.prepare({ vadThreshold: 0.6 }), { ok: true, loadMs: 1400 });
  assert.deepEqual(t.calls, [['start', { paths: { vad: 'v' }, vadThreshold: 0.6, captureAudio: false }]]);
});

test('si faltan modelos los descarga, informa el progreso y luego arranca', async () => {
  const t = setup({ ready: false });
  const pending = t.session.prepare();
  await Promise.resolve();
  t.finishDownload();
  assert.equal((await pending).ok, true);
  assert.equal(t.progress.length, 1);
  assert.deepEqual(t.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['ensure', 'start']);
});

test('si el usuario detiene durante la descarga, el motor no se arranca al terminar', async () => {
  const t = setup({ ready: false });
  const pending = t.session.prepare();
  await Promise.resolve();
  t.session.cancel();
  t.finishDownload();
  assert.deepEqual(await pending, { ok: false, cancelled: true });
  assert.deepEqual(t.calls, ['ensure', 'stop']);
});

test('cancel detiene el motor en marcha', async () => {
  const t = setup();
  await t.session.prepare();
  t.session.cancel();
  assert.equal(t.calls[t.calls.length - 1], 'stop');
});

test('un fallo de descarga o de arranque se devuelve como error, no como excepción', async () => {
  const download = setup({ ready: false, ensureError: new Error('Descarga corrupta de m') });
  const pending = download.session.prepare();
  await Promise.resolve();
  download.finishDownload();
  assert.deepEqual(await pending, { ok: false, error: 'Descarga corrupta de m' });

  const start = setup({ startError: new Error('modelo ilegible') });
  assert.deepEqual(await start.session.prepare(), { ok: false, error: 'modelo ilegible' });
});

test('si hay una sesión de prueba grabando audio, el motor arranca con la captura activada', async () => {
  const t = setup();
  await t.session.prepare({ vadThreshold: 0.5, captureAudio: true });
  assert.deepEqual(t.calls, [['start', { paths: { vad: 'v' }, vadThreshold: 0.5, captureAudio: true }]]);
});
