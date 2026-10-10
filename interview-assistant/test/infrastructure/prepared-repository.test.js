import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFilePreparedRepository } from '../../src/infrastructure/file-prepared-repository.js';
import { createPrepared } from '../../src/domain/prepared.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ia-prepared-'));
const item = (id) => createPrepared({ id, question: `Question ${id}`, triggers: [`trigger ${id}`], now: 'T0' });

test('no file yet: list is null (the use cases seed the starter bank)', async () => {
  assert.equal(await createFilePreparedRepository({ dir: tmp() }).list(), null);
});

test('replaceAll, list, get, add, update and remove', async () => {
  const repo = createFilePreparedRepository({ dir: tmp() });
  await repo.replaceAll([item('a'), item('b')]);
  assert.deepEqual((await repo.list()).map((i) => i.id), ['a', 'b']);
  assert.equal((await repo.get('b')).question, 'Question b');
  assert.equal(await repo.get('nope'), null);
  await repo.add(item('c'));
  const updated = await repo.update('a', { ...item('a'), question: 'Changed' });
  assert.equal(updated.question, 'Changed');
  assert.equal((await repo.get('a')).question, 'Changed');
  assert.equal(await repo.update('nope', item('nope')), null);
  assert.equal(await repo.remove('b'), true);
  assert.equal(await repo.remove('b'), false);
  assert.deepEqual((await repo.list()).map((i) => i.id), ['a', 'c']);
});

test('an empty list is a real, saved state (not "no data")', async () => {
  const repo = createFilePreparedRepository({ dir: tmp() });
  await repo.replaceAll([]);
  assert.deepEqual(await repo.list(), []);
});

test('data persists across repository instances', async () => {
  const dir = tmp();
  await createFilePreparedRepository({ dir }).replaceAll([item('a')]);
  assert.equal((await createFilePreparedRepository({ dir }).list()).length, 1);
});

test('a corrupt file is moved aside (kept for recovery) and treated as "no data"', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'prepared.json'), '{ this is not json');
  const repo = createFilePreparedRepository({ dir });
  assert.equal(await repo.list(), null);
  const moved = fs.readdirSync(dir).filter((f) => f.startsWith('prepared.json.corrupt-'));
  assert.equal(moved.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, moved[0]), 'utf8'), '{ this is not json');
  assert.equal(fs.existsSync(path.join(dir, 'prepared.json')), false);
  await repo.add(item('fresh'));
  assert.equal((await repo.list()).length, 1);
});

test('a file with the wrong shape is also moved aside', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'prepared.json'), '{"not":"an array"}');
  assert.equal(await createFilePreparedRepository({ dir }).list(), null);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.corrupt-')).length, 1);
});

test('concurrent writes are all kept', async () => {
  const repo = createFilePreparedRepository({ dir: tmp() });
  await repo.replaceAll([]);
  await Promise.all(Array.from({ length: 25 }, (_, i) => repo.add(item(`n${i}`))));
  assert.equal((await repo.list()).length, 25);
});

test('a corrupt file that cannot be moved aside is never reported as "no data" (it would be overwritten by the seed)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prepared.json');
  fs.writeFileSync(file, '{ not json');
  fs.mkdirSync(path.join(dir, 'prepared.json.corrupt-123', 'busy'), { recursive: true }); // the rename target cannot be replaced
  const realNow = Date.now;
  Date.now = () => 123;
  try {
    await assert.rejects(createFilePreparedRepository({ dir }).list());
  } finally {
    Date.now = realNow;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', 'the unreadable file is still there for recovery');
});
