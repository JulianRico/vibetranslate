/**
 * level-compensator.js - Devuelve su nivel al audio de la reunión cuando los demás programas están atenuados
 *
 * Con la atenuación activa, la captura recibe a los demás programas ya bajados (p. ej. al 5 %). Se amplifica
 * hasta `maxGain`, pero nunca más de lo que cabe: un programa que suene sin atenuar (acaba de abrirse y aún
 * no se ha bajado) no se satura.
 */

const TARGET_PEAK = 0.7; // el audio amplificado no pasa de aquí
const RELEASE_PER_SAMPLE = Math.exp(-1 / (16000 * 0.25)); // el nivel medido cae en ~250 ms cuando el sonido baja

function createLevelCompensator({ maxGain = 1 } = {}) {
  let envelope = 0; // nivel reciente de la señal, con subida inmediata y bajada lenta

  return {
    process(samples) {
      if (maxGain <= 1) return samples;
      // Primero el pico del trozo: así la ganancia ya está ajustada desde su primera muestra
      let chunkPeak = 0;
      for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > chunkPeak) chunkPeak = a;
      }
      if (chunkPeak > envelope) envelope = chunkPeak;

      const out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        envelope = a > envelope ? a : Math.max(a, envelope * RELEASE_PER_SAMPLE);
        const gain = envelope > 0 ? Math.min(maxGain, TARGET_PEAK / envelope) : maxGain;
        out[i] = samples[i] * Math.max(1, gain) > 1 ? 1 : Math.max(-1, samples[i] * Math.max(1, gain));
      }
      return out;
    },
    reset() {
      envelope = 0;
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createLevelCompensator };
}
