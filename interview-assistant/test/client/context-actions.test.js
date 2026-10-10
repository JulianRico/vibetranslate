import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, initialState } from '../../public/application/store.js';
import { createContextActions } from '../../public/application/context-actions.js';

const CONFIG = {
  ai: true, limits: { maxUploadBytes: 12 * 1024 * 1024, maxItems: 20, maxActiveChars: 30000 },
  capabilities: { pdf: true, audio: true, docx: true, text: true },
};

function fakeGateway(overrides = {}) {
  const calls = [];
  const items = [];
  const rec = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  return {
    calls,
    config: rec('config', async () => CONFIG),
    list: rec('list', async () => ({ items: [...items], activeChars: 5, maxActiveChars: 30000 })),
    uploadFile: rec('uploadFile', async (file) => { items.push({ id: `c_${items.length + 1}`, name: file.name }); return {}; }),
    addText: rec('addText', async (body) => { items.push({ id: `c_${items.length + 1}`, name: body.name }); return {}; }),
    update: rec('update', async () => ({})),
    remove: rec('remove', async (id) => { items.splice(items.findIndex((i) => i.id === id), 1); }),
    getProfile: rec('getProfile', async () => ({ name: 'Julian' })),
    saveProfile: rec('saveProfile', async (p) => p),
    ...overrides,
  };
}

function setup(overrides) {
  const gateway = fakeGateway(overrides);
  const store = createStore(initialState());
  const actions = createContextActions({ gateway, store });
  return { gateway, store, actions, state: () => store.getState(), ctx: () => store.getState().context };
}

const file = (name, size = 100) => ({ name, size });

test('init loads config, the context list and the profile', async () => {
  const c = setup();
  await c.actions.init();
  assert.equal(c.state().config.ai, true);
  assert.equal(c.ctx().activeChars, 5);
  assert.equal(c.state().profile.name, 'Julian');
});

test('init survives a failing piece (the others still load)', async () => {
  const c = setup({ list: async () => { throw new Error('boom'); } });
  await c.actions.init();
  assert.equal(c.state().config.ai, true);
  assert.equal(c.ctx().error, 'boom');
  assert.equal(c.state().profile.name, 'Julian');
});

test('uploadFile sends the file with its kind, shows it as busy meanwhile, then refreshes the list', async () => {
  let release;
  const c = setup({ uploadFile: () => new Promise((r) => { release = () => r({}); }) });
  await c.actions.init();
  const up = c.actions.uploadFile(file('oferta.pdf'), { kind: 'job' });
  assert.deepEqual(c.ctx().busy, { name: 'oferta.pdf', slow: true });
  release();
  assert.equal(await up, true);
  assert.equal(c.ctx().busy, null);
  assert.equal(c.ctx().error, null);
});

test('plain text uploads are not flagged as slow', async () => {
  let release;
  const c = setup({ uploadFile: () => new Promise((r) => { release = () => r({}); }) });
  await c.actions.init();
  const up = c.actions.uploadFile(file('notas.txt'));
  assert.equal(c.ctx().busy.slow, false);
  release();
  await up;
});

test('files over the limit are refused before sending, with the audio equivalences', async () => {
  const c = setup();
  await c.actions.init();
  assert.equal(await c.actions.uploadFile(file('grande.wav', 20 * 1024 * 1024)), false);
  assert.match(c.ctx().error, /pesa 20\.0 MB y el máximo es 12 MB/);
  assert.match(c.ctx().error, /12 minutos de MP3/);
  assert.equal(c.gateway.calls.some(([n]) => n === 'uploadFile'), false);
});

test('PDF and audio are refused up front when the server has no Gemini key', async () => {
  const c = setup({ config: async () => ({ ...CONFIG, ai: false, capabilities: { pdf: false, audio: false, docx: true, text: true } }) });
  await c.actions.init();
  await c.actions.uploadFile(file('oferta.pdf'));
  assert.match(c.ctx().error, /Los PDF requieren GEMINI_API_KEY/);
  await c.actions.uploadFile(file('charla.mp3'));
  assert.match(c.ctx().error, /Los audios requieren GEMINI_API_KEY/);
  assert.equal(await c.actions.uploadFile(file('cv.docx')), true);
});

test('a server error is shown and the busy flag clears', async () => {
  const c = setup({ uploadFile: async () => { throw Object.assign(new Error('El contenido del archivo no corresponde a un .pdf'), { status: 415 }); } });
  await c.actions.init();
  assert.equal(await c.actions.uploadFile(file('virus.pdf')), false);
  assert.match(c.ctx().error, /no corresponde a un \.pdf/);
  assert.equal(c.ctx().busy, null);
});

test('cancelUpload aborts the request and shows no error', async () => {
  let seenSignal;
  const c = setup({ uploadFile: (f, o, { signal }) => new Promise((_, reject) => { seenSignal = signal; signal.addEventListener('abort', () => reject(signal.reason)); }) });
  await c.actions.init();
  const up = c.actions.uploadFile(file('charla.mp3'));
  c.actions.cancelUpload();
  assert.equal(await up, false);
  assert.equal(seenSignal.aborted, true);
  assert.equal(c.ctx().error, null);
  assert.equal(c.ctx().busy, null);
});

test('addText, update and remove go through the gateway and refresh the list; errors are shown', async () => {
  const c = setup();
  await c.actions.init();
  assert.equal(await c.actions.addText({ name: 'Notas', kind: 'notes', text: 'hola' }), true);
  assert.equal(await c.actions.update('c_1', { active: false }), true);
  assert.equal(await c.actions.remove('c_1'), true);
  assert.deepEqual(c.gateway.calls.map(([n]) => n).filter((n) => ['addText', 'update', 'remove'].includes(n)), ['addText', 'update', 'remove']);
  const bad = setup({ remove: async () => { throw new Error('No existe el elemento'); } });
  await bad.actions.init();
  assert.equal(await bad.actions.remove('zzz'), false);
  assert.equal(bad.ctx().error, 'No existe el elemento');
});

test('saveProfile updates the profile in the store and lets errors propagate to the form', async () => {
  const c = setup();
  await c.actions.init();
  await c.actions.saveProfile({ name: 'Nuevo' });
  assert.equal(c.state().profile.name, 'Nuevo');
  const bad = setup({ saveProfile: async () => { throw new Error('El resumen excede 2000 caracteres'); } });
  await assert.rejects(bad.actions.saveProfile({}), /excede 2000/);
});
