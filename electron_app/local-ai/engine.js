/**
 * engine.js - Motor local: tramas ➔ segmentos de voz ➔ texto ➔ traducción. No depende de Electron.
 *
 * Canary transcribe y el traductor de texto (Bergamot, Firefox Translations) traduce: mejor calidad que la
 * traducción directa de Canary desde el audio y una sola pasada del modelo de voz por frase. Los trozos de una
 * misma frase se unen (sentence-joiner) para que el subtítulo traduzca la frase entera.
 */

const { createSegmenter } = require('./segmenter');
const { createTranscriber } = require('./transcriber');
const { createEchoDetector } = require('./echo-detector');
const { createSentenceJoiner } = require('./sentence-joiner');
const { otherLanguage } = require('./languages');
const { createSpeakerEmbedder } = require('./speaker-embedder');
const { createSpeakerTracker } = require('./speaker-tracker');

const MIN_SEGMENT_SAMPLES = 6400; // 400 ms: por debajo el modelo inventa palabras
const KEEP_SEGMENTS = 8; // audio que se conserva para traducir sin traductor de texto
const HAS_WORDS = /[\p{L}\p{N}]/u;
const DEFAULT_THRESHOLD = 0.5;
const PARTIAL_MIN_SAMPLES = 24000; // texto provisional a partir de 1,5 s de frase
const PARTIAL_STEP_SAMPLES = 24000; // y luego cada 1,5 s de audio nuevo
const PARTIAL_MAX_LAG_MS = 600; // si el motor va con más retraso que esto, no hay tiempo para provisionales
// Misma persona si su huella se parece al menos esto. En la prueba de panel (tres voces) las de una misma persona
// quedaron por encima de 0,65 y las de personas distintas por debajo de 0,51: funcionaba igual entre 0,45 y 0,8.
const SPEAKER_THRESHOLD = 0.6;
const NOISE_CHECK_WORDS = 3; // frases del micrófono de hasta 3 palabras: ahí es donde el ruido se oye como palabras

/**
 * Salidas típicas del modelo cuando no entiende el audio (música, ruido, voces lejanas): una acotación
 * entre paréntesis, un guion de diálogo con una sola palabra, una ristra de dígitos o la misma palabra
 * repetida. Vistas en sesiones reales.
 */
function isInventedTranslation(text) {
  const t = text.trim();
  if (/^\(.*\)$/.test(t) || /^[-–—]\s*\S+$/.test(t)) return true;
  if (/^(\S+)(\s+\1){3,}\.?$/u.test(t)) return true; // «E E E E E»
  // Solo cifras y separadores ("1", "1.1.2.2.2"): un invento, salvo que sea un número corriente ("15", "2026")
  return /^[\d\s.,]+$/.test(t) && !/^\d{2,4}$/.test(t);
}

