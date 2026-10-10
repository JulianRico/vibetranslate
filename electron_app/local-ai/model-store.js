/**
 * model-store.js - Modelos del motor local: dónde están, cuáles faltan y descarga verificada
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const CANARY = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8/resolve/main/';

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

function createModelStore({ dir, files = MODEL_FILES, fetchImpl = fetch }) {
  const fileFor = (f) => path.join(dir, f.file);

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

  async function download(f, onChunk) {
    const target = fileFor(f);
    const part = target + '.part';
    const out = fs.createWriteStream(part);
    const hash = crypto.createHash('sha256');
    let loaded = 0;
    try {
      const res = await fetchImpl(f.url);
      if (!res.ok || !res.body) throw new Error(`No se pudo descargar ${f.file} (HTTP ${res.status})`);
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        loaded += buf.length;
        if (!out.write(buf)) await once(out, 'drain');
        onChunk(buf.length, loaded);
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (loaded !== f.size || hash.digest('hex') !== f.sha256) {
        throw new Error(`Descarga corrupta de ${f.file}: no coincide el tamaño o la suma de verificación`);
      }
      fs.renameSync(part, target);
    } catch (err) {
      out.destroy();
      if (!out.closed) await once(out, 'close').catch(() => {});
      fs.rmSync(part, { force: true });
      throw err;
    }
  }

  async function ensure(onProgress = () => {}) {
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

  function paths() {
    return Object.fromEntries(files.map((f) => [f.id, fileFor(f)]));
  }

  return { paths, status, ensure };
}

module.exports = { MODEL_FILES, createModelStore };
