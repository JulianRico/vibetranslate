const test = require('node:test');
const assert = require('node:assert/strict');
const { createSentenceJoiner, continues, joinText } = require('../local-ai/sentence-joiner');

test('trozos reales de las sesiones de prueba que sí son la misma frase', () => {
  const pairs = [
    ['en', "Of course, we don't know what's going to.", 'happen in a year, super intelligence, whatever.'],
    ['en', 'AI researcher job has dramatically changed in just a few months, so this is the latest up to date.', "course that you're going to need if you want to become AI researcher."],
    ['en', 'Join our school community where we simulate real AI research lab. You will be either setting your own research goals or', 'Using ours, answering our questions.'],
    ['en', 'This is what distinguishes experience, good researcher.', 'versus novel, not inexperienced.'],
    ['en', 'This is the latest job posting for an', 'AI researcher.'],
    ['en', 'But to make,', 'going to make each asky character.'],
    ['es', 'vamos a revisar un poco esa', 'esa tendencia que está al alza.'],
    ['es', 'vamos a hacer una revisión de los temas.', 'que estamos tratando.'],
    ['es', 'vamos a revisar todos los temas involucrados en esta sesión de día de hoy y continuaremos', 'con todo lo que sea necesario.'],
    ['es', 'Hola, hoy vamos a hablar en esta reunión de varios temas.', 'que estamos tocando en el día a día.'],
    ['es', 'Necesito que me envíes el informe de la.', 'Semana pasada.']
  ];
  for (const [lang, a, b] of pairs) assert.ok(continues(a, b, lang), `"${a}" + "${b}"`);
});

test('frases completas seguidas de otra que empieza en mayúscula no se unen', () => {
  const pairs = [
    ['en', 'We have some text like this.', 'They would split.'],
    ['en', 'Tokenizers.', 'We have some text like this.'],
    ['en', 'Can you hear me?', 'Yes, perfectly.'],
    ['en', 'I think so.', 'Let me check.'],
    ['es', 'Eh, este viernes, okay.', 'Vamos a revisar los temas.'],
    ['es', '¿Me escuchan bien?', 'Perfecto, empecemos.'],
    ['es', 'Hola a todos.', 'Hoy hablamos del presupuesto.']
  ];
  for (const [lang, a, b] of pairs) assert.equal(continues(a, b, lang), false, `"${a}" + "${b}"`);
});

test('al unir se quita el punto que el modelo puso al cortar, pero no los puntos suspensivos', () => {
  assert.equal(joinText("Of course, we don't know what's going to.", 'happen in a year.'), "Of course, we don't know what's going to happen in a year.");
  assert.equal(joinText('vamos a revisar un poco esa', 'esa tendencia.'), 'vamos a revisar un poco esa esa tendencia.');
  assert.equal(joinText('So,', 'should you reward it?'), 'So, should you reward it?');
  assert.equal(joinText('Bueno...', 'como decía.'), 'Bueno... como decía.');
});

test('el joiner devuelve la frase acumulada y el identificador de su primera línea', () => {
  const j = createSentenceJoiner();
  assert.deepEqual(j.add({ stream: 'incoming', id: 1, lang: 'en', text: "Of course, we don't know what's going to.", gapMs: null }),
    { joined: false, lineId: 1, text: "Of course, we don't know what's going to." });
  assert.deepEqual(j.add({ stream: 'incoming', id: 2, lang: 'en', text: 'happen in a year, whatever, then AI will do everything. So,', gapMs: 120 }),
    { joined: true, lineId: 1, text: "Of course, we don't know what's going to happen in a year, whatever, then AI will do everything. So," });
  // sigue sin punto final: el tercer trozo también se une
  assert.equal(j.add({ stream: 'incoming', id: 3, lang: 'en', text: 'we focus on questions.', gapMs: 300 }).lineId, 1);
  // frase cerrada y la nueva empieza en mayúscula: línea nueva
  assert.deepEqual(j.add({ stream: 'incoming', id: 4, lang: 'en', text: 'Here are some examples.', gapMs: 300 }),
    { joined: false, lineId: 4, text: 'Here are some examples.' });
});

test('una pausa larga separa las frases aunque la anterior no terminara', () => {
  const j = createSentenceJoiner();
  j.add({ stream: 'mic', id: 1, lang: 'es', text: 'vamos a revisar un poco esa', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 2, lang: 'es', text: 'esa tendencia.', gapMs: 4000 }).joined, false);
});

