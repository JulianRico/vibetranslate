const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../local-ai/engine');
const { thresholdFromNoiseGate } = require('../local-ai/segmenter');

const seg = (ms) => ({ samples: new Float32Array(ms * 16) });

/** Motor con dobles: `queue` son los lotes de segmentos que devolverá cada push; `texts` lo que "oye" el modelo. */
function setup({ queue = [], texts = [], speaking = [] } = {}) {
  const posted = [];
  const calls = [];
  const engine = createEngine({
    sherpa: {},
    paths: {},
    post: (m) => posted.push(m),
    makeSegmenter: () => ({
      push: () => queue.shift() || [],
      flush: () => queue.shift() || [],
      isSpeaking: () => (speaking.length ? speaking.shift() : false)
    }),
    makeTranscriber: () => ({
      transcribe: (samples, lang) => { calls.push(['transcribe', samples.length, lang]); return { text: texts.shift() ?? '', ms: 5 }; },
      translate: (samples, source, target) => { calls.push(['translate', samples.length, source, target]); return { text: 'translated', ms: 7 }; }
    })
  });
  const audio = (stream = 'mic', lang = 'es') => engine.handle({ type: 'audio', stream, lang, samples: new Float32Array(2048) });
  return { engine, posted, calls, audio };
}

test('un segmento de voz se transcribe y se publica con su duración e identificador', () => {
  const t = setup({ queue: [[seg(1500)]], texts: ['Hola a todos.'] });
  t.audio('mic', 'es');
  assert.deepEqual(t.posted, [{ type: 'segment', id: 1, stream: 'mic', lang: 'es', text: 'Hola a todos.', durationMs: 1500, sttMs: 5 }]);
  assert.deepEqual(t.calls, [['transcribe', 24000, 'es']]);
});

test('un segmento de menos de 400 ms se descarta sin llamar al modelo (tos, clic)', () => {
  const t = setup({ queue: [[seg(399)]], texts: ['sí'] });
  t.audio();
  assert.deepEqual(t.posted, []);
  assert.deepEqual(t.calls, []);
});

test('el texto vacío o de solo signos no se publica', () => {
  const t = setup({ queue: [[seg(800), seg(800), seg(800)]], texts: ['', ' ... ', '¿?'] });
  t.audio();
  assert.deepEqual(t.posted, []);
});

test('frases cortas reales como «Gracias.» sí se publican', () => {
  const t = setup({ queue: [[seg(600)]], texts: ['Gracias.'] });
  t.audio();
  assert.equal(t.posted[0].text, 'Gracias.');
});

test('el cambio de estado de voz se avisa una sola vez por cambio', () => {
  const t = setup({ speaking: [true, true, false] });
  t.audio(); t.audio(); t.audio();
  assert.deepEqual(t.posted, [{ type: 'vad', stream: 'mic', speaking: true }, { type: 'vad', stream: 'mic', speaking: false }]);
});

test('micrófono y receptor tienen segmentadores independientes', () => {
  const t = setup({ queue: [[seg(900)], [seg(700)]], texts: ['uno', 'two'] });
  t.audio('mic', 'es');
  t.audio('incoming', 'en');
  assert.deepEqual(t.posted.map((m) => [m.stream, m.lang, m.text]), [['mic', 'es', 'uno'], ['incoming', 'en', 'two']]);
});

test('translate usa el audio guardado del segmento y su idioma de origen', () => {
  const t = setup({ queue: [[seg(1000)]], texts: ['Hola.'] });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'translate', id: 1, target: 'en' });
  assert.deepEqual(t.calls[1], ['translate', 16000, 'es', 'en']);
  assert.deepEqual(t.posted[1], { type: 'translation', id: 1, text: 'translated', ms: 7 });
});

test('translate de un segmento desconocido o ya caducado responde con error', () => {
  const batch = Array.from({ length: 9 }, () => seg(500));
  const t = setup({ queue: [batch], texts: batch.map((_, i) => `frase ${i}`) });
  t.audio();
  t.engine.handle({ type: 'translate', id: 1, target: 'en' });
  t.engine.handle({ type: 'translate', id: 99, target: 'en' });
  const answers = t.posted.filter((m) => m.type === 'translation');
  assert.deepEqual(answers, [
    { type: 'translation', id: 1, error: 'El audio de esa frase ya no está disponible' },
    { type: 'translation', id: 99, error: 'El audio de esa frase ya no está disponible' }
  ]);
  t.engine.handle({ type: 'translate', id: 9, target: 'en' });
  assert.equal(t.posted[t.posted.length - 1].text, 'translated');
});

