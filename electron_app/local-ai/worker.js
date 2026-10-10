/**
 * worker.js - Proceso utilitario de Electron que ejecuta el motor local fuera de la interfaz
 */

const sherpa = require('sherpa-onnx-node');
const { createEngine } = require('./engine');

let engine = null;
const post = (msg) => process.parentPort.postMessage(msg);

process.parentPort.on('message', (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      const started = Date.now();
      engine = createEngine({ sherpa, paths: msg.paths, vadThreshold: msg.vadThreshold, post });
      post({ type: 'ready', loadMs: Date.now() - started });
      return;
    }
    if (!engine) throw new Error('El motor local no está inicializado');
    engine.handle(msg);
  } catch (err) {
    post({ type: 'error', stage: msg.type, message: err.message, fatal: false });
  }
});
