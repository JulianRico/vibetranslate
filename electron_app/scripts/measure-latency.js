/**
 * measure-latency.js - Mide el motor local sobre los audios de prueba y lo compara con la línea base en la nube
 */

const path = require('path');
const { createModelStore } = require('../local-ai/model-store');
const { createEngine } = require('../local-ai/engine');
const { readWav } = require('../test/support/wav');
const phrases = require('../test/fixtures/phrases.json');

const VAD_HANGOVER_MS = 350; // silencio que espera Silero antes de cerrar la frase
const BASELINE = { stt: [370, 890], translate: [100, 1234] }; // de logs/desktop_app.log (sección 3 del spec)

const store = createModelStore({ dir: process.env.VIBE_MODELS_DIR || path.join(__dirname, '..', '.models') });
if (!store.status().ready) {
  console.error('Faltan los modelos: ejecuta "npm run models".');
  process.exit(1);
}

const posted = [];
const loadStart = Date.now();
const engine = createEngine({ sherpa: require('sherpa-onnx-node'), paths: store.paths(), post: (m) => posted.push(m) });
const loadMs = Date.now() - loadStart;

const rows = [];
for (const [lang, target] of [['es', 'en'], ['en', 'es']]) {
  phrases[lang].forEach((p, i) => {
    const samples = readWav(path.join(__dirname, '..', 'test', 'fixtures', 'audio', `${p.id}.wav`));
    const padded = new Float32Array(samples.length + 16000);
    padded.set(samples);
    const from = posted.length;
    const stream = `${lang}-${i}`;
    for (let k = 0; k < padded.length; k += 2048) engine.handle({ type: 'audio', stream, lang, samples: padded.slice(k, k + 2048) });
    engine.handle({ type: 'flush', stream, lang });
    const segments = posted.slice(from).filter((m) => m.type === 'segment');
    let translateMs = 0;
    for (const s of segments) {
      engine.handle({ type: 'translate', id: s.id, target });
      translateMs += posted[posted.length - 1].ms;
    }
    const sttMs = segments.reduce((n, s) => n + s.sttMs, 0);
    rows.push({ id: p.id, audioMs: Math.round(samples.length / 16), segments: segments.length, sttMs, translateMs });
  });
}

const avg = (key) => Math.round(rows.reduce((n, r) => n + r[key], 0) / rows.length);
console.log(`Carga del motor: ${loadMs} ms (una vez por sesión)`);
console.table(rows);
console.log(`Media por frase: transcripción ${avg('sttMs')} ms, traducción local ${avg('translateMs')} ms`);
console.log(`Fin de voz ➔ texto en pantalla (local): ~${VAD_HANGOVER_MS + avg('sttMs')} ms`);
console.log(`Fin de voz ➔ traducción local en pantalla: ~${VAD_HANGOVER_MS + avg('sttMs') + avg('translateMs')} ms`);
console.log(`Línea base en la nube: transcripción ${BASELINE.stt[0]}–${BASELINE.stt[1]} ms, traducción ${BASELINE.translate[0]}–${BASELINE.translate[1]} ms, más la espera del bloqueo que elimina la cola de salida.`);
