const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutputQueue } = require('../output-queue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ejecuta los trabajos en orden aunque el primero tarde más', async () => {
  const q = createOutputQueue();
  const seen = [];
  q.push(async () => { await sleep(30); seen.push('a'); });
  q.push(async () => { seen.push('b'); });
  await q.push(async () => { seen.push('c'); });
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('push no espera: quien encola sigue de inmediato', async () => {
  const q = createOutputQueue();
  let done = false;
  const p = q.push(async () => { await sleep(40); done = true; });
  assert.equal(done, false);
  assert.equal(q.size(), 1);
  await p;
  assert.equal(done, true);
  assert.equal(q.size(), 0);
});

test('un trabajo que falla no rompe la cola y avisa por onError', async () => {
  const errors = [];
  const q = createOutputQueue({ onError: (e) => errors.push(e.message) });
  const seen = [];
  q.push(async () => { throw new Error('boom'); });
  await q.push(async () => { seen.push('after'); });
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(seen, ['after']);
});

test('cada trabajo recibe cuántos esperan detrás, para poder omitir la voz atrasada', async () => {
  const q = createOutputQueue();
  const backlogs = [];
  q.push(async ({ backlog }) => { await sleep(20); backlogs.push(backlog); });
  q.push(async ({ backlog }) => { backlogs.push(backlog); });
  await q.push(async ({ backlog }) => { backlogs.push(backlog); });
  assert.deepEqual(backlogs, [2, 1, 0]);
});
