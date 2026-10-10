const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationLog } = require('../conversation-log');

const fixedClock = () => '10:15:02';

test('cada frase queda registrada con quién habló, los idiomas y un número de orden', () => {
  const log = createConversationLog({ clock: fixedClock });
  const mine = log.add({ direction: 'outgoing', from: 'es', to: 'en', original: 'Hola a todos.', translated: 'Hello everyone.' });
  const theirs = log.add({ direction: 'incoming', from: 'en', to: 'es', original: 'Thanks for joining.', translated: 'Gracias por unirse.' });
  assert.deepEqual(mine, { n: 1, time: '10:15:02', direction: 'outgoing', speaker: 'Tú', from: 'ES', to: 'EN', original: 'Hola a todos.', translated: 'Hello everyone.' });
  assert.equal(theirs.n, 2);
  assert.equal(theirs.speaker, 'Reunión');
  assert.equal(log.size(), 2);
});

test('tail devuelve las últimas frases en orden, para la ventana de subtítulos', () => {
  const log = createConversationLog({ clock: fixedClock });
  for (const word of ['uno', 'dos', 'tres', 'cuatro']) log.add({ direction: 'incoming', from: 'en', to: 'es', original: word, translated: word });
  assert.deepEqual(log.tail(3).map((e) => e.original), ['dos', 'tres', 'cuatro']);
  assert.deepEqual(log.tail(10).map((e) => e.n), [1, 2, 3, 4]);
});

test('una reunión larga no crece sin límite: se descartan las frases más antiguas pero la numeración sigue', () => {
  const log = createConversationLog({ max: 3, clock: fixedClock });
  for (let i = 1; i <= 5; i++) log.add({ direction: 'incoming', from: 'en', to: 'es', original: `frase ${i}`, translated: `t ${i}` });
  assert.deepEqual(log.entries().map((e) => e.n), [3, 4, 5]);
  assert.equal(log.size(), 3);
});

test('una frase sin traducción no se registra', () => {
  const log = createConversationLog({ clock: fixedClock });
  assert.equal(log.add({ direction: 'incoming', from: 'en', to: 'es', original: 'Hello', translated: '  ' }), null);
  assert.equal(log.size(), 0);
});

test('toText exporta la conversación completa, las dos direcciones, legible', () => {
  const log = createConversationLog({ clock: fixedClock });
  log.add({ direction: 'outgoing', from: 'es', to: 'en', original: 'Hola.', translated: 'Hello.' });
  log.add({ direction: 'incoming', from: 'en', to: 'es', original: 'Hi there.', translated: 'Hola.' });
  assert.equal(log.toText(), [
    '[10:15:02] Tú [ES ➔ EN]',
    '  Original:   Hola.',
    '  Traducción: Hello.',
    '',
    '[10:15:02] Reunión [EN ➔ ES]',
    '  Original:   Hi there.',
    '  Traducción: Hola.'
  ].join('\n'));
  assert.equal(createConversationLog().toText(), '');
});

test('clear vacía el historial y reinicia la numeración', () => {
  const log = createConversationLog({ clock: fixedClock });
  log.add({ direction: 'outgoing', from: 'es', to: 'en', original: 'a', translated: 'b' });
  log.clear();
  assert.equal(log.size(), 0);
  assert.equal(log.add({ direction: 'outgoing', from: 'es', to: 'en', original: 'c', translated: 'd' }).n, 1);
});
