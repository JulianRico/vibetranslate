/**
 * transcriber.js - Transcribe o traduce un segmento de voz con NeMo Canary (EN y ES en un solo modelo)
 */

function createTranscriber({ sherpa, paths, numThreads = 2 }) {
  const config = (source, target) => ({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      canary: { encoder: paths.encoder, decoder: paths.decoder, srcLang: source, tgtLang: target, usePnc: 1 },
      tokens: paths.tokens,
      numThreads,
      provider: 'cpu'
    }
  });

  const recognizer = new sherpa.OfflineRecognizer(config('en', 'en'));

  function decode(samples, source, target) {
    recognizer.setConfig(config(source, target)); // cambia de idioma sin recargar el modelo
    const stream = recognizer.createStream();
    const started = Date.now();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    recognizer.decode(stream);
    return { text: (recognizer.getResult(stream).text || '').trim(), ms: Date.now() - started };
  }

  return {
    transcribe: (samples, lang) => decode(samples, lang, lang),
    translate: (samples, source, target) => decode(samples, source, target)
  };
}

module.exports = { createTranscriber };
