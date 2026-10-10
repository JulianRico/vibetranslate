const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTraceRecorder, stats } = require('../local-ai/trace-recorder');
const { readWav } = require('./support/wav');

function setup() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-trace-'));
  const clock = { now: new Date(2026, 9, 10, 14, 30, 5).getTime() };
  const recorder = createTraceRecorder({ baseDir, now: () => clock.now });
  const lines = (dir) => fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { recorder, baseDir, clock, lines };
}

/** Una frase completa: oída, traducida y mostrada. */
function phrase(t, { id, stream = 'mic', durationMs = 3000, sttMs = 500, translateMs = 400, endToEndMs = 1200, engine = 'local', text = 'Hola.', translated = 'Hello.', error = null }) {
  t.recorder.record('segment', { id, stream, lang: stream === 'mic' ? 'es' : 'en', text, durationMs, sttMs });
  t.recorder.record('translation', { segmentId: id, stream, engine, translateMs, endToEndMs, original: text, translated, error });
}

test('stats resume una lista de tiempos: cuántos, media, mediana, percentil 95 y máximo', () => {
  assert.deepEqual(stats([100, 200, 300, 400, 1000]), { n: 5, avg: 400, p50: 300, p95: 1000, max: 1000 });
  assert.deepEqual(stats([]), { n: 0, avg: 0, p50: 0, p95: 0, max: 0 });
});

test('sin sesión activa no se graba nada', () => {
  const t = setup();
  t.recorder.record('segment', { id: 1 });
  assert.equal(t.recorder.isActive(), false);
  assert.equal(t.recorder.saveAudio({ id: 1, stream: 'mic', samples: new Float32Array(16000) }), null);
  assert.equal(t.recorder.stop(), null);
  assert.deepEqual(fs.readdirSync(t.baseDir), []);
});

test('cada evento se escribe al momento como una línea con el tiempo transcurrido', () => {
  const t = setup();
  const { dir } = t.recorder.start({ meta: { sttEngine: 'local' } });
  assert.equal(path.basename(dir), 'sesion-20261010-143005');
  t.clock.now += 1500;
  t.recorder.record('segment', { id: 7, stream: 'mic', text: 'Hola.', durationMs: 2000, sttMs: 450 });
  const events = t.lines(dir); // legible aunque la app se cierre sin terminar la sesión
  assert.equal(events[0].type, 'session-start');
  assert.deepEqual(events[0].meta, { sttEngine: 'local' });
  assert.equal(events[1].t, 1500);
  assert.equal(events[1].type, 'segment');
  assert.equal(events[1].text, 'Hola.');
});

test('el audio de cada frase se guarda como WAV de 16 kHz con un nombre que la identifica', () => {
  const t = setup();
  const { dir } = t.recorder.start({ saveAudio: true });
  const samples = new Float32Array(16000).map((_, i) => 0.25 * Math.sin(i / 10));
  const name = t.recorder.saveAudio({ id: 1000003, stream: 'incoming', samples });
  assert.equal(name, 'audio/001-incoming-1000003.wav');
  const back = readWav(path.join(dir, name));
  assert.equal(back.length, 16000);
  assert.ok(Math.abs(back[100] - samples[100]) < 1e-3);
});

test('con el guardado de audio desactivado no se escribe ningún WAV', () => {
  const t = setup();
  const { dir } = t.recorder.start({ saveAudio: false });
  assert.equal(t.recorder.savesAudio(), false);
  assert.equal(t.recorder.saveAudio({ id: 1, stream: 'mic', samples: new Float32Array(16000) }), null);
  assert.equal(fs.existsSync(path.join(dir, 'audio')), false);
});