/** Transcripciones que no son habla: acotaciones («(Tecológica)», «(mucha?») o letras deletreadas sueltas. */
function isNoiseTranscript(text) {
  const t = text.trim();
  return /^\(/.test(t) || /^(\p{L}[.\s]+){3,}\p{L}?\.?$/u.test(t);
}

const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

function createEngine({
  sherpa, paths, post, vadThreshold = 0.5, idBase = 1, captureAudio = false, now = Date.now, translator = null,
  glossary = null, makeSegmenter = createSegmenter, makeTranscriber = createTranscriber,
  makeEchoDetector = createEchoDetector, makeJoiner = createSentenceJoiner,
  makeSpeakerEmbedder = createSpeakerEmbedder, makeSpeakerTracker = createSpeakerTracker
}) {
  const transcriber = makeTranscriber({ sherpa, paths });
  const echoDetector = makeEchoDetector();
  const joiner = makeJoiner();
  // Quién habla en la reunión: solo el flujo de la reunión, y solo si está el modelo de huella
  const embedder = makeSpeakerEmbedder({ sherpa, paths });
  const speakers = makeSpeakerTracker({ threshold: SPEAKER_THRESHOLD });
  const streams = new Map();
  const kept = new Map();
  let nextId = idBase;
  let capture = captureAudio; // sesión de prueba: cada frase viaja con su audio para guardarlo
  const thresholds = { mic: vadThreshold }; // la sensibilidad que elige el usuario es la de su micrófono

  function streamFor(name, lang) {
    if (!streams.has(name)) {
      streams.set(name, {
        // El corte en pausas dentro de un segmento separa a dos personas de la reunión; en el micrófono solo hablas tú
        // y partir la frase empeoraba la jerga del comienzo («rollback» → «el Y Back»)
        segmenter: makeSegmenter({ sherpa, modelPath: paths.vad, threshold: thresholds[name] ?? DEFAULT_THRESHOLD, splitQuiet: name === 'incoming' }),
        speaking: false,
        lang,
        target: null,
        lastAt: null, // hora en que terminó el último trozo recibido
        lastEnd: null, // muestra en que terminó la última frase publicada: mide la pausa hasta la siguiente
        partialSamples: 0 // audio que ya cubría el último texto provisional
      });
    }
    const state = streams.get(name);
    if (lang && lang !== state.lang) joiner.reset(name);
    if (lang) state.lang = lang;
    return state;
  }

  /**
   * Traduce con el traductor de texto protegiendo los términos técnicos que estropearía («mocks» → «burlas»): van
   * como marcadores y se restauran; si el traductor pierde un marcador, esa frase se traduce sin proteger.
   */
  function translateProtected(texts, source, target) {
    if (!glossary) return translator.translateMany(texts, source, target);
    const guarded = texts.map((t) => glossary.protect(t, source));
    const out = translator.translateMany(guarded.map((g) => g.text), source, target);
    const retry = [];
    const result = out.map((translated, i) => {
      if (!guarded[i].count) return translated;
      const restored = guarded[i].restore(translated, target);
      if (restored === null) retry.push(i);
      return restored;
    });
    if (retry.length > 0) {
      const plain = translator.translateMany(retry.map((i) => texts[i]), source, target);
      retry.forEach((i, k) => { result[i] = plain[k]; });
    }
    return result;
  }

  /** Corrige los términos técnicos mal transcritos; devuelve el texto, lo oído si cambió y las pistas para la nube. */
  function fixTerms(text, lang) {
    if (!glossary || !text) return { text, heard: null, hints: [] };
    const fixed = glossary.correct(text, lang);
    return { text: fixed.text, heard: fixed.fixes.length > 0 ? text : null, hints: fixed.hints };
  }

  /** Traduce texto con el traductor local; sin él, Canary traduce desde el audio de la frase. */
  function translateTexts(texts, samples, source, target) {
    const started = now();
    if (translator) {
      try {
        return { texts: translateProtected(texts, source, target), ms: now() - started };
      } catch (err) {
        post({ type: 'error', stage: 'translate', fatal: false, message: `Traductor local: ${err.message}` });
      }
    }
    if (!samples) return { texts: texts.map(() => ''), ms: 0 };
    const direct = transcriber.translate(samples, source, target);
    const ok = direct.text && HAS_WORDS.test(direct.text) && !isInventedTranslation(direct.text);
    // El audio solo es el de esta frase: la frase unida a las anteriores se queda sin traducir
    return { texts: texts.map((_, i) => (ok && i === 0 ? direct.text : '')), ms: direct.ms };
  }

  /** ¿Esta frase del micrófono es la reunión sonando por los parlantes? */
  function isMeetingEcho(name, state, segment) {
    if (name !== 'mic' || state.lastAt === null || segment.start === undefined) return null;
    if (typeof state.segmenter.position !== 'function') return null;
    const startAt = state.lastAt - (state.segmenter.position() - segment.start) / 16;
    const result = echoDetector.check(segment.samples, startAt);
    return result.echo ? result : null;
  }

  /**
   * Una frase muy corta del micrófono puede ser ruido que el modelo convirtió en palabras («Que», «Mm.»). Su
   * traducción directa desde el audio lo delata: sale una ristra de cifras o nada. Cuesta una pasada corta.
   */
  function isMicNoise(name, lang, text, samples) {
    if (name !== 'mic' || wordCount(text) > NOISE_CHECK_WORDS) return false;
    const probe = transcriber.translate(samples, lang, otherLanguage(lang));
    return !probe.text || !HAS_WORDS.test(probe.text) || isInventedTranslation(probe.text);
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

      const { text: raw, ms } = transcriber.transcribe(segment.samples, lang);
      if (!raw || !HAS_WORDS.test(raw)) continue;
      if (isNoiseTranscript(raw) || isMicNoise(name, lang, raw, segment.samples)) {
        post({ type: 'noise', stream: name, durationMs, text: raw });
        continue;
      }
      const { text, heard, hints } = fixTerms(raw, lang);

      const id = nextId++;
      kept.set(id, { samples: segment.samples, lang });
      if (kept.size > KEEP_SEGMENTS) kept.delete(kept.keys().next().value);

      let gapMs = null;
      if (segment.start !== undefined) {
        if (state.lastEnd !== null) gapMs = Math.max(0, Math.round((segment.start - state.lastEnd) / 16));
        state.lastEnd = segment.start + segment.samples.length;
      }
      let who = null;
      if (name === 'incoming' && embedder) who = speakers.assign(embedder.compute(segment.samples), segment.samples.length / 16000);
      const speaker = who ? who.id : null;
      const piece = joiner.add({ stream: name, id, lang, text, gapMs, speaker });

      const message = { type: 'segment', id, stream: name, lang, text, durationMs, sttMs: ms, gapMs };
      if (speaker !== null) {
        message.speaker = speaker;
        message.speakerScore = who.similarity === null ? null : Math.round(who.similarity * 100) / 100;
      }
      if (heard) message.heard = heard; // lo que escribió el reconocedor antes de corregir los términos
      if (hints.length > 0) message.hints = hints;
      if (piece.joined) message.join = { lineId: piece.lineId, text: piece.text };
      if (state.target && state.target !== lang) {
        const wanted = piece.joined ? [text, piece.text] : [text];
        const done = translateTexts(wanted, segment.samples, lang, state.target);
        if (done.texts[0]) {
          message.target = state.target;
          message.translated = done.texts[0];
          message.translateMs = done.ms;
          if (piece.joined && done.texts[1]) message.join.translated = done.texts[1];
        }
      }
      if (capture) message.samples = segment.samples;
      post(message);
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
    const heard = transcriber.transcribe(pending, state.lang);
    if (!heard.text || !HAS_WORDS.test(heard.text) || isNoiseTranscript(heard.text)) return;
    heard.text = fixTerms(heard.text, state.lang).text;
    const message = { type: 'partial', stream: name, lang: state.lang, text: heard.text, translated: false, durationMs: Math.round(pending.length / 16), ms: heard.ms };
    if (state.target && state.target !== state.lang) {
      const done = translateTexts([heard.text], pending, state.lang, state.target);
      if (!done.texts[0]) return;
      Object.assign(message, { text: done.texts[0], heard: heard.text, translated: true, ms: heard.ms + done.ms });
    }
    post(message);
  }

  /** Cierra la frase en curso de un flujo y lo deja limpio: el audio siguiente no se pega a lo ya cerrado. */
  function close(name) {
    const state = streams.get(name);
    if (!state) return;
    streams.delete(name);
    if (state.speaking) post({ type: 'vad', stream: name, speaking: false });
    publish(name, state, state.segmenter.flush());
    joiner.reset(name);
  }

  /**
   * Traducción pedida por la interfaz (la nube no respondió): el texto con el traductor local o, sin él, el
   * audio guardado de la frase `segmentId`. `id` identifica la petición.
   */
  function translateRequest(msg) {
    const segment = kept.get(msg.segmentId);
    const source = msg.source || (segment && segment.lang);
    if (!source || (!segment && !(translator && msg.text))) {
      post({ type: 'translation', id: msg.id, error: 'El audio de esa frase ya no está disponible' });
      return;
    }
    const done = translateTexts([msg.text || ''], segment ? segment.samples : null, source, msg.target);
    if (!done.texts[0]) {
      post({ type: 'translation', id: msg.id, error: 'Traducción no fiable para esta frase' });
      return;
    }
    post({ type: 'translation', id: msg.id, text: done.texts[0], ms: done.ms });
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
        translateRequest(msg);
      } else if (msg.type === 'reset') {
        streams.clear();
        kept.clear();
        joiner.reset();
        speakers.reset();
      }
    }
  };
}

module.exports = { createEngine, isInventedTranslation, isNoiseTranscript, MIN_SEGMENT_SAMPLES };
