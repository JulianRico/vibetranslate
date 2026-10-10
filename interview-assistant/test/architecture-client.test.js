import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findViolations, findGlobals } from './support/arch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DOMAIN = path.join(PUBLIC, 'domain');
const APPLICATION = path.join(PUBLIC, 'application');
const ADAPTERS = path.join(PUBLIC, 'adapters');
const UI = path.join(PUBLIC, 'ui');

// Browser-only globals: they may only appear in adapters/ (Chrome APIs, timers, network) and ui/ (DOM).
const BROWSER_GLOBALS = [
  'document', 'window', 'navigator', 'fetch', 'localStorage', 'sessionStorage',
  'SpeechRecognition', 'webkitSpeechRecognition', 'Translator', 'LanguageModel', 'setTimeout', 'clearTimeout',
];

test('public/domain imports only from public/domain and touches no browser global', () => {
  assert.deepEqual(findViolations(DOMAIN, [DOMAIN]), []);
  assert.deepEqual(findGlobals(DOMAIN, BROWSER_GLOBALS), []);
});

test('public/application imports only domain and application and touches no browser global', () => {
  assert.deepEqual(findViolations(APPLICATION, [DOMAIN, APPLICATION]), []);
  assert.deepEqual(findGlobals(APPLICATION, BROWSER_GLOBALS), []);
});

test('public/adapters import only domain, application and adapters', () => {
  assert.deepEqual(findViolations(ADAPTERS, [DOMAIN, APPLICATION, ADAPTERS]), []);
});

test('public/ui imports only domain, application and ui (never an adapter, so it cannot reach the network or Chrome APIs)', () => {
  assert.deepEqual(findViolations(UI, [DOMAIN, APPLICATION, UI]), []);
  assert.deepEqual(findGlobals(UI, ['fetch', 'localStorage', 'sessionStorage', 'SpeechRecognition', 'webkitSpeechRecognition', 'Translator', 'LanguageModel']), []);
});

test('nothing in public/ imports from outside public/', () => {
  assert.deepEqual(findViolations(PUBLIC, [PUBLIC]), []);
});
