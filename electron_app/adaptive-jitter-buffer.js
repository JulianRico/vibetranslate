/**
 * adaptive-jitter-buffer.js - Jitter Buffer Adaptativo con Rampas Anti-Click
 * ==========================================================================
 * Inspirado en el motor de audio en tiempo real de NVIDIA PersonaPlex / Moshi (MIT):
 * - Arranque con latencia mínima configurable (80 ms + 10 ms de colchón parcial).
 * - Si ocurre un corte de red (underrun), aplica rampa fade-out y aumenta
 *   automáticamente el colchón parcial (+5 ms hasta un tope de 80 ms).
 * - Si se acumula retraso por ráfagas de red, descarta muestras antiguas hasta
 *   recuperar el tiempo real e incrementa gradualmente la tolerancia máxima.
 * - Al iniciar, reanudar o interrumpir (barge-in / reset), aplica rampas lineales
 *   por muestra (~8 ms) para eliminar chasquidos en auriculares y CABLE Output.
 */

function createAdaptiveJitterBuffer(options = {}) {
  const sampleRate = Math.max(100, Number(options.sampleRate) || 24000);
  const asSamples = (ms) => Math.max(1, Math.round((ms * sampleRate) / 1000));
  const asMs = (samples) => Number(((samples * 1000) / sampleRate).toFixed(2));

  const initialBufferSamples = asSamples(options.initialMs ?? 80);
  const basePartialSamples = asSamples(options.partialMs ?? 10);
  const baseMaxBufferSamples = asSamples(options.maxBufferMs ?? 10);
  const partialIncrement = asSamples(options.incrementMs ?? 5);
  const maxPartialCap = asSamples(options.maxPartialMs ?? 80);
  const maxBufferIncrement = asSamples(options.maxIncrementMs ?? 5);
  const maxBufferCap = asSamples(options.maxCapMs ?? 80);
  const rampLength = asSamples(options.rampMs ?? 8);

  let frames = [];
  let offsetInFirst = 0;
  let totalBuffered = 0;
  let started = false;
  let firstOut = false;
  let remainingPartialSamples = 0;
  let partialBufferSamples = basePartialSamples;
  let maxBufferSamples = baseMaxBufferSamples;
  let fadeOutTail = null;
  let fadeOutOffset = 0;

  // Telemetría de salud acústica
  let totalAudioPlayedSec = 0;
  let actualAudioPlayedSec = 0;
  let minDelaySec = Infinity;
  let maxDelaySec = 0;
  let underruns = 0;
  let dropEvents = 0;
  let droppedSamples = 0;

  function totalMaxBufferSamples() {
    return initialBufferSamples + partialBufferSamples + maxBufferSamples;
  }

  function peekSamples(maxCount) {
    const out = new Float32Array(maxCount);
    let copied = 0;
    let frameIdx = 0;
    let frameOffset = offsetInFirst;
    while (copied < maxCount && frameIdx < frames.length) {
      const buf = frames[frameIdx];
      const avail = buf.length - frameOffset;
      const take = Math.min(avail, maxCount - copied);
      out.set(buf.subarray(frameOffset, frameOffset + take), copied);
      copied += take;
      frameIdx++;
      frameOffset = 0;
    }
    return out.subarray(0, copied);
  }

  function reset({ smooth = true } = {}) {
    if (smooth && started && totalBuffered > 0) {
      const tailLen = Math.min(rampLength, totalBuffered);
      const rawTail = peekSamples(tailLen);
      fadeOutTail = new Float32Array(rawTail.length);
      for (let i = 0; i < rawTail.length; i++) {
        fadeOutTail[i] = rawTail[i] * ((rawTail.length - i) / rawTail.length);
      }
      fadeOutOffset = 0;
    } else {
      fadeOutTail = null;
      fadeOutOffset = 0;
    }

    frames = [];
    offsetInFirst = 0;
    totalBuffered = 0;
    started = false;
    firstOut = false;
    remainingPartialSamples = 0;
    partialBufferSamples = basePartialSamples;
    maxBufferSamples = baseMaxBufferSamples;
  }

  function push(inputSamples) {
    if (!inputSamples || inputSamples.length === 0) return;
    const frame = inputSamples instanceof Float32Array
      ? inputSamples
      : Float32Array.from(inputSamples);

    frames.push(frame);
    totalBuffered += frame.length;

    if (totalBuffered >= initialBufferSamples && !started) {
      started = true;
      remainingPartialSamples = partialBufferSamples;
      firstOut = true;
    }

    // Si una ráfaga de red acumula demasiado retraso, descartar lo más viejo
    if (totalBuffered > totalMaxBufferSamples()) {
      const target = initialBufferSamples + partialBufferSamples;
      let removedNow = 0;
      while (totalBuffered > target && frames.length > 0) {
        const first = frames[0];
        const avail = first.length - offsetInFirst;
        const toDrop = Math.min(avail, totalBuffered - target);
        offsetInFirst += toDrop;
        totalBuffered -= toDrop;
        removedNow += toDrop;
        if (offsetInFirst >= first.length) {
          frames.shift();
          offsetInFirst = 0;
        }
      }
      if (removedNow > 0) {
        dropEvents++;
        droppedSamples += removedNow;
        // Hacer una micro-rampa de entrada en la nueva frontera para evitar salto de fase
        firstOut = true;
      }
      maxBufferSamples = Math.min(maxBufferCap, maxBufferSamples + maxBufferIncrement);
    }
  }

  function canPlay() {
    return started && totalBuffered > 0 && remainingPartialSamples <= 0;
  }

  function pull(output) {
    const len = output.length;
    output.fill(0);

    // 1. Si venimos de una interrupción (barge-in), drenar suavemente la cola de fade-out
    let prefixWritten = 0;
    if (fadeOutTail && fadeOutOffset < fadeOutTail.length) {
      const take = Math.min(len, fadeOutTail.length - fadeOutOffset);
      output.set(fadeOutTail.subarray(fadeOutOffset, fadeOutOffset + take), 0);
      fadeOutOffset += take;
      prefixWritten = take;
      if (fadeOutOffset >= fadeOutTail.length) {
        fadeOutTail = null;
        fadeOutOffset = 0;
      }
      if (prefixWritten === len) {
        totalAudioPlayedSec += len / sampleRate;
        actualAudioPlayedSec += len / sampleRate;
        return len;
      }
    }

    const delaySec = totalBuffered / sampleRate;
    if (canPlay()) {
      maxDelaySec = Math.max(maxDelaySec, delaySec);
      minDelaySec = Math.min(minDelaySec, delaySec);
    } else {
      if (actualAudioPlayedSec > 0) {
        totalAudioPlayedSec += (len - prefixWritten) / sampleRate;
      }
      if (started && remainingPartialSamples > 0) {
        remainingPartialSamples = Math.max(0, remainingPartialSamples - (len - prefixWritten));
      }
      return prefixWritten;
    }

    let outIdx = prefixWritten;
    while (outIdx < len && frames.length > 0) {
      const first = frames[0];
      const avail = first.length - offsetInFirst;
      const toCopy = Math.min(avail, len - outIdx);
      output.set(first.subarray(offsetInFirst, offsetInFirst + toCopy), outIdx);
      offsetInFirst += toCopy;
      totalBuffered -= toCopy;
      outIdx += toCopy;
      if (offsetInFirst >= first.length) {
        frames.shift();
        offsetInFirst = 0;
      }
    }

    const writtenNew = outIdx - prefixWritten;

    // Rampa lineal de entrada al comenzar/reanudar para evitar clic
    if (firstOut && writtenNew > 0) {
      firstOut = false;
      const ramp = Math.min(writtenNew, rampLength);
      for (let i = 0; i < ramp; i++) {
        output[prefixWritten + i] *= (i + 1) / ramp;
      }
    }

    // Underrun: se agotó el búfer a mitad del bloque -> rampa de salida + aumentar colchón parcial
    if (outIdx < len) {
      underruns++;
      partialBufferSamples = Math.min(maxPartialCap, partialBufferSamples + partialIncrement);
      started = false;
      if (writtenNew > 0) {
        const ramp = Math.min(writtenNew, rampLength);
        const startFade = outIdx - ramp;
        for (let i = 0; i < ramp; i++) {
          output[startFade + i] *= (ramp - i) / ramp;
        }
      }
    }

    totalAudioPlayedSec += len / sampleRate;
    actualAudioPlayedSec += outIdx / sampleRate;
    return outIdx;
  }

  function stats() {
    return {
      sampleRate,
      bufferedSamples: totalBuffered,
      bufferedMs: asMs(totalBuffered),
      started,
      minDelayMs: minDelaySec === Infinity ? 0 : Number((minDelaySec * 1000).toFixed(2)),
      maxDelayMs: Number((maxDelaySec * 1000).toFixed(2)),
      partialBufferMs: asMs(partialBufferSamples),
      maxBufferMs: asMs(maxBufferSamples),
      totalAudioPlayedSec: Number(totalAudioPlayedSec.toFixed(3)),
      actualAudioPlayedSec: Number(actualAudioPlayedSec.toFixed(3)),
      underruns,
      dropEvents,
      droppedSamples
    };
  }

  return {
    push,
    pull,
    reset,
    stats,
    canPlay,
    bufferedSamples: () => totalBuffered
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createAdaptiveJitterBuffer };
}
