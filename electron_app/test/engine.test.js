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
  assert.deepEqual(t.posted, [{ type: 'segment', id: 1, stream: 'mic', lang: 'es', text: 'Hola a todos.', durationMs: 1500, sttMs: 5, gapMs: null }]);
  // frase corta del micrófono: una pasada de traducción desde el audio comprueba que no sea ruido
  assert.deepEqual(t.calls, [['transcribe', 24000, 'es'], ['translate', 24000, 'es', 'en']]);
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

test('sin traductor de texto, translate usa el audio guardado de la frase y su idioma de origen', () => {
  const t = setup({ queue: [[seg(1000)]], texts: ['Hola.'] });
  t.audio('mic', 'es');
  t.engine.handle({ type: 'translate', id: 50, segmentId: 1, target: 'en' });
  assert.deepEqual(t.calls[1], ['translate', 16000, 'es', 'en']);
  assert.deepEqual(t.posted[1], { type: 'translation', id: 50, text: 'translated', ms: 7 });
});

test('translate de una frase desconocida o ya caducada responde con error', () => {
  const batch = Array.from({ length: 9 }, () => seg(500));
  const t = setup({ queue: [batch], texts: batch.map((_, i) => `frase ${i}`) });
  t.audio();
  t.engine.handle({ type: 'translate', id: 1, segmentId: 1, target: 'en' });
  t.engine.handle({ type: 'translate', id: 2, segmentId: 99, target: 'en' });
  const answers = t.posted.filter((m) => m.type === 'translation');
  assert.deepEqual(answers, [
    { type: 'translation', id: 1, error: 'El audio de esa frase ya no está disponible' },
    { type: 'translation', id: 2, error: 'El audio de esa frase ya no está disponible' }
  ]);
  t.engine.handle({ type: 'translate', id: 3, segmentId: 9, target: 'en' });
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

/** Motor con dobles configurables para traducción, eco y texto provisional. */
function advanced({ segments = [], peeks = [], speaking = true, heard = null, probes = null, translator = undefined, echo = () => ({ echo: false, score: 0 }), clock = { now: 5000 } } = {}) {
  const posted = [];
  const calls = [];
  const observed = [];
  const fakeTranslator = translator === undefined
    ? { translateMany: (texts, from, to) => { calls.push(['mt', texts, from, to]); return texts.map((x) => `${to}:${x}`); } }
    : translator;
  const engine = createEngine({
    sherpa: {}, paths: {}, post: (m) => posted.push(m), now: () => clock.now, translator: fakeTranslator,
    makeSegmenter: () => ({
      push: () => segments.shift() || [],
      flush: () => [],
      isSpeaking: () => speaking,
      position: () => 100000,
      peek: () => (peeks.length ? peeks.shift() : null)
    }),
    makeTranscriber: () => ({
      transcribe: (samples, lang) => { calls.push('transcribe'); return { text: heard ? heard.shift() : `oído en ${lang} con muchas palabras`, ms: 300 }; },
      translate: (samples, source, target) => { calls.push('translate'); return { text: probes ? probes.shift() : `directo a ${target}`, ms: 400 }; }
    }),
    makeEchoDetector: () => ({ observeReference: (samples, at) => observed.push(at), check: echo })
  });
  const audio = (extra = {}) => engine.handle({ type: 'audio', stream: 'incoming', lang: 'en', samples: new Float32Array(2048), at: clock.now, ...extra });
  const mic = (extra = {}) => engine.handle({ type: 'audio', stream: 'mic', lang: 'es', samples: new Float32Array(2048), at: clock.now, ...extra });
  const segmentsOut = () => posted.filter((m) => m.type === 'segment');
  return { engine, posted, calls, observed, audio, mic, clock, segmentsOut };
}
const start = (ms, at = 50000) => ({ samples: new Float32Array(ms * 16), start: at });

test('con destino indicado, Canary transcribe una sola vez y el traductor de texto traduce', () => {
  const t = advanced({ segments: [[start(3000)]] });
  t.audio({ target: 'es' });
  assert.deepEqual(t.calls, ['transcribe', ['mt', ['oído en en con muchas palabras'], 'en', 'es']]);
  assert.deepEqual(t.segmentsOut(), [{
    type: 'segment', id: 1, stream: 'incoming', lang: 'en', text: 'oído en en con muchas palabras', durationMs: 3000, sttMs: 300, gapMs: null,
    target: 'es', translated: 'es:oído en en con muchas palabras', translateMs: 0
  }]);
});

test('sin destino (traducción en la nube) solo se transcribe', () => {
  const t = advanced({ segments: [[start(3000)]] });
  t.audio();
  assert.deepEqual(t.calls, ['transcribe']);
  assert.equal(t.segmentsOut()[0].translated, undefined);
});

test('los trozos de una misma frase se unen y la frase entera se traduce junto al trozo nuevo', () => {
  // 1 s de voz desde la muestra 50000; el siguiente trozo empieza 160 ms (2560 muestras) después
  const t = advanced({
    segments: [[start(1000, 50000)], [start(2000, 50000 + 16000 + 2560)]],
    heard: ["Of course, we don't know what's going to.", 'happen in a year.']
  });
  t.audio({ target: 'es' });
  t.audio({ target: 'es' });
  const [first, second] = t.segmentsOut();
  assert.equal(first.join, undefined);
  assert.equal(second.gapMs, 160);
  assert.deepEqual(second.join, {
    lineId: first.id,
    text: "Of course, we don't know what's going to happen in a year.",
    translated: "es:Of course, we don't know what's going to happen in a year."
  });
  assert.equal(second.translated, 'es:happen in a year.', 'el trozo solo, para la voz');
  // una sola llamada al traductor para los dos textos
  assert.deepEqual(t.calls.filter((c) => c[0] === 'mt')[1], ['mt', ['happen in a year.', "Of course, we don't know what's going to happen in a year."], 'en', 'es']);
});

test('tras una pausa larga el trozo siguiente es otra frase aunque la anterior no terminara', () => {
  const t = advanced({
    segments: [[start(1000, 50000)], [start(1000, 50000 + 16000 + 16000 * 3)]],
    heard: ['vamos a revisar un poco esa', 'esa tendencia.']
  });
  t.audio({ target: 'es', lang: 'es' });
  t.audio({ target: 'es', lang: 'es' });
  assert.equal(t.segmentsOut()[1].join, undefined);
  assert.equal(t.segmentsOut()[1].gapMs, 3000);
});

test('sin traductor de texto la frase se traduce desde el audio y la frase unida queda sin traducir', () => {
  const t = advanced({
    translator: null,
    segments: [[start(1000, 50000)], [start(1000, 50000 + 16000 + 1600)]],
    heard: ['This is the latest job posting for an', 'AI researcher.']
  });
  t.audio({ target: 'es' });
  t.audio({ target: 'es' });
  const second = t.segmentsOut()[1];
  assert.equal(second.translated, 'directo a es');
  assert.deepEqual(second.join, { lineId: t.segmentsOut()[0].id, text: 'This is the latest job posting for an AI researcher.' });
});

test('si el traductor falla se avisa y la frase cae a la traducción desde el audio', () => {
  const t = advanced({ segments: [[start(3000)]], translator: { translateMany: () => { throw new Error('No hay modelo de traducción local para en → es'); } } });
  t.audio({ target: 'es' });
  const out = t.segmentsOut()[0];
  assert.equal(out.text, 'oído en en con muchas palabras');
  assert.equal(out.translated, 'directo a es');
  assert.ok(t.posted.some((m) => m.type === 'error' && /en → es/.test(m.message) && m.fatal === false));
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
  assert.equal(t.segmentsOut().length, 1);
});

test('ruido del micrófono que el modelo oye como palabras sueltas se descarta (sesiones reales)', () => {
  // Lo que Canary devolvió en las sesiones de prueba para ruido, y su traducción directa desde el audio
  const cases = [['Que', '1.1.1.1.1.1.1.1.1.1'], ['Mm.', '1'], ['sí.', '1.1.1.1.1.1.1.1.1.1.1.1.'], ['Kfi.', '1000000000000000000000'], ['Eco.', 'E E E E E E E E'], ['Ahí es', '1.1.1.1.1.1.1.1.1.1.1.1.1.']];
  for (const [heard, probe] of cases) {
    const t = advanced({ segments: [[start(800)]], heard: [heard], probes: [probe] });
    t.mic({ target: 'en' });
    assert.deepEqual(t.segmentsOut(), [], `"${heard}" no debe publicarse`);
    assert.deepEqual(t.posted.filter((m) => m.type === 'noise').map((m) => m.text), [heard]);
  }
});

test('las acotaciones y letras sueltas no se publican en ningún flujo, sin gastar otra pasada', () => {
  for (const heard of ['(Tecológica)', '(mucha?', 'E C H O N G I L']) {
    const t = advanced({ segments: [[start(2000)]], heard: [heard] });
    t.audio({ target: 'es' });
    assert.deepEqual(t.segmentsOut(), [], heard);
    assert.deepEqual(t.calls, ['transcribe']);
  }
});

test('frases cortas reales del micrófono pasan la comprobación; las largas ni la necesitan', () => {
  const t = advanced({ segments: [[start(900)]], heard: ['Entendieron'], probes: ['understood'] });
  t.mic({ target: 'en' });
  assert.equal(t.segmentsOut()[0].translated, 'en:Entendieron');

  const long = advanced({ segments: [[start(3000)]], heard: ['vamos a revisar todos los temas de hoy'] });
  long.mic({ target: 'en' });
  assert.ok(!long.calls.includes('translate'), 'más de 3 palabras: sin pasada extra');
});

test('frases cortas de la reunión no se comprueban: «Usually.» o «Tokenizers.» son reales y no deben esperar', () => {
  const t = advanced({ segments: [[start(700)]], heard: ['Usually.'], probes: ['1'] });
  t.audio({ target: 'es' });
  assert.equal(t.segmentsOut()[0].text, 'Usually.');
  assert.ok(!t.calls.includes('translate'));
});

test('mientras se sigue hablando se publica texto provisional cada 1,5 s de audio nuevo, ya traducido', () => {
  const sizes = [1000, 1600, 2000, 3200, 3300].map((ms) => new Float32Array(ms * 16));
  const t = advanced({ peeks: sizes });
  for (let i = 0; i < 5; i++) t.audio({ target: 'es', partial: true });
  const partials = t.posted.filter((m) => m.type === 'partial');
  assert.deepEqual(partials.map((p) => p.durationMs), [1600, 3200]); // 1000 es poco; 2000 y 3300 no suman 1,5 s nuevos
  assert.deepEqual(partials[0], {
    type: 'partial', stream: 'incoming', lang: 'en', text: 'es:oído en en con muchas palabras', heard: 'oído en en con muchas palabras',
    translated: true, durationMs: 1600, ms: 300
  });
});

test('sin destino el texto provisional es lo oído', () => {
  const t = advanced({ peeks: [new Float32Array(32000)] });
  t.audio({ partial: true });
  const partial = t.posted.find((m) => m.type === 'partial');
  assert.equal(partial.translated, false);
  assert.equal(partial.text, 'oído en en con muchas palabras');
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

test('sin traductor de texto, una traducción directa que es un invento no se publica como subtítulo', () => {
  for (const junk of ['(en inglés)', '- No.', '10000000000000000000000000', '(apa)', '(Música)', '1', '1.1.2.2.2.2.2.2.2.2.2', '0 0 0 0', 'E E E E E E']) {
    const t = advanced({ translator: null, segments: [[start(2000)]], probes: [junk] });
    t.audio({ target: 'es' });
    const out = t.segmentsOut();
    assert.equal(out.length, 1);
    assert.equal(out[0].translated, undefined, `"${junk}" no debe mostrarse`);
    assert.equal(out[0].text, 'oído en en con muchas palabras'); // queda lo que se oyó, para que la interfaz decida
  }
  for (const fine of ['No.', 'No, gracias.', 'Son 15.', 'Sí (creo).', '15', '2026', '1.5 millones']) {
    const t = advanced({ translator: null, segments: [[start(2000)]], probes: [fine] });
    t.audio({ target: 'es' });
    assert.equal(t.segmentsOut()[0].translated, fine);
  }
});

test('con traductor, translate traduce el texto pedido sin necesitar el audio', () => {
  const t = advanced();
  t.engine.handle({ type: 'translate', id: 7, text: 'Hola a todos.', source: 'es', target: 'en' });
  assert.deepEqual(t.posted[t.posted.length - 1], { type: 'translation', id: 7, text: 'en:Hola a todos.', ms: 0 });
  assert.ok(!t.calls.includes('translate'), 'sin pasada de Canary');
});

test('sin traductor, pedir la traducción de una frase cuyo resultado es un invento devuelve error, no el invento', () => {
  const t = advanced({ translator: null, segments: [[start(2000)]], probes: ['(en inglés)'] });
  t.audio(); // sin destino: se transcribe y la interfaz pide la traducción después
  const segmentId = t.segmentsOut()[0].id;
  t.engine.handle({ type: 'translate', id: 1, segmentId, text: 'oído', target: 'es' });
  const answer = t.posted[t.posted.length - 1];
  assert.equal(answer.type, 'translation');
  assert.match(answer.error, /no fiable/);
  assert.equal(answer.text, undefined);
});
