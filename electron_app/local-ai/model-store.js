/**
 * model-store.js - Modelos del motor local: dónde están, cuáles faltan y descarga verificada
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// Revisión fijada: una rama puede cambiar de contenido y entonces ninguna instalación pasaría la verificación
const CANARY = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/resolve/9077164e0d3dd1d5353743e89ceaa1d3a770838c/';

// Traducción de texto: modelos de Firefox Translations (MPL-2.0) tal como los publica Mozilla, comprimidos con gzip.
// La carpeta es la ejecución de entrenamiento: un modelo nuevo tendría otra ruta y estas no cambian.
const FIREFOX = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models/';
const EN_ES = FIREFOX + 'en-es/retrain_hr_fix_names_CUAEXUHoQum_cFqh-ZAryw/exported/';
const ES_EN = FIREFOX + 'es-en/retrain_hr_HbNjJ60BTwmVTbhfFxuduA/exported/';

const MODEL_FILES = [
  {
    id: 'vad',
    file: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
  },
  {
    id: 'encoder',
    file: 'canary-encoder.int8.onnx',
    url: CANARY + 'encoder.int8.onnx',
    size: 132678643,
    sha256: '7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f'
  },
  {
    id: 'decoder',
    file: 'canary-decoder.int8.onnx',
    url: CANARY + 'decoder.int8.onnx',
    size: 74437848,
    sha256: 'e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2'
  },
  {
    id: 'tokens',
    file: 'canary-tokens.txt',
    url: CANARY + 'tokens.txt',
    size: 53555,
    sha256: '2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77'
  },
  // Huella de voz para saber quién habla en la reunión (NeMo TitaNet small): en la prueba de panel separó a las tres
  // personas sin un fallo, frente al 70 % de wespeaker ResNet34
  {
    id: 'speaker',
    file: 'nemo_en_titanet_small.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
    size: 40257283,
    sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e'
  },
  // `size` y `sha256` son del archivo ya descomprimido; `downloadSize`, de lo que llega por la red
  {
    id: 'mtEnEs',
    file: 'model.enes.intgemm.alphas.bin',
    url: EN_ES + 'model.enes.intgemm.alphas.bin.gz',
    gzip: true,
    downloadSize: 22698792,
    size: 31561787,
    sha256: '3b1c399511c01c84c36fae5c0524df44096288efdc8236e182b5c97d7ad2244c'
  },
  {
    id: 'mtEnEsLex',
    file: 'lex.50.50.enes.s2t.bin',
    url: EN_ES + 'lex.50.50.enes.s2t.bin.gz',
    gzip: true,
    downloadSize: 2265250,
    size: 4198436,
    sha256: '7d51237c0a07027dcd61643cfbbb0f8c48597d19907ef53d2cae9d6bec2cf25c'
  },
  {
    id: 'mtEnEsVocab',
    file: 'vocab.enes.spm',
    url: EN_ES + 'vocab.enes.spm.gz',
    gzip: true,
    downloadSize: 409312,
    size: 816054,
    sha256: '5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad'
  },
  {
    id: 'mtEsEn',
    file: 'model.esen.intgemm.alphas.bin',
    url: ES_EN + 'model.esen.intgemm.alphas.bin.gz',
    gzip: true,
    downloadSize: 23288494,
    size: 31561787,
    sha256: '4aed7734152ae0045d1a69ae49c86cfda18f53c61f90e95e1d1de1c7c7c3b033'
  },
  {
    id: 'mtEsEnLex',
    file: 'lex.50.50.esen.s2t.bin',
    url: ES_EN + 'lex.50.50.esen.s2t.bin.gz',
    gzip: true,
    downloadSize: 2543246,
    size: 4636248,
    sha256: 'e2610211d3b9577d012638fe7e7e74ed7b4b708ce96b9e792e67c282a6492daa'
  },
  {
    id: 'mtEsEnVocab',
    file: 'vocab.esen.spm',
    url: ES_EN + 'vocab.esen.spm.gz',
    gzip: true,
    downloadSize: 409312,
    size: 816054,
    sha256: '5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad'
  }
];

const STALL_MS = 30000;

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Bytes que llegan por la red: los comprimidos ocupan menos que el archivo final. */
const wireSize = (f) => f.downloadSize || f.size;

