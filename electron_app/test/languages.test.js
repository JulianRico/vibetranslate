const test = require('node:test');
const assert = require('node:assert/strict');
const { shortCode, otherLanguage, resolvePair } = require('../local-ai/languages');

test('shortCode reduce las variantes regionales y trata lo desconocido como auto', () => {
  assert.equal(shortCode('es-ES'), 'es');
  assert.equal(shortCode('en-US'), 'en');
  assert.equal(shortCode('EN'), 'en');
  assert.equal(shortCode('auto'), 'auto');
  assert.equal(shortCode('fr-FR'), 'auto');
  assert.equal(shortCode(''), 'auto');
  assert.equal(shortCode(undefined), 'auto');
});

test('otherLanguage devuelve el otro idioma del par', () => {
  assert.equal(otherLanguage('es'), 'en');
  assert.equal(otherLanguage('en'), 'es');
});

test('resolvePair usa el destino indicado', () => {
  assert.deepEqual(resolvePair('es-ES', 'en'), { source: 'es', target: 'en' });
  assert.deepEqual(resolvePair('en-US', 'es'), { source: 'en', target: 'es' });
});

test('resolvePair con destino auto o igual al origen elige el otro idioma', () => {
  assert.deepEqual(resolvePair('es-ES', 'auto'), { source: 'es', target: 'en' });
  assert.deepEqual(resolvePair('en-US', 'en'), { source: 'en', target: 'es' });
});

test('resolvePair devuelve null si el origen es auto: el motor local necesita idioma fijo', () => {
  assert.equal(resolvePair('auto', 'en'), null);
  assert.equal(resolvePair(undefined, 'es'), null);
});
