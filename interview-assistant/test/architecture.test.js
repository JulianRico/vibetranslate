import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findViolations } from './support/arch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DOMAIN = path.join(SRC, 'domain');
const APPLICATION = path.join(SRC, 'application');

test('src/domain imports only from src/domain (no node: modules, no packages)', () => {
  assert.deepEqual(findViolations(DOMAIN, [DOMAIN]), []);
});

test('src/application imports only from src/domain and src/application', () => {
  assert.deepEqual(findViolations(APPLICATION, [DOMAIN, APPLICATION]), []);
});

test('nothing in src/ imports from outside the interview-assistant folder', () => {
  assert.deepEqual(findViolations(SRC, [ROOT], { allowBare: true }), []);
});

test('the checker detects a layer violation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const domain = path.join(tmp, 'domain');
  fs.mkdirSync(domain);
  fs.writeFileSync(path.join(domain, 'bad.js'), "import fs from 'node:fs';\nimport { x } from '../infrastructure/x.js';\n");
  const bad = findViolations(domain, [domain]);
  assert.equal(bad.length, 2);
});