function createModelStore({ dir, files = MODEL_FILES, fetchImpl = fetch, stallMs = STALL_MS }) {
  const fileFor = (f) => path.join(dir, f.file);
  let inFlight = null; // una sola descarga a la vez: es lo que permite un parcial con nombre fijo y reanudable

  function isPresent(f) {
    try {
      return fs.statSync(fileFor(f)).size === f.size;
    } catch {
      return false;
    }
  }

  function status() {
    const todo = files.filter((f) => !isPresent(f));
    const missing = todo.map((f) => ({ id: f.id, file: f.file, size: f.size }));
    return { ready: missing.length === 0, missing, missingBytes: todo.reduce((n, f) => n + wireSize(f), 0) };
  }

  /** Lee el siguiente bloque o falla si el servidor deja de enviar datos. */
  function nextChunk(iterator, f) {
    let timer = null;
    const stalled = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`La descarga de ${f.file} se detuvo: ${Math.round(stallMs / 1000)} s sin recibir datos`)),
        stallMs
      );
    });
    return Promise.race([iterator.next(), stalled]).finally(() => clearTimeout(timer));
  }

  /** Descomprime el gzip descargado junto al destino; un archivo dañado no llega a escribirse entero. */
  async function gunzip(f, packed) {
    const unpacked = `${fileFor(f)}.part`;
    try {
      await pipeline(fs.createReadStream(packed), zlib.createGunzip(), fs.createWriteStream(unpacked));
    } catch {
      fs.rmSync(unpacked, { force: true });
      throw new Error(`Descarga corrupta de ${f.file}: no se pudo descomprimir`);
    }
    return unpacked;
  }

  async function download(f, onChunk) {
    const target = fileFor(f);
    const part = f.gzip ? `${target}.gz.part` : `${target}.part`;
    const abort = new AbortController();
    let handle = null;
    let unpacked = null;
    let keepPart = true; // un parcial sano se conserva para reanudar; uno que no verifica se borra
    try {
      let have = 0;
      try { have = fs.statSync(part).size; } catch { /* no hay parcial */ }
      if (have >= wireSize(f)) have = 0; // no puede ser un parcial válido: se empieza de cero
      const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
      const res = await fetchImpl(f.url, { signal: abort.signal, headers });
      if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${f.file} (HTTP ${res.status})`);
      const resumed = have > 0 && res.status === 206;
      if (!resumed) have = 0; // el servidor lo envía entero
      handle = await fs.promises.open(part, resumed ? 'a' : 'w');
      const iterator = res.body[Symbol.asyncIterator]();
      let loaded = have;
      if (have > 0) onChunk(have, loaded);
      for (;;) {
        const { done, value } = await nextChunk(iterator, f);
        if (done) break;
        const buf = Buffer.from(value);
        await handle.write(buf);
        loaded += buf.length;
        onChunk(buf.length, loaded);
      }
      await handle.close();
      handle = null;
      if (f.gzip) {
        if (fs.statSync(part).size !== f.downloadSize) {
          keepPart = false;
          throw new Error(`Descarga corrupta de ${f.file}: no coincide el tamaño descargado`);
        }
        keepPart = false; // ya completo: si no verifica, hay que volver a bajarlo entero
        unpacked = await gunzip(f, part);
      }
      // Se verifica el archivo tal como quedó en disco, no los bytes que llegaron por la red
      const final = unpacked || part;
      const onDisk = fs.statSync(final).size;
      if (onDisk !== f.size || (await hashFile(final)) !== f.sha256) {
        keepPart = false;
        throw new Error(`Descarga corrupta de ${f.file}: no coincide el tamaño o la suma de verificación`);
      }
      fs.renameSync(final, target);
      if (unpacked) fs.rmSync(part, { force: true });
    } catch (err) {
      abort.abort();
      if (handle) await handle.close().catch(() => {});
      if (unpacked) fs.rmSync(unpacked, { force: true });
      if (!keepPart) fs.rmSync(part, { force: true });
      throw err;
    }
  }

  async function run(onProgress) {
    fs.mkdirSync(dir, { recursive: true });
    const todo = files.filter((f) => !isPresent(f));
    const overallTotal = todo.reduce((n, f) => n + wireSize(f), 0);
    let overallLoaded = 0;
    for (const f of todo) {
      fs.rmSync(fileFor(f), { force: true });
      await download(f, (delta, loaded) => {
        overallLoaded += delta;
        onProgress({ id: f.id, file: f.file, loaded, total: wireSize(f), overallLoaded, overallTotal });
      });
    }
  }

  /** Una sola descarga a la vez: las llamadas que coinciden esperan a la que ya está en curso. */
  function ensure(onProgress = () => {}) {
    if (!inFlight) {
      inFlight = run(onProgress).finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function paths() {
    return Object.fromEntries(files.map((f) => [f.id, fileFor(f)]));
  }

  return { paths, status, ensure };
}

module.exports = { MODEL_FILES, createModelStore };
