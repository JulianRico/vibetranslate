/**
 * adaptive-jitter-buffer.js - Jitter Buffer Adaptativo con WSOLA y Rampas Anti-Click
 * ==================================================================================
 * Combina lo mejor de dos arquitecturas full-duplex de referencia:
 *
 * 1. NVIDIA PersonaPlex / Moshi (MIT):
 *    - Arranque con latencia mínima configurable (80 ms + 10 ms de colchón parcial).
 *    - Si ocurre un corte de red (underrun), aplica rampa fade-out y aumenta el
 *      colchón parcial (+5 ms hasta un tope de 80 ms).
 *    - Rampas lineales por muestra (~8 ms) al iniciar, reanudar o interrumpir
 *      (barge-in / reset) para eliminar chasquidos en auriculares y CABLE Output.
 *
 * 2. Higurashi AI Haru-4B (Apache 2.0) — Mejoras de calidad y latencia sostenida:
 *    - Compresión temporal WSOLA (`wsolaCompress`, Waveform Similarity Overlap-Add):
 *      ¿POR QUÉ LO HACEMOS? Cuando ocurre un micro-corte de Wi-Fi/red seguido de una
 *      ráfaga de paquetes, hacer "hard-drop" (descartar muestras viejas de golpe)
 *      corta sílabas o consonantes de la traducción en curso. Con WSOLA acortamos
 *      cada bloque entrante un 10 %–20 % alineando ciclos vocales por correlación
 *      cruzada con ventanas Hann al 50 % de solapamiento: recuperamos la latencia de
 *      tiempo real SIN cambiar el tono de la voz (sin efecto "ardilla") y SIN perder
 *      palabras, reservando el descarte duro solo para atrasos extremos.
 *    - Ventana deslizante de cola mínima (`recentMinQueue`, ~666 ms):
 *      ¿POR QUÉ LO HACEMOS? Medir el tamaño del búfer justo al llegar un paquete daría
 *      falsos excesos de cola. Observar el mínimo sostenido en dos sub-ventanas de
 *      ~333 ms garantiza que WSOLA solo actúe cuando realmente sobra audio acumulado.
 *    - Auto-encogimiento gradual del colchón (`shrinkAfterSec = 15 s`):
 *      ¿POR QUÉ LO HACEMOS? Si hubo un único hipo de red al inicio de una llamada de
 *      1 hora, mantener para siempre el margen extra añade latencia innecesaria ("deuda
 *      permanente de latencia"). Tras 15 s continuos de reproducción limpia sin
 *      underruns, devolvemos gradualmente -5 ms hasta volver al mínimo base.
 */

/**
 * Acorta `samples` en una fracción `rate` (0 < rate <= 0.25) SIN alterar el tono vocal
 * mediante WSOLA (Waveform Similarity Overlap-Add).
 *
 * ¿Por qué así?:
 * - La primera mitad de la primera ventana es plana (peso 1.0) para conservar intacta
 *   la frontera izquierda con el bloque de audio anterior.
 * - En cada salto (`hop = win / 2`), buscamos alrededor de la posición nominal acelerada
 *   (`±tolSamples`) el segmento con mayor correlación cruzada respecto a la continuación
 *   natural del ciclo de voz anterior, evitando cancelaciones de fase o clics metálicos.
 * - El último `hop` hace crossfade hacia las muestras finales originales para que el
 *   siguiente paquete entrante empalme sin discontinuidad.
 *
 * @param {Float32Array} samples Muestras de entrada en [-1, 1]
 * @param {number} rate Fracción a recortar (ej. 0.10 = 10 % más corto)
 * @param {number} winSamples Tamaño de ventana Hann (~10 ms)
 * @param {number} tolSamples Margen de búsqueda de fase (~2.5 ms)
 * @returns {Float32Array}
 */
