/**
 * text-translator.js - Traduce texto EN↔ES sin red con los modelos de Firefox Translations (Bergamot, Marian en WASM)
 *
 * Es el motor de runonweb.ai (`runonweb/translate`): allí corre en un Web Worker del navegador; aquí el mismo WASM
 * se carga con `vm` dentro del proceso utilitario y los modelos se leen del disco. No depende de Electron.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RUNTIME_DIR = path.join(__dirname, 'vendor', 'bergamot');

// Sin el módulo nativo de multiplicación que trae Firefox, el WASM usa sus propias rutinas
const GEMM_FALLBACKS = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback'
};

// Configuración de Firefox Translations: búsqueda voraz, la más rápida y la que usan sus métricas publicadas
const MODEL_CONFIG = [
  'beam-size: 1', 'normalize: 1.0', 'word-penalty: 0', 'cpu-threads: 0', 'gemm-precision: int8shiftAlphaAll',
  'skip-cost: true', 'alignment: soft', 'quiet: true', 'quiet-translation: true', 'max-length-break: 128',
  'mini-batch-words: 1024', 'workspace: 128', 'max-length-factor: 2.0'
].join('\n') + '\n';

const WARMUP = { en: 'Hello, can you hear me?', es: 'Hola, ¿me escuchas?' };

function loadRuntime(dir) {
  const wasm = fs.readFileSync(path.join(dir, 'bergamot-translator-worker.wasm'));
  const glue = fs.readFileSync(path.join(dir, 'bergamot-translator-worker.js'), 'utf8');
  const Module = { print() {}, printErr() {} };
  return new Promise((resolve, reject) => {
    Module.instantiateWasm = (imports, accept) => {
      const gemm = {};
      for (const [name, target] of Object.entries(GEMM_FALLBACKS)) gemm[name] = (...args) => Module.asm[target](...args);
      WebAssembly.instantiate(wasm, { ...imports, wasm_gemm: gemm }).then((r) => accept(r.instance)).catch(reject);
      return {};
    };
    Module.onRuntimeInitialized = () => resolve(Module);
    Module.onAbort = (what) => reject(new Error(`Bergamot abortó: ${what}`));
    const context = vm.createContext({ Module, console, WebAssembly, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout });
    vm.runInContext(glue, context, { filename: 'bergamot-translator-worker.js' });
  });
}

/** Comillas tipográficas a rectas: la voz y el registro las tratan igual y el texto queda uniforme. */
function tidy(text) {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
}

/**
 * @param {{ models: Object<string, { model: string, lex: string, vocab: string }>, runtimeDir?: string }} options
 *   `models` por par, p. ej. `{ 'en-es': { model, lex, vocab } }`, con las rutas de los archivos.
 */
async function createTextTranslator({ models, runtimeDir = RUNTIME_DIR }) {
  const Module = await loadRuntime(runtimeDir);
  const service = new Module.BlockingService({ cacheSize: 0 });

  const aligned = (file, alignment) => {
    const bytes = fs.readFileSync(file);
    const memory = new Module.AlignedMemory(bytes.byteLength, alignment);
    memory.getByteArrayView().set(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return memory;
  };

  const loaded = new Map();
  for (const [pair, files] of Object.entries(models)) {
    const vocabs = new Module.AlignedMemoryList();
    vocabs.push_back(aligned(files.vocab, 64));
    loaded.set(pair, new Module.TranslationModel(MODEL_CONFIG, aligned(files.model, 256), aligned(files.lex, 64), vocabs, null));
  }

  function run(model, texts) {
    const input = new Module.VectorString();
    const options = new Module.VectorResponseOptions();
    for (const text of texts) {
      input.push_back(text);
      options.push_back({ alignment: false, html: false, qualityScores: false });
    }
    const responses = service.translate(model, input, options);
    const out = texts.map((_, i) => responses.get(i).getTranslatedText());
    input.delete();
    options.delete();
    responses.delete();
    return out;
  }

  /** Traduce uno o varios textos de una vez; devuelve el mismo número de textos, en orden. */
  function translateMany(texts, from, to) {
    const model = loaded.get(`${from}-${to}`);
    if (!model) throw new Error(`No hay modelo de traducción local para ${from} → ${to}`);
    const clean = texts.map((t) => String(t || '').replace(/\s+/g, ' ').trim());
    const todo = clean.map((t, i) => [t, i]).filter(([t]) => t);
    const out = clean.map(() => '');
    if (todo.length === 0) return out;
    const translated = run(model, todo.map(([t]) => t));
    todo.forEach(([, i], k) => { out[i] = tidy(translated[k]); });
    return out;
  }

  // La primera traducción de cada modelo tarda varias veces más: se paga al cargar, no con la primera frase
  for (const pair of loaded.keys()) translateMany([WARMUP[pair.split('-')[0]] || 'Hello.'], ...pair.split('-'));

  return {
    pairs: () => [...loaded.keys()],
    translateMany,
    translate(text, from, to) {
      const started = Date.now();
      const [out] = translateMany([text], from, to);
      return { text: out, ms: Date.now() - started };
    }
  };
}

/** Modelos que necesita el traductor, a partir de las rutas del almacén de modelos. */
function modelsFromPaths(paths) {
  const models = {};
  for (const [pair, key] of [['en-es', 'EnEs'], ['es-en', 'EsEn']]) {
    const files = { model: paths[`mt${key}`], lex: paths[`mt${key}Lex`], vocab: paths[`mt${key}Vocab`] };
    if (files.model && files.lex && files.vocab) models[pair] = files;
  }
  return models;
}

module.exports = { createTextTranslator, modelsFromPaths, RUNTIME_DIR };
