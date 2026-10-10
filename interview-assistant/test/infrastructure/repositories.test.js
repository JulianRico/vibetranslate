import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileContextRepository } from '../../src/infrastructure/file-context-repository.js';
import { createFileProfileRepository } from '../../src/infrastructure/file-profile-repository.js';
import { profileFromCvAgent } from '../../src/infrastructure/cv-agent-profile.js';
import { loadEnv } from '../../src/infrastructure/env.js';
import { createIdGenerator, createClock } from '../../src/infrastructure/system.js';
import { createLock } from '../../src/infrastructure/json-file.js';
import { createContextItem } from '../../src/domain/context-item.js';
import { emptyProfile } from '../../src/domain/profile.js';
import { ValidationError } from '../../src/domain/errors.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ia-repo-'));
const item = (id) => createContextItem({ id, name: `${id}.txt`, kind: 'notes', source: 'text', text: `texto ${id}`, now: 'T0' });

test('context repo: add, get, list, update, remove', async () => {
  const repo = createFileContextRepository({ dir: tmp() });
  assert.deepEqual(await repo.list(), []);
  await repo.add(item('c_1'));
  await repo.add(item('c_2'));
  assert.deepEqual((await repo.list()).map((i) => i.id), ['c_1', 'c_2']);
  assert.equal((await repo.get('c_2')).text, 'texto c_2');
  assert.equal(await repo.get('nope'), null);
  assert.equal((await repo.update('c_1', { active: false })).active, false);
  assert.equal((await repo.get('c_1')).active, false);
  assert.equal(await repo.update('nope', { active: false }), null);
  assert.equal(await repo.remove('c_1'), true);
  assert.equal(await repo.remove('c_1'), false);
  assert.deepEqual((await repo.list()).map((i) => i.id), ['c_2']);
});

test('context repo persists across instances', async () => {
  const dir = tmp();
  await createFileContextRepository({ dir }).add(item('c_1'));
  assert.equal((await createFileContextRepository({ dir }).list()).length, 1);
});

test('context repo survives a corrupt or wrong-shaped index file', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.json'), '{ this is not json');
  const repo = createFileContextRepository({ dir });
  assert.deepEqual(await repo.list(), []);
  await repo.add(item('c_1'));
  assert.equal((await repo.list()).length, 1);
  fs.writeFileSync(path.join(dir, 'index.json'), '{"not":"an array"}');
  assert.deepEqual(await repo.list(), []);
});

test('context repo: concurrent adds are all kept (writes are serialized)', async () => {
  const repo = createFileContextRepository({ dir: tmp() });
  await Promise.all(Array.from({ length: 25 }, (_, i) => repo.add(item(`c_${i}`))));
  assert.equal((await repo.list()).length, 25);
});

test('lock runs tasks in order and keeps going after a failure', async () => {
  const lock = createLock();
  const order = [];
  const a = lock(async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a'); });
  const b = lock(async () => { order.push('b'); throw new Error('boom'); });
  const c = lock(async () => { order.push('c'); });
  await a;
  await assert.rejects(b, /boom/);
  await c;
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('profile repo: empty when nothing exists, then saves and reloads', async () => {
  const repo = createFileProfileRepository({ dir: tmp() });
  assert.deepEqual(await repo.load(), emptyProfile());
  await repo.save({ name: ' Julian ', skills: ['.NET'] });
  assert.equal((await repo.load()).name, 'Julian');
});

test('profile repo rejects invalid profiles without touching the saved one', async () => {
  const repo = createFileProfileRepository({ dir: tmp() });
  await repo.save({ name: 'Antes' });
  await assert.rejects(repo.save({ summary: 'x'.repeat(5000) }), ValidationError);
  assert.equal((await repo.load()).name, 'Antes');
});

test('profile repo seeds from the CV Agent profile, read-only, until a profile is saved', async () => {
  const dir = tmp();
  const seedFile = path.join(tmp(), 'profile.json');
  fs.writeFileSync(seedFile, JSON.stringify({
    basics: { name: 'Julian Quintero', title: 'Full Stack Lead' }, summary: 'Lead.',
    skills: [{ group: 'Backend', items: ['.NET', 'Azure'] }],
    experience: [{ company: 'Acme', role: 'Lead', start: '2022', end: '2024', bullets: ['Led a team'] }],
  }));
  const before = fs.readFileSync(seedFile, 'utf8');
  const repo = createFileProfileRepository({ dir, seedFile });
  const seeded = await repo.load();
  assert.equal(seeded.headline, 'Full Stack Lead');
  assert.deepEqual(seeded.skills, ['.NET', 'Azure']);
  assert.equal(seeded.experience[0].period, '2022 – 2024');
  assert.equal(fs.readFileSync(seedFile, 'utf8'), before, 'seed file untouched');
  await repo.save({ name: 'Otro' });
  assert.equal((await repo.load()).name, 'Otro');
});

test('profile repo falls back to the seed or empty when profile.json is corrupt', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'profile.json'), 'garbage{');
  assert.deepEqual(await createFileProfileRepository({ dir }).load(), emptyProfile());
});

test('profileFromCvAgent tolerates missing and malformed fields', () => {
  assert.deepEqual(profileFromCvAgent(null).skills, []);
  assert.deepEqual(profileFromCvAgent({ skills: 'x', experience: 5 }).experience, []);
});

test('loadEnv parses KEY=value lines, quotes and comments; missing file is empty', () => {
  const file = path.join(tmp(), '.env');
  fs.writeFileSync(file, '# comment\nGEMINI_API_KEY="abc"\nPORT=3100\n  MODEL = gemini  \nBAD LINE\n');
  assert.deepEqual(loadEnv(file), { GEMINI_API_KEY: 'abc', PORT: '3100', MODEL: 'gemini' });
  assert.deepEqual(loadEnv(path.join(tmp(), 'missing')), {});
});

test('ids are unique and prefixed; the clock returns ISO timestamps', () => {
  const ids = createIdGenerator();
  const a = ids.next();
  assert.match(a, /^c_[0-9a-f]{8}$/);
  assert.notEqual(a, ids.next());
  assert.match(createClock().now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('the id generator can use another prefix', () => {
  const ids = createIdGenerator('p_');
  assert.match(ids.next(), /^p_[0-9a-f]{8}$/);
});
