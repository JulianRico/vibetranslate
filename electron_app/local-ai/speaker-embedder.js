/**
 * speaker-embedder.js - La huella de voz de una frase (NeMo TitaNet small en sherpa-onnx), para saber quién habla
 */

/** Sin el modelo de huella devuelve null: el motor sigue funcionando, solo que sin saber quién habla. */
function createSpeakerEmbedder({ sherpa, paths }) {
  if (!paths || !paths.speaker || !sherpa || typeof sherpa.SpeakerEmbeddingExtractor !== 'function') return null;
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: paths.speaker, numThreads: 1, debug: false, provider: 'cpu' });
  return {
    /** @returns {Float32Array|null} */
    compute(samples) {
      try {
        const stream = extractor.createStream();
        stream.acceptWaveform({ samples: Float32Array.from(samples), sampleRate: 16000 });
        stream.inputFinished();
        // false: sin búferes externos de V8, que Electron no admite
        return Float32Array.from(extractor.compute(stream, false));
      } catch {
        return null;
      }
    }
  };
}

module.exports = { createSpeakerEmbedder };
