/**
 * worker.js - Proceso utilitario de Electron que ejecuta el motor local fuera de la interfaz
 */

const sherpa = require('sherpa-onnx-node');
const { createEngine } = require('./engine');
const { createTextTranslator, modelsFromPaths } = require('./text-translator');
const { createTechGlossary, translatorWordCheck } = require('./tech-glossary');
const { loadLexicon } = require('./spm-lexicon');

let engine = null;
let initializing = null; // mientras carga, los mensajes esperan en orden en vez de fallar
const post = (msg) => process.parentPort.postMessage(msg);

/** El traductor de texto es opcional: si no carga, el motor traduce con Canary desde el audio, como antes. */
async function loadTranslator(paths) {
  const models = modelsFromPaths(paths);
  if (Object.keys(models).length === 0) return null;
  try {
    return await createTextTranslator({ models });
  } catch (err) {
    post({ type: 'error', stage: 'translator', fatal: false, message: `No se pudo cargar el traductor local (${err.message}); se traducirá desde el audio.` });
    return null;
  }
}

/**
 * Términos técnicos: el vocabulario del traductor dice qué es una palabra corriente; en caso de duda se consulta al
 * propio traductor. Sin vocabulario solo se aplican las formas exactas; sin traductor, nada se considera deformación.
 */
function makeGlossary(paths, translator, user) {
  let lexicon = null;
  try {
    lexicon = loadLexicon(paths.mtEsEnVocab || paths.mtEnEsVocab);
  } catch (err) {
    post({ type: 'error', stage: 'glossary', fatal: false, message: `No se pudo leer el vocabulario: ${err.message}` });
  }
  return createTechGlossary({
    user: user || {},
    isKnownWord: (w) => !!lexicon && lexicon.has(w),
    isWord: translator ? translatorWordCheck(translator) : () => true,
    fuzzy: !!lexicon
  });
}

process.parentPort.on('message', async (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'ping') {
      post({ type: 'pong' });
      return;
    }
    if (msg.type === 'init') {
      const started = Date.now();
      initializing = loadTranslator(msg.paths);
      const translator = await initializing;
      const glossary = makeGlossary(msg.paths, translator, msg.glossary);
      engine = createEngine({ sherpa, paths: msg.paths, vadThreshold: msg.vadThreshold, idBase: msg.idBase, captureAudio: msg.captureAudio, post, translator, glossary });
      initializing = null;
      post({ type: 'ready', loadMs: Date.now() - started, translator: !!translator });
      return;
    }
    if (initializing) await initializing.catch(() => {});
    if (!engine) throw new Error('El motor local no está inicializado');
    engine.handle(msg);
  } catch (err) {
    post({ type: 'error', stage: msg.type, message: err.message, fatal: false });
  }
});
