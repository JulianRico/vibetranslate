const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVocabulary, formatVocabulary } = require('../vocabulary');

test('cada línea «cómo se oye = cómo se escribe» es una entrada; lo demás se ignora', () => {
  assert.deepEqual(parseVocabulary('Andrews = Andrés\n\nproyecto fénix=Proyecto Phoenix\nsin igual\n = vacío\nalgo = \r\nSPX = SPFx'), {
    andrews: 'Andrés', 'proyecto fénix': 'Proyecto Phoenix', spx: 'SPFx'
  });
  assert.deepEqual(parseVocabulary(''), {});
  assert.deepEqual(parseVocabulary(undefined), {});
});

test('el glosario guardado se muestra igual que se escribe, y vuelve a leerse igual', () => {
  const glossary = { andrews: 'Andrés', 'proyecto fénix': 'Proyecto Phoenix' };
  assert.equal(formatVocabulary(glossary), 'andrews = Andrés\nproyecto fénix = Proyecto Phoenix');
  assert.deepEqual(parseVocabulary(formatVocabulary(glossary)), glossary);
  assert.equal(formatVocabulary(undefined), '');
});
