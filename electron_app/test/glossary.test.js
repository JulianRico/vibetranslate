const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTechnicalGlossary } = require('../glossary');

test('no toca palabras corrientes en inglés ni en español (antes «real» se volvía «React»)', () => {
  for (const text of [
    'you want to join a real AI research lab',
    'es un problema real',
    'each node in the graph',
    'cada nodo del árbol',
    'Jason will present the results',
    'I nod and move on',
    'la ría de Bilbao'
  ]) {
    assert.equal(applyTechnicalGlossary(text), text);
  }
});

test('corrige las deformaciones fonéticas de términos técnicos', () => {
  assert.equal(applyTechnicalGlossary('vamos a subirlo a cherpoint con doker'), 'vamos a subirlo a SharePoint con Docker');
  assert.equal(applyTechnicalGlossary('el yeison de la res api'), 'el JSON de la REST API');
  assert.equal(applyTechnicalGlossary('usamos taips crip y paiton'), 'usamos TypeScript y Python');
});

test('un reemplazo no se vuelve a reemplazar ni se aplica dentro de otra palabra', () => {
  const glossary = { node: 'NodeJS', js: 'JavaScript' };
  assert.equal(applyTechnicalGlossary('a node app', glossary), 'a NodeJS app');
  assert.equal(applyTechnicalGlossary('nodemon', glossary), 'nodemon');
});

test('respeta las tildes como parte de la palabra', () => {
  assert.equal(applyTechnicalGlossary('pitón', { pit: 'PIT' }), 'pitón');
  assert.equal(applyTechnicalGlossary('el pit de hoy', { pit: 'PIT' }), 'el PIT de hoy');
});

test('el glosario del usuario se suma al de serie y gana si repite una entrada', () => {
  assert.equal(applyTechnicalGlossary('el spfx y el kube', { kube: 'Kubernetes', spfx: 'SPFx Framework' }), 'el SPFx Framework y el Kubernetes');
});

test('texto vacío o glosario vacío no fallan', () => {
  assert.equal(applyTechnicalGlossary(''), '');
  assert.equal(applyTechnicalGlossary('hola', null), 'hola');
});

test('la configuración antigua guardaba el glosario de fábrica entero: al cargar solo queda lo del usuario', () => {
  const { userGlossary, LEGACY_GLOSSARY } = require('../glossary');
  // así está el settings.json real de quien usaba versiones anteriores
  const saved = { ...LEGACY_GLOSSARY, andrews: 'Andrés', real: 'Real Madrid' };
  assert.deepEqual(userGlossary(saved), { andrews: 'Andrés', real: 'Real Madrid' });
  assert.equal(applyTechnicalGlossary('you want to join a real AI research lab', LEGACY_GLOSSARY), 'you want to join a real AI research lab');
  assert.deepEqual(userGlossary(undefined), {});
  assert.deepEqual(userGlossary({ '  ': 'x', vacio: '' }), {});
});
