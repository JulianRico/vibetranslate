import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, initialState } from '../../public/application/store.js';
import { createPreparedActions } from '../../public/application/prepared-actions.js';

const item = (id, status) => ({ id, question: `Question ${id}`, triggers: [id], answer: status === 'empty' ? null : { en: 'a', es: 'b' }, points: [], status });

/** Fake PreparedGatewayPort over an in-memory list; `generateImpl(id, opts)` can fail or wait. */
function setup({ items = [], generateImpl } = {}) {
  let list = items.map((i) => ({ ...i }));
  const calls = [];
  const gateway = {
    calls,
    list: async () => ({ items: list.map((i) => ({ ...i })) }),
    add: async (body) => { calls.push(['add', body]); list.push(item(`n${list.length}`, 'empty')); return {}; },
    update: async (id, patch) => { calls.push(['update', id, patch]); return {}; },
    remove: async (id) => { calls.push(['remove', id]); list = list.filter((i) => i.id !== id); return null; },
    generate: async (id, opts = {}) => {
      calls.push(['generate', id, opts.force === true]);
      if (generateImpl) await generateImpl(id, opts);
      list = list.map((i) => (i.id === id ? { ...i, status: 'generated' } : i));
      return {};
    },
  };
  const store = createStore(initialState());
  store.update((s) => ({ ...s, prepared: { ...s.prepared, items: list.map((i) => ({ ...i })) } })); // as after the page loaded the list
  const actions = createPreparedActions({ gateway, store });
  return { gateway, store, actions, calls, state: () => store.getState().prepared };
}

test('load puts the items in the store; a failure is shown as an error', async () => {
  const ok = setup({ items: [item('a', 'template')] });
  await ok.actions.load();
  assert.deepEqual(ok.state().items.map((i) => i.id), ['a']);
  const bad = setup();
  bad.gateway.list = async () => { throw new Error('servidor caído'); };
  await bad.actions.load();
  assert.equal(bad.state().error, 'servidor caído');
});

test('add, update and remove go through the gateway and reload the list; errors are shown and return false', async () => {
  const t = setup({ items: [item('a', 'template')] });
  assert.equal(await t.actions.add({ question: 'New one', triggers: ['new'] }), true);
  assert.equal(t.state().items.length, 2);
  assert.equal(await t.actions.update('a', { answer: { en: 'x', es: 'y' } }), true);
  assert.equal(await t.actions.remove('a'), true);
  assert.deepEqual(t.calls.map((c) => c[0]), ['add', 'update', 'remove']);
  t.gateway.update = async () => { throw Object.assign(new Error('La respuesta necesita texto en inglés y en español'), { status: 400 }); };
  assert.equal(await t.actions.update('n1', { answer: { en: 'only' } }), false);
  assert.match(t.state().error, /inglés y en español/);
});

test('generate marks the item busy meanwhile, passes force, reloads, and clears busy even on failure', async () => {
  let release;
  const t = setup({ items: [item('a', 'template')], generateImpl: () => new Promise((r) => { release = r; }) });
  const pending = t.actions.generate('a', { force: true });
  assert.equal(t.state().busy, 'a');
  release();
  assert.equal(await pending, true);
  assert.deepEqual([t.state().busy, t.state().items[0].status, t.calls.at(-1)], [null, 'generated', ['generate', 'a', true]]);
  const failing = setup({ items: [item('b', 'template')], generateImpl: async () => { throw new Error('Gemini HTTP 503: busy'); } });
  assert.equal(await failing.actions.generate('b'), false);
  assert.deepEqual([failing.state().busy, failing.state().error], [null, 'Gemini HTTP 503: busy']);
});

test('generateMissing processes only templates and empty questions, in order, never edited or generated ones', async () => {
  const t = setup({ items: [item('a', 'template'), item('b', 'edited'), item('c', 'empty'), item('d', 'generated'), item('e', 'template')] });
  const result = await t.actions.generateMissing();
  assert.deepEqual(result, { done: 3, failed: 0 });
  assert.deepEqual(t.calls.filter((c) => c[0] === 'generate').map((c) => c[1]), ['a', 'c', 'e']);
  assert.deepEqual([t.state().busy, t.state().progress], [null, null]);
  assert.deepEqual(t.state().items.map((i) => i.status), ['generated', 'edited', 'generated', 'generated', 'generated']);
});

test('generateMissing reports progress after each question', async () => {
  const seen = [];
  let t;
  t = setup({
    items: [item('a', 'template'), item('b', 'template')],
    generateImpl: async () => { seen.push({ ...t.state().progress }); },
  });
  await t.actions.generateMissing();
  assert.deepEqual(seen, [{ done: 0, total: 2 }, { done: 1, total: 2 }]);
});

test('generateMissing keeps going after a failure and says how many failed', async () => {
  const t = setup({
    items: [item('a', 'template'), item('b', 'template'), item('c', 'template')],
    generateImpl: async (id) => { if (id === 'b') throw Object.assign(new Error('Gemini HTTP 502'), { status: 502 }); },
  });
  const result = await t.actions.generateMissing();
  assert.deepEqual(result, { done: 3, failed: 1 });
  assert.match(t.state().error, /1 no se pudieron generar: Gemini HTTP 502/);
  assert.equal(t.calls.filter((c) => c[0] === 'generate').length, 3);
});

test('generateMissing stops at once when the server has no Gemini key (503)', async () => {
  const t = setup({
    items: [item('a', 'template'), item('b', 'template'), item('c', 'template')],
    generateImpl: async () => { throw Object.assign(new Error('Falta GEMINI_API_KEY en el servidor'), { status: 503 }); },
  });
  const result = await t.actions.generateMissing();
  assert.equal(result.failed, 1);
  assert.equal(t.calls.filter((c) => c[0] === 'generate').length, 1, 'no point in trying the rest');
  assert.match(t.state().error, /GEMINI_API_KEY/);
});

test('cancelGeneration stops the bulk run after the current question', async () => {
  let t;
  t = setup({
    items: [item('a', 'template'), item('b', 'template'), item('c', 'template')],
    generateImpl: async (id) => { if (id === 'a') t.actions.cancelGeneration(); },
  });
  const result = await t.actions.generateMissing();
  assert.equal(t.calls.filter((c) => c[0] === 'generate').length, 1);
  assert.equal(result.done, 1);
  assert.deepEqual([t.state().busy, t.state().progress], [null, null]);
});

test('generateMissing with nothing pending does nothing', async () => {
  const t = setup({ items: [item('a', 'edited'), item('b', 'generated')] });
  assert.deepEqual(await t.actions.generateMissing(), { done: 0, failed: 0 });
  assert.equal(t.calls.length, 0);
});
