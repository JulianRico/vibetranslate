const test = require('node:test');
const assert = require('node:assert/strict');
const { createSubtitleLines } = require('../subtitle-lines');

const texts = (lines) => [lines.history().map((l) => l.text), lines.current() && lines.current().text];

test('las frases nuevas desplazan a la anterior al historial, que guarda dos', () => {
  const lines = createSubtitleLines();
  for (const [id, text] of [[1, 'uno'], [2, 'dos'], [3, 'tres'], [4, 'cuatro']]) lines.apply({ lineId: id, text });
  assert.deepEqual(texts(lines), [['dos', 'tres'], 'cuatro']);
});

test('un provisional se reemplaza por la frase final sin pasar al historial', () => {
  const lines = createSubtitleLines();
  lines.apply({ lineId: 1, text: 'uno' });
  lines.apply({ text: 'do…', provisional: true });
  lines.apply({ lineId: 2, text: 'dos' });
  assert.deepEqual(texts(lines), [['uno'], 'dos']);
});

test('la traducción mejorada de la nube reescribe su línea esté donde esté', () => {
  const lines = createSubtitleLines();
  lines.apply({ lineId: 1, text: 'Estás rompiendo.' });
  lines.apply({ lineId: 2, text: 'dos' });
  lines.apply({ lineId: 1, replace: true, text: 'Se te corta.' });
  assert.deepEqual(texts(lines), [['Se te corta.'], 'dos']);
  lines.apply({ lineId: 2, replace: true, text: 'Dos.', original: 'Two.' });
  assert.deepEqual(texts(lines), [['Se te corta.'], 'Dos.']);
  assert.equal(lines.current().original, 'Two.');
});

test('el resto de una frase que se mostraba como provisional vuelve a ser la línea actual', () => {
  const lines = createSubtitleLines();
  lines.apply({ lineId: 1, text: 'Por supuesto, no sabemos qué va a hacer.' });
  lines.apply({ text: 'pasar en un año…', provisional: true });
  lines.apply({ lineId: 1, replace: true, grows: true, text: 'Por supuesto, no sabemos qué va a pasar en un año.' });
  assert.deepEqual(texts(lines), [[], 'Por supuesto, no sabemos qué va a pasar en un año.']);
  assert.equal(lines.current().provisional, false);
});

test('una mejora de la nube no borra el provisional de la frase siguiente', () => {
  const lines = createSubtitleLines();
  lines.apply({ lineId: 1, text: 'uno' });
  lines.apply({ text: 'siguiente…', provisional: true });
  lines.apply({ lineId: 1, replace: true, text: 'UNO' });
  assert.deepEqual(texts(lines), [['UNO'], 'siguiente…']);
});

test('reescribir una línea que ya no está la muestra como nueva', () => {
  const lines = createSubtitleLines();
  lines.apply({ lineId: 1, text: 'uno' });
  lines.apply({ lineId: 9, replace: true, text: 'nueve' });
  assert.deepEqual(texts(lines), [['uno'], 'nueve']);
});