test('flush publica lo que quedaba a medias', () => {
  const t = setup({ queue: [[], [seg(900)]], texts: ['última frase'] });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'flush', stream: 'mic', lang: 'es' });
  assert.equal(t.posted[0].text, 'última frase');
});

test('thresholdFromNoiseGate traduce el selector de sensibilidad al umbral de Silero', () => {
  assert.equal(thresholdFromNoiseGate('0.008'), 0.35);
  assert.equal(thresholdFromNoiseGate('0.016'), 0.5);
  assert.equal(thresholdFromNoiseGate('0.030'), 0.6);
  assert.equal(thresholdFromNoiseGate('0.055'), 0.75);
  assert.equal(thresholdFromNoiseGate(undefined), 0.5);
});

test('los identificadores empiezan en la base indicada, para no repetirse entre reinicios del proceso', () => {
  const posted = [];
  const engine = createEngine({
    sherpa: {}, paths: {}, post: (m) => posted.push(m), idBase: 2000001,
    makeSegmenter: () => ({ push: () => [seg(900)], flush: () => [], isSpeaking: () => false }),
    makeTranscriber: () => ({ transcribe: () => ({ text: 'Hola.', ms: 1 }), translate: () => ({ text: 'Hi.', ms: 1 }) })
  });
  engine.handle({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048) });
  assert.equal(posted[0].id, 2000001);
});

/** Motor cuyos segmentadores se pueden inspeccionar: cuántos se crearon, con qué umbral y qué devuelve cada flush. */
function inspectable({ vadThreshold } = {}) {
  const posted = [];
  const created = [];
  const engine = createEngine({
    sherpa: {}, paths: {}, post: (m) => posted.push(m), vadThreshold,
    makeSegmenter: ({ threshold }) => {
      const segmenter = { threshold, flushed: 0, push: () => [], flush: () => { segmenter.flushed++; return [seg(700)]; }, isSpeaking: () => false };
      created.push(segmenter);
      return segmenter;
    },
    makeTranscriber: () => ({ transcribe: (samples, lang) => ({ text: `frase en ${lang}`, ms: 1 }), translate: () => ({ text: 't', ms: 1 }) })
  });
  const audio = (stream, lang) => engine.handle({ type: 'audio', stream, lang, samples: new Float32Array(2048) });
  return { engine, posted, created, audio };
}

test('flush sin indicar flujo cierra la frase en curso de todos, cada uno en su idioma', () => {
  const t = inspectable();
  t.audio('mic', 'es');
  t.audio('incoming', 'en');
  t.engine.handle({ type: 'flush' });
  assert.deepEqual(t.posted.map((m) => [m.stream, m.text]), [['mic', 'frase en es'], ['incoming', 'frase en en']]);
});

test('flush de un flujo que no ha recibido audio no hace nada', () => {
  const t = inspectable();
  t.engine.handle({ type: 'flush', stream: 'mic' });
  assert.deepEqual(t.posted, []);
  assert.equal(t.created.length, 0);
});

test('tras un flush el flujo empieza limpio: el audio siguiente no se pega a la frase cerrada', () => {
  const t = inspectable();
  t.audio('mic', 'es');
  t.engine.handle({ type: 'flush', stream: 'mic' });
  t.audio('mic', 'es');
  assert.equal(t.created.length, 2);
});

test('la sensibilidad del micrófono no se aplica al audio del receptor', () => {
  const t = inspectable({ vadThreshold: 0.75 });
  t.audio('mic', 'es');
  t.audio('incoming', 'en');
  assert.deepEqual(t.created.map((s) => s.threshold), [0.75, 0.5]);
});

test('config cambia la sensibilidad en plena sesión, cerrando antes la frase en curso', () => {
  const t = inspectable({ vadThreshold: 0.5 });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'config', stream: 'mic', vadThreshold: 0.35 });
  assert.equal(t.created[0].flushed, 1);
  assert.equal(t.posted.filter((m) => m.type === 'segment').length, 1);
  t.audio('mic', 'es');
  assert.deepEqual(t.created.map((s) => s.threshold), [0.5, 0.35]);
});
