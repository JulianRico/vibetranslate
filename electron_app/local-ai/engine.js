/**
 * engine.js - Motor local: tramas ➔ segmentos de voz ➔ texto. No depende de Electron.
 */

const { createSegmenter } = require('./segmenter');
const { createTranscriber } = require('./transcriber');

const MIN_SEGMENT_SAMPLES = 6400; // 400 ms: por debajo el modelo inventa palabras
const KEEP_SEGMENTS = 8; // audio que se conserva para poder traducir en local después
const HAS_WORDS = /[\p{L}\p{N}]/u;
const DEFAULT_THRESHOLD = 0.5;

function createEngine({ sherpa, paths, post, vadThreshold = 0.5, idBase = 1, makeSegmenter = createSegmenter, makeTranscriber = createTranscriber }) {
  const transcriber = makeTranscriber({ sherpa, paths });
  const streams = new Map();
  const kept = new Map();
  let nextId = idBase;

  const thresholds = { mic: vadThreshold }; // la sensibilidad que elige el usuario es la de su micrófono

  function streamFor(name, lang) {
    if (!streams.has(name)) {
      streams.set(name, {
        segmenter: makeSegmenter({ sherpa, modelPath: paths.vad, threshold: thresholds[name] ?? DEFAULT_THRESHOLD }),
        speaking: false,
        lang
      });
    }
    const state = streams.get(name);
    if (lang) state.lang = lang;
    return state;
  }

  function publish(stream, lang, segments) {
    for (const segment of segments) {
      if (segment.samples.length < MIN_SEGMENT_SAMPLES) continue;
      const { text, ms } = transcriber.transcribe(segment.samples, lang);
      if (!text || !HAS_WORDS.test(text)) continue;
      const id = nextId++;
      kept.set(id, { samples: segment.samples, lang });
      if (kept.size > KEEP_SEGMENTS) kept.delete(kept.keys().next().value);
      post({ type: 'segment', id, stream, lang, text, durationMs: Math.round(segment.samples.length / 16), sttMs: ms });
    }
  }

  /** Cierra la frase en curso de un flujo y lo deja limpio: el audio siguiente no se pega a lo ya cerrado. */
  function close(name) {
    const state = streams.get(name);
    if (!state) return;
    streams.delete(name);
    if (state.speaking) post({ type: 'vad', stream: name, speaking: false });
    publish(name, state.lang, state.segmenter.flush());
  }

  return {
    handle(msg) {
      if (msg.type === 'audio') {
        const state = streamFor(msg.stream, msg.lang);
        const segments = state.segmenter.push(msg.samples);
        const speaking = state.segmenter.isSpeaking();
        if (speaking !== state.speaking) {
          state.speaking = speaking;
          post({ type: 'vad', stream: msg.stream, speaking });
        }
        publish(msg.stream, msg.lang, segments);
      } else if (msg.type === 'flush') {
        const names = msg.stream ? [msg.stream] : [...streams.keys()];
        for (const name of names) close(name);
      } else if (msg.type === 'config') {
        close(msg.stream);
        thresholds[msg.stream] = msg.vadThreshold;
      } else if (msg.type === 'translate') {
        const segment = kept.get(msg.id);
        if (!segment) {
          post({ type: 'translation', id: msg.id, error: 'El audio de esa frase ya no está disponible' });
          return;
        }
        const { text, ms } = transcriber.translate(segment.samples, segment.lang, msg.target);
        post({ type: 'translation', id: msg.id, text, ms });
      } else if (msg.type === 'reset') {
        streams.clear();
        kept.clear();
      }
    }
  };
}

module.exports = { createEngine, MIN_SEGMENT_SAMPLES };
