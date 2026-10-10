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

test('con la captura activada cada frase lleva su audio, para guardarlo en la sesión de prueba', () => {
  const posted = [];
  const make = (captureAudio) => createEngine({
    sherpa: {}, paths: {}, post: (m) => posted.push(m), captureAudio,
    makeSegmenter: () => ({ push: () => [seg(900)], flush: () => [], isSpeaking: () => false }),
    makeTranscriber: () => ({ transcribe: () => ({ text: 'Hola.', ms: 1 }), translate: () => ({ text: 'Hi.', ms: 1 }) })
  });
  const audio = { type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048) };

  make(true).handle(audio);
  assert.equal(posted[0].samples.length, 900 * 16);

  const off = make(false);
  off.handle(audio);
  assert.equal(posted[1].samples, undefined, 'sin sesión de prueba el audio no viaja entre procesos');

  off.handle({ type: 'capture', enabled: true }); // se puede activar con el motor en marcha
  off.handle(audio);
  assert.equal(posted[2].samples.length, 900 * 16);
});

/** Motor con dobles configurables para las mejoras de latencia y eco. */
function advanced({ segments = [], peeks = [], speaking = true, translations = null, echo = () => ({ echo: false, score: 0 }), clock = { now: 5000 } } = {}) {
  const posted = [];
  const calls = [];
  const observed = [];
  const engine = createEngine({
    sherpa: {}, paths: {}, post: (m) => posted.push(m), now: () => clock.now,
    makeSegmenter: () => ({
      push: () => segments.shift() || [],
      flush: () => [],
      isSpeaking: () => speaking,
      position: () => 100000,
      peek: () => (peeks.length ? peeks.shift() : null)
    }),
    makeTranscriber: () => ({
      transcribe: (samples, lang) => { calls.push('transcribe'); return { text: `oído en ${lang}`, ms: 300 }; },
      translate: (samples, source, target) => { calls.push('translate'); return { text: translations ? translations.shift() : `traducido a ${target}`, ms: 400 }; }
    }),
    makeEchoDetector: () => ({ observeReference: (samples, at) => observed.push(at), check: echo })
  });
  const audio = (extra = {}) => engine.handle({ type: 'audio', stream: 'incoming', lang: 'en', samples: new Float32Array(2048), at: clock.now, ...extra });
  return { engine, posted, calls, observed, audio, clock };
}
const start = (ms) => ({ samples: new Float32Array(ms * 16), start: 50000 });

test('con destino indicado la frase se traduce primero: el subtítulo no espera a la transcripción', () => {
  const t = advanced({ segments: [[start(3000)]] });
  t.audio({ target: 'es' });
  assert.deepEqual(t.calls, ['translate', 'transcribe']);
  assert.deepEqual(t.posted.filter((m) => m.type !== 'vad'), [
    { type: 'segment', id: 1, stream: 'incoming', lang: 'en', target: 'es', text: '', durationMs: 3000, sttMs: 0, translated: 'traducido a es', translateMs: 400 },
    { type: 'segment-text', id: 1, stream: 'incoming', text: 'oído en en', sttMs: 300 }
  ]);
});

test('si la traducción directa sale vacía se vuelve al camino normal: transcribir y que la interfaz decida', () => {
  const t = advanced({ segments: [[start(3000)]], translations: ['  '] });
  t.audio({ target: 'es' });
  const out = t.posted.filter((m) => m.type !== 'vad');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'oído en en');
  assert.equal(out[0].translated, undefined);
});

test('sin destino (traducción en la nube) solo se transcribe', () => {
  const t = advanced({ segments: [[start(3000)]] });
  t.audio();
  assert.deepEqual(t.calls, ['transcribe']);
});

test('una frase del micrófono que es eco de la reunión se descarta y se avisa', () => {
  const checks = [];
  const t = advanced({ segments: [[start(1000)]], echo: (samples, startAt) => { checks.push(startAt); return { echo: true, score: 0.9 }; } });
  t.engine.handle({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048), at: 60000 });
  assert.deepEqual(t.posted.filter((m) => m.type !== 'vad'), [{ type: 'echo', stream: 'mic', durationMs: 1000, score: 0.9 }]);
  assert.deepEqual(t.calls, [], 'el eco no se transcribe ni se traduce');
  // la frase empezó (100000 - 50000) muestras antes del final del último trozo: 3125 ms antes
  assert.deepEqual(checks, [60000 - 3125]);
});