test('al terminar se calcula el resumen por micrófono y por reunión', () => {
  const t = setup();
  t.recorder.start({ meta: { sttEngine: 'local' } });
  phrase(t, { id: 1, durationMs: 2000, sttMs: 400, translateMs: 300, endToEndMs: 1000 });
  phrase(t, { id: 2, durationMs: 4000, sttMs: 600, translateMs: 500, endToEndMs: 1400, engine: 'google' });
  phrase(t, { id: 3, stream: 'incoming', durationMs: 3000, sttMs: 900, translateMs: 0, endToEndMs: 0, engine: 'none', translated: '', error: 'Traducción local vacía' });
  t.recorder.record('error', { message: 'El motor local se cerró y se está reiniciando.' });
  t.clock.now += 60000;
  const { summary } = t.recorder.stop();

  assert.equal(summary.durationMs, 60000);
  assert.equal(summary.streams.mic.phrases, 2);
  assert.equal(summary.streams.mic.audioMs, 6000);
  assert.deepEqual(summary.streams.mic.stt, { n: 2, avg: 500, p50: 400, p95: 600, max: 600 });
  assert.equal(summary.streams.mic.realTimeFactor, 0.17); // 1000 ms de transcripción para 6000 ms de voz
  assert.deepEqual(summary.streams.mic.engines, { local: 1, google: 1 });
  assert.equal(summary.streams.mic.endToEnd.avg, 1200);
  assert.equal(summary.streams.incoming.phrases, 1);
  assert.equal(summary.streams.incoming.untranslated, 1);
  assert.equal(summary.streams.incoming.endToEnd.n, 0, 'una frase sin traducir no cuenta en la latencia');
  assert.equal(summary.errors, 1);
});

test('marcar un problema señala la última frase oída, con la nota del usuario', () => {
  const t = setup();
  const { dir } = t.recorder.start();
  phrase(t, { id: 1, text: 'Buenos días.' });
  phrase(t, { id: 2, text: 'Necesitamos revisar el presupuesto.' });
  const flagged = t.recorder.flag('tradujo mal presupuesto');
  assert.deepEqual(flagged, { segmentId: 2, stream: 'mic', text: 'Necesitamos revisar el presupuesto.', note: 'tradujo mal presupuesto' });
  const { summary } = t.recorder.stop();
  assert.deepEqual(summary.flags, [flagged]);
  assert.ok(t.lines(dir).some((e) => e.type === 'flag' && e.segmentId === 2));
});

test('marcar sin que se haya oído ninguna frase no falla y lo deja anotado', () => {
  const t = setup();
  t.recorder.start();
  assert.deepEqual(t.recorder.flag('no oyó nada'), { segmentId: null, stream: null, text: '', note: 'no oyó nada' });
});

test('al terminar quedan el resumen en JSON y un informe legible con las frases, las lentas y las marcadas', () => {
  const t = setup();
  const { dir } = t.recorder.start({ meta: { sttEngine: 'local', sourceLang: 'es-ES', targetLang: 'en' } });
  phrase(t, { id: 1, text: 'Buenos días a todos.', translated: 'Good morning everyone.', sttMs: 400 });
  phrase(t, { id: 2, text: 'Una frase lenta.', translated: 'A slow phrase.', sttMs: 2500, durationMs: 2000 });
  t.recorder.flag('llegó tarde');
  const result = t.recorder.stop();

  assert.deepEqual(fs.readdirSync(dir).sort(), ['informe.md', 'resumen.json', 'trace.jsonl']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'resumen.json'), 'utf8')), result.summary);
  const report = fs.readFileSync(path.join(dir, 'informe.md'), 'utf8');
  assert.equal(report, result.report);
  assert.match(report, /Buenos días a todos\./);
  assert.match(report, /Good morning everyone\./);
  assert.match(report, /llegó tarde/);
  assert.match(report, /más lento que el habla/i); // 2500 ms para 2000 ms de voz
  assert.equal(t.recorder.isActive(), false);
});

test('iniciar una sesión con otra en curso cierra la anterior con su informe', () => {
  const t = setup();
  const first = t.recorder.start();
  t.clock.now += 5000;
  const second = t.recorder.start();
  assert.notEqual(first.dir, second.dir);
  assert.ok(fs.existsSync(path.join(first.dir, 'informe.md')));
});
