const test = require('node:test');
const assert = require('node:assert/strict');
const { nameFromIntroduction, createSpeakerNames } = require('../speaker-names');

test('de una presentación sale el nombre de pila', () => {
  assert.equal(nameFromIntroduction("Hi, Andrea, welcome. I'm Sarah Mitchell, the engineering manager."), 'Sarah');
  assert.equal(nameFromIntroduction('Hello, my name is Michael Chen, and I work on the backend.'), 'Michael');
  assert.equal(nameFromIntroduction('This is Emma from the product team.'), 'Emma');
  assert.equal(nameFromIntroduction('Hello Andrea, lovely to meet you, I am Emma Clarke, a Product Manager.'), 'Emma');
});

test('lo que parece una presentación pero no lo es no da nombre', () => {
  for (const text of [
    "I'm sure that works.",
    "I'm Senior Backend Engineer at Northwind.",
    "I'm not convinced.",
    'This is a great example, Andrea.',
    'This is SharePoint Online.',
    "I'm glad you asked.",
    "Thanks, I'm happy with that answer."
  ]) assert.equal(nameFromIntroduction(text), null, text);
});

test('cada voz se llama «Persona N» hasta que se presenta o la renombras, y tu nombre manda', () => {
  const names = createSpeakerNames();
  assert.equal(names.label(2), 'Persona 2');
  names.suggest(2, 'Sarah');
  assert.equal(names.label(2), 'Sarah');
  names.rename(2, 'Sarah M.');
  names.suggest(2, 'Michael'); // una presentación posterior no pisa lo que escribiste
  assert.equal(names.label(2), 'Sarah M.');
  names.rename(2, '   ');
  assert.equal(names.label(2), 'Persona 2');
  names.reset();
  assert.equal(names.label(2), 'Persona 2');
});
