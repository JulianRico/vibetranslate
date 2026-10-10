import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGetProfile, createSaveProfile, createGetConfig } from '../../src/application/use-cases/profile-and-config.js';
import { ValidationError } from '../../src/domain/errors.js';
import { createMemoryProfileRepository, createFakeLlm } from '../support/fakes.js';

test('saveProfile normalizes and persists; getProfile reads it back', async () => {
  const profileRepo = createMemoryProfileRepository();
  const save = createSaveProfile({ profileRepo });
  const get = createGetProfile({ profileRepo });
  const saved = await save({ name: '  Julian ', skills: ['.NET', ''] });
  assert.equal(saved.name, 'Julian');
  assert.deepEqual((await get()).skills, ['.NET']);
});

test('saveProfile rejects oversize input and keeps the previous profile', async () => {
  const profileRepo = createMemoryProfileRepository();
  const save = createSaveProfile({ profileRepo });
  await save({ name: 'Antes' });
  await assert.rejects(save({ summary: 'x'.repeat(5000) }), ValidationError);
  assert.equal((await profileRepo.load()).name, 'Antes');
});

test('config with a Gemini key enables PDF and audio', async () => {
  const cfg = await createGetConfig({ llm: createFakeLlm({ configured: true, model: 'gemini-2.5-flash' }), version: '0.1.0' })();
  assert.equal(cfg.ai, true);
  assert.equal(cfg.model, 'gemini-2.5-flash');
  assert.deepEqual(cfg.capabilities, { pdf: true, audio: true, docx: true, text: true });
  assert.deepEqual(cfg.limits, { maxUploadBytes: 12582912, maxItems: 20, maxActiveChars: 30000 });
  assert.equal(cfg.version, '0.1.0');
});

test('config without a key disables PDF and audio but keeps DOCX and text', async () => {
  const cfg = await createGetConfig({ llm: createFakeLlm({ configured: false }), version: '0.1.0' })();
  assert.equal(cfg.ai, false);
  assert.equal(cfg.model, null);
  assert.deepEqual(cfg.capabilities, { pdf: false, audio: false, docx: true, text: true });
});
