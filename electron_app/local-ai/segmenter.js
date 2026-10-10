/**
 * segmenter.js - Convierte tramas de audio en segmentos de voz con Silero VAD
 */

const WINDOW = 512;
const PRE_ROLL = 1600; // 100 ms previos al inicio detectado: con 150 ms o más el modelo empeora cuando hay ruido de fondo
const HISTORY = 16000 * 8; // cubre el segmento más largo (6 s) más su margen

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

  // Historial reciente para anteponer a cada segmento el audio previo a la detección:
  // Silero marca el inicio algo tarde y sin ese margen el modelo pierde la primera palabra.
  const history = new Float32Array(HISTORY);
  let fed = 0; // muestras entregadas al detector desde el inicio del flujo
  let previousEnd = 0;

  function remember(window) {
    history.copyWithin(0, window.length);
    history.set(window, HISTORY - window.length);
    fed += window.length;
  }

  /** Muestras del flujo en [from, to), si siguen en el historial. */
  function recall(from, to) {
    const oldest = fed - HISTORY;
    const start = Math.max(from, oldest, 0);
    if (start >= to) return new Float32Array(0);
    return history.slice(start - oldest, to - oldest);
  }

  function drain() {
    const segments = [];
    while (!vad.isEmpty()) {
      // false: Electron no admite búferes externos
      const front = vad.front(false);
      const speech = Float32Array.from(front.samples);
      const preRoll = recall(Math.max(front.start - PRE_ROLL, previousEnd), front.start);
      const samples = new Float32Array(preRoll.length + speech.length);
      samples.set(preRoll);
      samples.set(speech, preRoll.length);
      previousEnd = front.start + speech.length;
      segments.push({ samples, start: front.start - preRoll.length });
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
        const window = all.slice(i, i + WINDOW);
        remember(window);
        vad.acceptWaveform(window);
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
