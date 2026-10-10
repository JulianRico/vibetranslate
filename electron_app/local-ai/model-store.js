/**
 * model-store.js - Modelos del motor local: dónde están, cuáles faltan y descarga verificada
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Revisión fijada: una rama puede cambiar de contenido y entonces ninguna instalación pasaría la verificación
const CANARY = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/resolve/9077164e0d3dd1d5353743e89ceaa1d3a770838c/';

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
    const missing = files.filter((f) => !isPresent(f)).map((f) => ({ id: f.id, file: f.file, size: f.size }));
    return { ready: missing.length === 0, missing, missingBytes: missing.reduce((n, f) => n + f.size, 0) };
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

  async function download(f, onChunk) {
    const target = fileFor(f);
    const part = `${target}.part`;
    const abort = new AbortController();
    let handle = null;
    let keepPart = true; // un parcial sano se conserva para reanudar; uno que no verifica se borra
    try {
      let have = 0;
      try { have = fs.statSync(part).size; } catch { /* no hay parcial */ }
      if (have >= f.size) have = 0; // no puede ser un parcial válido: se empieza de cero
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
      // Se verifica el archivo tal como quedó en disco, no los bytes que llegaron por la red
      const onDisk = fs.statSync(part).size;
      if (onDisk !== f.size || (await hashFile(part)) !== f.sha256) {
        keepPart = false;
        throw new Error(`Descarga corrupta de ${f.file}: no coincide el tamaño o la suma de verificación`);
      }
      fs.renameSync(part, target);
    } catch (err) {
      abort.abort();
      if (handle) await handle.close().catch(() => {});
      if (!keepPart) fs.rmSync(part, { force: true });
      throw err;
    }
  }

  async function run(onProgress) {
    fs.mkdirSync(dir, { recursive: true });
    const todo = files.filter((f) => !isPresent(f));
    const overallTotal = todo.reduce((n, f) => n + f.size, 0);
    let overallLoaded = 0;
    for (const f of todo) {
      fs.rmSync(fileFor(f), { force: true });
      await download(f, (delta, loaded) => {
        overallLoaded += delta;
        onProgress({ id: f.id, file: f.file, loaded, total: f.size, overallLoaded, overallTotal });
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
