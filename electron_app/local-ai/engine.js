/**
 * engine.js - Motor local: tramas ➔ segmentos de voz ➔ texto. No depende de Electron.
 */

const { createSegmenter } = require('./segmenter');
const { createTranscriber } = require('./transcriber');
const { createEchoDetector } = require('./echo-detector');

const MIN_SEGMENT_SAMPLES = 6400; // 400 ms: por debajo el modelo inventa palabras
const KEEP_SEGMENTS = 8; // audio que se conserva para poder traducir en local después
const HAS_WORDS = /[\p{L}\p{N}]/u;
const DEFAULT_THRESHOLD = 0.5;
const PARTIAL_MIN_SAMPLES = 24000; // texto provisional a partir de 1,5 s de frase
const PARTIAL_STEP_SAMPLES = 24000; // y luego cada 1,5 s de audio nuevo
const PARTIAL_MAX_LAG_MS = 600; // si el motor va con más retraso que esto, no hay tiempo para provisionales

/**
 * Salidas típicas del modelo cuando no entiende el audio (música, ruido, voces lejanas): una acotación
 * entre paréntesis, un guion de diálogo con una sola palabra o una ristra de dígitos. Vistas en sesiones reales.
 */
function isInventedTranslation(text) {
  const t = text.trim();
  return /^\(.*\)$/.test(t) || /^[-–—]\s*\S+$/.test(t) || /^\d{8,}$/.test(t.replace(/\s/g, ''));
}

function createEngine({
  sherpa, paths, post, vadThreshold = 0.5, idBase = 1, captureAudio = false, now = Date.now,
  makeSegmenter = createSegmenter, makeTranscriber = createTranscriber, makeEchoDetector = createEchoDetector
}) {
  const transcriber = makeTranscriber({ sherpa, paths });
  const echoDetector = makeEchoDetector();
  const streams = new Map();
  const kept = new Map();
  let nextId = idBase;
  let capture = captureAudio; // sesión de prueba: cada frase viaja con su audio para guardarlo
  const thresholds = { mic: vadThreshold }; // la sensibilidad que elige el usuario es la de su micrófono

  function streamFor(name, lang) {
    if (!streams.has(name)) {
      streams.set(name, {
        segmenter: makeSegmenter({ sherpa, modelPath: paths.vad, threshold: thresholds[name] ?? DEFAULT_THRESHOLD }),
        speaking: false,
        lang,
        target: null,
        lastAt: null, // hora en que terminó el último trozo recibido
        partialSamples: 0 // audio que ya cubría el último texto provisional
      });
    }
    const state = streams.get(name);
    if (lang) state.lang = lang;
    return state;
  }

  /** ¿Esta frase del micrófono es la reunión sonando por los parlantes? */
  function isMeetingEcho(name, state, segment) {
    if (name !== 'mic' || state.lastAt === null || segment.start === undefined) return null;
    if (typeof state.segmenter.position !== 'function') return null;
    const startAt = state.lastAt - (state.segmenter.position() - segment.start) / 16;
    const result = echoDetector.check(segment.samples, startAt);
    return result.echo ? result : null;
  }

  function publish(name, state, segments) {
    const lang = state.lang;
    for (const segment of segments) {
      state.partialSamples = 0;
      if (segment.samples.length < MIN_SEGMENT_SAMPLES) continue;
      const durationMs = Math.round(segment.samples.length / 16);

      const echo = isMeetingEcho(name, state, segment);
      if (echo) {
        post({ type: 'echo', stream: name, durationMs, score: Math.round(echo.score * 100) / 100 });
        continue;
      }

      const remember = () => {
        const id = nextId++;
        kept.set(id, { samples: segment.samples, lang });
        if (kept.size > KEEP_SEGMENTS) kept.delete(kept.keys().next().value);
        return id;
      };
      const withAudio = (message) => {
        if (capture) message.samples = segment.samples;
        return message;
      };

      // Traducción directa desde el audio: el subtítulo sale sin esperar a la transcripción
      if (state.target && state.target !== lang) {
        const direct = transcriber.translate(segment.samples, lang, state.target);
        if (direct.text && HAS_WORDS.test(direct.text) && !isInventedTranslation(direct.text)) {
          const id = remember();
          post(withAudio({ type: 'segment', id, stream: name, lang, target: state.target, text: '', durationMs, sttMs: 0, translated: direct.text, translateMs: direct.ms }));
          const heard = transcriber.transcribe(segment.samples, lang);
          post({ type: 'segment-text', id, stream: name, text: heard.text || '', sttMs: heard.ms });
          continue;
        }
      }

      const { text, ms } = transcriber.transcribe(segment.samples, lang);
      if (!text || !HAS_WORDS.test(text)) continue;
      const id = remember();
      post(withAudio({ type: 'segment', id, stream: name, lang, text, durationMs, sttMs: ms }));
    }
  }

  /** Texto provisional de la frase que aún se está diciendo, si hay audio nuevo suficiente y el motor va al día. */
  function maybePartial(name, state, msg) {
    if (!msg.partial || !state.speaking || typeof state.segmenter.peek !== 'function') return;
    if (msg.at && now() - msg.at > PARTIAL_MAX_LAG_MS) return;
    const pending = state.segmenter.peek();
    if (!pending || pending.length < PARTIAL_MIN_SAMPLES) return;
    if (pending.length - state.partialSamples < PARTIAL_STEP_SAMPLES) return;
    state.partialSamples = pending.length;
    const direct = !!(state.target && state.target !== state.lang);
    const result = direct ? transcriber.translate(pending, state.lang, state.target) : transcriber.transcribe(pending, state.lang);
    if (!result.text || !HAS_WORDS.test(result.text)) return;
    post({ type: 'partial', stream: name, lang: state.lang, text: result.text, translated: direct, durationMs: Math.round(pending.length / 16), ms: result.ms });
  }

  /** Cierra la frase en curso de un flujo y lo deja limpio: el audio siguiente no se pega a lo ya cerrado. */
  function close(name) {
    const state = streams.get(name);
    if (!state) return;
    streams.delete(name);
    if (state.speaking) post({ type: 'vad', stream: name, speaking: false });
    publish(name, state, state.segmenter.flush());
  }

  return {
    handle(msg) {
      if (msg.type === 'audio') {
        const state = streamFor(msg.stream, msg.lang);
        state.target = msg.target || null;
        if (msg.at) {
          state.lastAt = msg.at;
          if (msg.stream === 'incoming') echoDetector.observeReference(msg.samples, msg.at);
        }
        const segments = state.segmenter.push(msg.samples);
        const speaking = state.segmenter.isSpeaking();
        if (speaking !== state.speaking) {
          state.speaking = speaking;
          if (!speaking) state.partialSamples = 0;
          post({ type: 'vad', stream: msg.stream, speaking });
        }
        if (segments.length > 0) publish(msg.stream, state, segments);
        else maybePartial(msg.stream, state, msg);
      } else if (msg.type === 'flush') {
        const names = msg.stream ? [msg.stream] : [...streams.keys()];
        for (const name of names) close(name);
      } else if (msg.type === 'capture') {
        capture = !!msg.enabled;
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
        if (!text || !HAS_WORDS.test(text) || isInventedTranslation(text)) {
          post({ type: 'translation', id: msg.id, error: 'Traducción no fiable para esta frase' });
          return;
        }
        post({ type: 'translation', id: msg.id, text, ms });
      } else if (msg.type === 'reset') {
        streams.clear();
        kept.clear();
      }
    }
  };
}

module.exports = { createEngine, MIN_SEGMENT_SAMPLES };