test('sin saber la pausa (motores en la nube) no se une nada', () => {
  const j = createSentenceJoiner();
  j.add({ stream: 'mic', id: 1, lang: 'es', text: 'vamos a revisar un poco esa' });
  assert.equal(j.add({ stream: 'mic', id: 2, lang: 'es', text: 'esa tendencia.' }).joined, false);
});

test('cada flujo lleva su frase: el micrófono no se une con la reunión', () => {
  const j = createSentenceJoiner();
  j.add({ stream: 'incoming', id: 1, lang: 'en', text: 'This is the latest job posting for an', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 2, lang: 'es', text: 'que estamos tratando.', gapMs: 100 }).joined, false);
  assert.equal(j.add({ stream: 'incoming', id: 3, lang: 'en', text: 'AI researcher.', gapMs: 100 }).lineId, 1);
});

test('no crece sin límite: a partir de 4 trozos o 60 palabras empieza línea nueva', () => {
  const j = createSentenceJoiner();
  for (let i = 1; i <= 4; i++) assert.equal(j.add({ stream: 'incoming', id: i, lang: 'en', text: 'and then', gapMs: 100 }).lineId, 1);
  assert.equal(j.add({ stream: 'incoming', id: 5, lang: 'en', text: 'and then', gapMs: 100 }).lineId, 5);

  const long = createSentenceJoiner();
  long.add({ stream: 'incoming', id: 1, lang: 'en', text: Array(50).fill('word').join(' '), gapMs: null });
  assert.equal(long.add({ stream: 'incoming', id: 2, lang: 'en', text: Array(15).fill('more').join(' '), gapMs: 100 }).joined, false);
});

test('un cambio de idioma o un reset empiezan línea nueva', () => {
  const j = createSentenceJoiner();
  j.add({ stream: 'mic', id: 1, lang: 'es', text: 'vamos a revisar la', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 2, lang: 'en', text: 'review of the topics.', gapMs: 100 }).joined, false);
  j.reset('mic');
  assert.equal(j.add({ stream: 'mic', id: 3, lang: 'en', text: 'and more', gapMs: 100 }).joined, false);
});

test('tras un punto, la minúscula solo une si la pausa es corta; una frase sin cerrar admite más pausa', () => {
  assert.equal(continues('vamos a hacer una revisión de los temas.', 'que estamos tratando.', 'es'), 'weak');
  assert.equal(continues("we don't know what's going to.", 'happen in a year.', 'en'), 'strong', 'palabra que no cierra frase');
  assert.equal(continues('vamos a revisar un poco esa', 'esa tendencia.', 'es'), 'strong');

  const j = createSentenceJoiner();
  j.add({ stream: 'mic', id: 1, lang: 'es', text: 'vamos a hacer una revisión de los temas.', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 2, lang: 'es', text: 'que estamos tratando.', gapMs: 500 }).joined, true);
  // sesión real: «…con todo lo que sea necesario.» y, 1,35 s después, otra frase en minúscula
  j.add({ stream: 'mic', id: 3, lang: 'es', text: 'continuaremos con todo lo que sea necesario.', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 4, lang: 'es', text: 'eh siguiente tu vas tú, Daniel', gapMs: 1100 }).joined, false);
  // sin punto final, la misma pausa sí une
  j.add({ stream: 'mic', id: 5, lang: 'es', text: 'que hay implementamos el celerio para', gapMs: null });
  assert.equal(j.add({ stream: 'mic', id: 6, lang: 'es', text: 'para evitar es que', gapMs: 1100 }).joined, true);
});

test('dos personas distintas nunca se unen en una línea, aunque la frase anterior no estuviera cerrada', () => {
  const joiner = createSentenceJoiner();
  joiner.add({ stream: 'incoming', id: 1, lang: 'en', text: 'Solid approach, and a queue as the fallback,', gapMs: null, speaker: 2 });
  const other = joiner.add({ stream: 'incoming', id: 2, lang: 'en', text: 'thank you, Andrea, those were clear answers.', gapMs: 300, speaker: 1 });
  assert.equal(other.joined, false);
  const same = joiner.add({ stream: 'incoming', id: 3, lang: 'en', text: 'and do you have any questions', gapMs: 300, speaker: 1 });
  assert.equal(same.joined, true); // la misma persona sigue en minúscula con pausa corta: misma frase
  // sin saber quién habla (motores en la nube o sin huella), todo sigue como antes
  const unknown = createSentenceJoiner();
  unknown.add({ stream: 'incoming', id: 1, lang: 'en', text: 'and a queue as the fallback,', gapMs: null });
  assert.equal(unknown.add({ stream: 'incoming', id: 2, lang: 'en', text: 'thank you, Andrea.', gapMs: 300 }).joined, true);
});
