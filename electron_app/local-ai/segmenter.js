/**
 * segmenter.js - Convierte tramas de audio en segmentos de voz con Silero VAD
 */

const WINDOW = 512;

/** Traduce el selector de sensibilidad del micrófono (umbral RMS antiguo) al umbral de probabilidad de Silero. */
function thresholdFromNoiseGate(value) {
  const gate = parseFloat(value);
  if (!Number.isFinite(gate)) return 0.5;
  if (gate <= 0.008) return 0.35;
  if (gate <= 0.016) return 0.5;
  if (gate <= 0.03) return 0.6;
  return 0.75;
}

function createSegmenter({ sherpa, modelPath, threshold = 0.5 }) {
  const vad = new sherpa.Vad({
    sileroVad: {
      model: modelPath,
      threshold,
      minSilenceDuration: 0.35,
      minSpeechDuration: 0.4,
      windowSize: WINDOW,
      maxSpeechDuration: 6
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu'
  }, 30);

  let rest = new Float32Array(0);

  function drain() {
    const segments = [];
    while (!vad.isEmpty()) {
      // false: Electron no admite búferes externos
      segments.push({ samples: Float32Array.from(vad.front(false).samples) });
      vad.pop();
    }
    return segments;
  }

  return {
    push(samples) {
      const all = new Float32Array(rest.length + samples.length);
      all.set(rest);
      all.set(samples, rest.length);
      let i = 0;
      for (; i + WINDOW <= all.length; i += WINDOW) {
        vad.acceptWaveform(all.slice(i, i + WINDOW));
      }
      rest = all.slice(i);
      return drain();
    },
    flush() {
      vad.flush();
      rest = new Float32Array(0);
      return drain();
    },
    isSpeaking: () => vad.isDetected()
  };
}

module.exports = { createSegmenter, thresholdFromNoiseGate };