test('el audio de la reunión alimenta al detector de eco; el del micrófono no', () => {
  const t = advanced();
  t.audio({ at: 7000 });
  t.engine.handle({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048), at: 7100 });
  assert.deepEqual(t.observed, [7000]);
});

test('las frases de la reunión nunca se tratan como eco', () => {
  const t = advanced({ segments: [[start(1000)]], echo: () => ({ echo: true, score: 1 }) });
  t.audio();
  assert.equal(t.posted.filter((m) => m.type === 'segment').length, 1);
});

test('mientras se sigue hablando se publica texto provisional cada 1,5 s de audio nuevo', () => {
  const sizes = [1000, 1600, 2000, 3200, 3300].map((ms) => new Float32Array(ms * 16));
  const t = advanced({ peeks: sizes });
  for (let i = 0; i < 5; i++) t.audio({ target: 'es', partial: true });
  const partials = t.posted.filter((m) => m.type === 'partial');
  assert.deepEqual(partials.map((p) => p.durationMs), [1600, 3200]); // 1000 es poco; 2000 y 3300 no suman 1,5 s nuevos
  assert.deepEqual(partials[0], { type: 'partial', stream: 'incoming', lang: 'en', text: 'traducido a es', translated: true, durationMs: 1600, ms: 400 });
});

test('si el motor va con retraso no gasta tiempo en texto provisional', () => {
  const t = advanced({ peeks: [new Float32Array(32000)] });
  t.clock.now = 9000;
  t.audio({ target: 'es', partial: true, at: 8000 }); // este audio se capturó hace 1 s: hay cola
  assert.deepEqual(t.posted.filter((m) => m.type === 'partial'), []);
});

test('sin pedirlo no hay texto provisional, y al cerrar una frase la cuenta vuelve a empezar', () => {
  const quiet = advanced({ peeks: [new Float32Array(32000)] });
  quiet.audio({ target: 'es' });
  assert.deepEqual(quiet.posted.filter((m) => m.type === 'partial'), []);

  const t = advanced({ segments: [[], [start(3000)], []], peeks: [new Float32Array(32000), new Float32Array(32000)] });
  t.audio({ target: 'es', partial: true }); // provisional de la primera frase
  t.audio({ target: 'es', partial: true }); // la frase se cierra
  t.audio({ target: 'es', partial: true }); // provisional de la siguiente, sin esperar a "1,5 s más que antes"
  assert.equal(t.posted.filter((m) => m.type === 'partial').length, 2);
});

test('una traducción directa que es claramente un invento del modelo no se publica como subtítulo', () => {
  for (const junk of ['(en inglés)', '- No.', '10000000000000000000000000', '(apa)', '(Música)']) {
    const t = advanced({ segments: [[start(2000)]], translations: [junk] });
    t.audio({ target: 'es' });
    const out = t.posted.filter((m) => m.type === 'segment');
    assert.equal(out.length, 1);
    assert.equal(out[0].translated, undefined, `"${junk}" no debe mostrarse`);
    assert.equal(out[0].text, 'oído en en'); // queda lo que se oyó, para que la interfaz decida
  }
});

test('una traducción corta legítima sí se publica', () => {
  for (const fine of ['No.', 'No, gracias.', 'Son 15.', 'Sí (creo).']) {
    const t = advanced({ segments: [[start(2000)]], translations: [fine] });
    t.audio({ target: 'es' });
    assert.equal(t.posted.filter((m) => m.type === 'segment')[0].translated, fine);
  }
});

test('pedir la traducción de una frase cuyo resultado es un invento devuelve error, no el invento', () => {
  const t = advanced({ segments: [[start(2000)]], translations: ['(en inglés)'] });
  t.audio(); // sin destino: se transcribe y la interfaz pide la traducción después
  const id = t.posted.find((m) => m.type === 'segment').id;
  t.engine.handle({ type: 'translate', id, target: 'es' });
  const answer = t.posted[t.posted.length - 1];
  assert.equal(answer.type, 'translation');
  assert.match(answer.error, /no fiable/);
  assert.equal(answer.text, undefined);
});