function wsolaCompress(samples, rate, winSamples, tolSamples) {
  const n = samples ? samples.length : 0;
  const clampedRate = Math.min(0.25, Math.max(0, Number(rate) || 0));
  const win = Math.max(4, winSamples | 0);
  const hop = win >> 1;
  const tol = Math.max(1, tolSamples | 0);
  const outLen = Math.round(n * (1 - clampedRate));

  if (clampedRate <= 0 || hop < 2 || n < 4 * win || outLen <= win || outLen >= n) {
    return samples;
  }

  const speed = n / outLen;
  const out = new Float32Array(outLen + win);
  const wsum = new Float32Array(outLen + win);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);
  }

  // Primera ventana: mitad inicial plana (1.0) para empalme exacto al inicio
  for (let i = 0; i < win; i++) {
    const wi = i < hop ? 1 : hann[i];
    out[i] += samples[i] * wi;
    wsum[i] += wi;
  }

  let prev = 0;
  for (let k = 1; k * hop + hop <= outLen; k++) {
    const nominal = Math.round(k * hop * speed);
    const natural = prev + hop;
    const hi = Math.min(n - win, nominal + tol);
    const lo = Math.min(Math.max(0, nominal - tol), hi);
    let best = nominal >= lo && nominal <= hi ? nominal : lo;

    if (natural + win <= n) {
      let bestCorr = -Infinity;
      for (let c = lo; c <= hi; c++) {
        let corr = 0;
        for (let i = 0; i < win; i++) {
          corr += samples[c + i] * samples[natural + i];
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          best = c;
        }
      }
    }

    const dstBase = k * hop;
    for (let i = 0; i < win; i++) {
      out[dstBase + i] += samples[best + i] * hann[i];
      wsum[dstBase + i] += hann[i];
    }
    prev = best;
  }

  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    y[i] = wsum[i] > 1e-3 ? out[i] / wsum[i] : 0;
  }

  // Último hop: fundido cruzado hacia la cola real del bloque para continuidad perfecta
  for (let i = 0; i < hop; i++) {
    const r = (i + 1) / hop;
    const tailIdx = outLen - hop + i;
    y[tailIdx] = y[tailIdx] * (1 - r) + samples[n - hop + i] * r;
  }

  return y;
}

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

  // Parámetros WSOLA y recuperación elástica inspirados en Haru-4B (`playout.py` / `audio-processor.ts`)
  const enableWsola = options.enableWsola !== false;
  const catchupDeadbandSamples = asSamples(options.catchupDeadbandMs ?? 15);
  const catchupFastAboveSamples = asSamples(options.catchupFastAboveMs ?? 150);
  const catchupWinSamples = Math.max(4, asSamples(options.catchupWinMs ?? 10));
  const catchupTolSamples = Math.max(1, asSamples(options.catchupTolMs ?? 2.5));
  const minQueueWindowSamples = asSamples(options.minQueueWindowMs ?? 333);
  const shrinkAfterSamples = Math.max(1, Math.round((options.shrinkAfterSec ?? 15) * sampleRate));

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

  // Estado de ventana mínima de cola y contador de estabilidad sin cortes
  let minQueueCur = Infinity;
  let minQueuePrev = Infinity;
  let minWindowLeft = minQueueWindowSamples;
  let cleanSamplesSinceUnderrun = 0;

  // Telemetría de salud acústica
  let totalAudioPlayedSec = 0;
  let actualAudioPlayedSec = 0;
  let compressedSamples = 0;
  let wsolaEvents = 0;
  let shrinkEvents = 0;
  let minDelaySec = Infinity;
  let maxDelaySec = 0;
  let underruns = 0;
  let dropEvents = 0;
  let droppedSamples = 0;

  function catchupTargetSamples() {
    return initialBufferSamples + partialBufferSamples;
  }

  function totalMaxBufferSamples() {
    // Cuando WSOLA está activo y ya estamos reproduciendo, permitimos un techo duro mayor
    // para darle margen a WSOLA de absorber la ráfaga comprimiendo sin cortar sílabas;
    // antes de arrancar (actualAudioPlayedSec === 0) se respeta el techo estricto inicial.
    const wsolaHeadroom = (enableWsola && started && actualAudioPlayedSec > 0)
      ? asSamples(options.wsolaHeadroomMs ?? 180)
      : 0;
    return initialBufferSamples + partialBufferSamples + maxBufferSamples + wsolaHeadroom;
  }

  function recentMinQueue() {
    return Math.min(minQueueCur, minQueuePrev);
  }

  function trackMinQueue(queuedBeforePull, playedNow) {
    minQueueCur = Math.min(minQueueCur, queuedBeforePull);
    minWindowLeft -= playedNow;
    if (minWindowLeft <= 0) {
      minQueuePrev = minQueueCur;
      minQueueCur = Infinity;
      minWindowLeft = minQueueWindowSamples;
    }
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
    minQueueCur = Infinity;
    minQueuePrev = Infinity;
    minWindowLeft = minQueueWindowSamples;
    cleanSamplesSinceUnderrun = 0;
  }

  function push(inputSamples) {
    if (!inputSamples || inputSamples.length === 0) return;
    let frame = inputSamples instanceof Float32Array
      ? inputSamples
      : Float32Array.from(inputSamples);

    // 1. Recuperación suave por WSOLA (Haru-4B):
    // Si ya estamos en reproducción activa y la cola mínima reciente supera el objetivo + banda muerta,
    // comprimimos el nuevo bloque un 10 % (o 20 % si el exceso pasa de 150 ms) preservando el tono,
    // en lugar de mutilar palabras con un recorte brusco.
    if (enableWsola && started && actualAudioPlayedSec > 0) {
      const observedMin = Number.isFinite(recentMinQueue()) ? recentMinQueue() : totalBuffered;
      const excess = observedMin - catchupTargetSamples();
      if (excess > catchupDeadbandSamples && frame.length >= 4 * catchupWinSamples) {
        const cap = excess > catchupFastAboveSamples ? 0.20 : 0.10;
        const rate = Math.min(cap, excess / frame.length);
        const shortened = wsolaCompress(frame, rate, catchupWinSamples, catchupTolSamples);
        const removed = frame.length - shortened.length;
        if (removed > 0) {
          compressedSamples += removed;
          wsolaEvents++;
          frame = shortened;
        }
      }
    }

    frames.push(frame);
    totalBuffered += frame.length;

    if (totalBuffered >= initialBufferSamples && !started) {
      started = true;
      remainingPartialSamples = partialBufferSamples;
      firstOut = true;
    }

    // 2. Válvula de seguridad dura (hard-drop):
    // Solo se dispara en el arranque ante ráfagas gigantes o si una desconexión severa
    // supera incluso el margen elástico de WSOLA.
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

    const queuedBeforePull = totalBuffered;
    const delaySec = queuedBeforePull / sampleRate;
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
    trackMinQueue(queuedBeforePull, writtenNew);

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
      cleanSamplesSinceUnderrun = 0;
      partialBufferSamples = Math.min(maxPartialCap, partialBufferSamples + partialIncrement);
      started = false;
      if (writtenNew > 0) {
        const ramp = Math.min(writtenNew, rampLength);
        const startFade = outIdx - ramp;
        for (let i = 0; i < ramp; i++) {
          output[startFade + i] *= (ramp - i) / ramp;
        }
      }
    } else if (writtenNew > 0) {
      // Auto-encogimiento (Haru-4B `shrink_after_s`):
      // Tras 15 s continuos de audio fluido sin cortes, devolvemos gradualmente -5 ms
      // de margen parcial para no arrastrar latencia extra el resto de la reunión.
      cleanSamplesSinceUnderrun += writtenNew;
      if (cleanSamplesSinceUnderrun >= shrinkAfterSamples) {
        cleanSamplesSinceUnderrun = 0;
        if (partialBufferSamples > basePartialSamples) {
          partialBufferSamples = Math.max(basePartialSamples, partialBufferSamples - partialIncrement);
          shrinkEvents++;
        }
        if (maxBufferSamples > baseMaxBufferSamples) {
          maxBufferSamples = Math.max(baseMaxBufferSamples, maxBufferSamples - maxBufferIncrement);
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
      compressedSamples,
      compressedMs: asMs(compressedSamples),
      wsolaEvents,
      shrinkEvents,
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
  module.exports = { createAdaptiveJitterBuffer, wsolaCompress };
}
