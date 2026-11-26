/**
 * audio-worklet-processor.js - Procesadores AudioWorklet en hilo de tiempo real
 * =============================================================================
 * 1. `vibe-capture-processor`: reemplaza a `ScriptProcessorNode` para capturar
 *    micrófono, loopback de reunión, validador de hardware y clonación de voz
 *    fuera del hilo principal de UI (cero cortes por repintados del DOM).
 * 2. `vibe-playback-processor`: reproductor continuo con Jitter Buffer adaptativo
 *    híbrido inspirado en NVIDIA PersonaPlex (Moshi) + Higurashi AI Haru-4B:
 *    - Rampas anti-click (~8 ms) en inicio, underruns y barge-in.
 *    - Compresión temporal WSOLA (`wsolaCompress`, 10 %–20 % sin cambio de tono):
 *      ¿Por qué? Recupera el tiempo real tras ráfagas de red acelerando suavemente
 *      el habla con correlación cruzada de fase en lugar de recortar sílabas.
 *    - Auto-encogimiento del colchón tras 15 s sin cortes (`shrinkAfterSec = 15`):
 *      ¿Por qué? Evita que un pico aislado de red degrade la latencia durante el
 *      resto de una reunión larga.
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

/**
 * Acorta un bloque PCM en una fracción `rate` (0..0.25) conservando el tono vocal
 * mediante WSOLA (ventanas Hann al 50 % + búsqueda de correlación cruzada).
 */
function wsolaCompressWorklet(samples, rate, winSamples, tolSamples) {
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

  for (let i = 0; i < hop; i++) {
    const r = (i + 1) / hop;
    const tailIdx = outLen - hop + i;
    y[tailIdx] = y[tailIdx] * (1 - r) + samples[n - hop + i] * r;
  }

  return y;
}

function createWorkletJitterBuffer(sr, opts = {}) {
  const asSamples = (ms) => Math.max(1, Math.round((ms * sr) / 1000));
  const asMs = (samples) => Number(((samples * 1000) / sr).toFixed(2));

  const initialBufferSamples = asSamples(opts.initialMs ?? 80);
  const basePartialSamples = asSamples(opts.partialMs ?? 10);
  const baseMaxBufferSamples = asSamples(opts.maxBufferMs ?? 10);
  const partialIncrement = asSamples(opts.incrementMs ?? 5);
  const maxPartialCap = asSamples(opts.maxPartialMs ?? 80);
  const maxBufferIncrement = asSamples(opts.maxIncrementMs ?? 5);
  const maxBufferCap = asSamples(opts.maxCapMs ?? 80);
  const rampLength = asSamples(opts.rampMs ?? 8);

  // Parámetros WSOLA + auto-encogimiento de colchón (Haru-4B)
  const enableWsola = opts.enableWsola !== false;
  const catchupDeadbandSamples = asSamples(opts.catchupDeadbandMs ?? 15);
  const catchupFastAboveSamples = asSamples(opts.catchupFastAboveMs ?? 150);
  const catchupWinSamples = Math.max(4, asSamples(opts.catchupWinMs ?? 10));
  const catchupTolSamples = Math.max(1, asSamples(opts.catchupTolMs ?? 2.5));
  const minQueueWindowSamples = asSamples(opts.minQueueWindowMs ?? 333);
  const shrinkAfterSamples = Math.max(1, Math.round((opts.shrinkAfterSec ?? 15) * sr));
  const wsolaHeadroomSamples = asSamples(opts.wsolaHeadroomMs ?? 180);

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

  let minQueueCur = Infinity;
  let minQueuePrev = Infinity;
  let minWindowLeft = minQueueWindowSamples;
  let cleanSamplesSinceUnderrun = 0;

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

  function peekSamples(maxCount) {
    const out = new Float32Array(maxCount);
    let copied = 0;
    let idx = 0;
    let off = offsetInFirst;
    while (copied < maxCount && idx < frames.length) {
      const buf = frames[idx];
      const take = Math.min(buf.length - off, maxCount - copied);
      out.set(buf.subarray(off, off + take), copied);
      copied += take;
      idx++;
      off = 0;
    }
    return out.subarray(0, copied);
  }

  return {
    reset(smooth = true) {
      if (smooth && started && totalBuffered > 0) {
        const rawTail = peekSamples(Math.min(rampLength, totalBuffered));
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
    },

    push(rawFrame) {
      if (!rawFrame || rawFrame.length === 0) return;
      let frame = rawFrame;

      // Si sobra cola de forma sostenida durante reproducción activa, WSOLA acorta un 10 %-20 %
      // sin cambiar el tono vocal para recuperar el tiempo real sin cortar sílabas.
      if (enableWsola && started && actualAudioPlayedSec > 0) {
        const recentMin = Math.min(minQueueCur, minQueuePrev);
        const observedMin = Number.isFinite(recentMin) ? recentMin : totalBuffered;
        const excess = observedMin - (initialBufferSamples + partialBufferSamples);
        if (excess > catchupDeadbandSamples && frame.length >= 4 * catchupWinSamples) {
          const cap = excess > catchupFastAboveSamples ? 0.20 : 0.10;
          const shortened = wsolaCompressWorklet(
            frame,
            Math.min(cap, excess / frame.length),
            catchupWinSamples,
            catchupTolSamples
          );
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

      const headroom = (enableWsola && started && actualAudioPlayedSec > 0) ? wsolaHeadroomSamples : 0;
      const limit = initialBufferSamples + partialBufferSamples + maxBufferSamples + headroom;
      if (totalBuffered > limit) {
        const target = initialBufferSamples + partialBufferSamples;
        let removed = 0;
        while (totalBuffered > target && frames.length > 0) {
          const first = frames[0];
          const toDrop = Math.min(first.length - offsetInFirst, totalBuffered - target);
          offsetInFirst += toDrop;
          totalBuffered -= toDrop;
          removed += toDrop;
          if (offsetInFirst >= first.length) {
            frames.shift();
            offsetInFirst = 0;
          }
        }
        if (removed > 0) {
          dropEvents++;
          droppedSamples += removed;
          firstOut = true;
        }
        maxBufferSamples = Math.min(maxBufferCap, maxBufferSamples + maxBufferIncrement);
      }
    },

    pull(output) {
      const len = output.length;
      output.fill(0);
      let prefix = 0;
      if (fadeOutTail && fadeOutOffset < fadeOutTail.length) {
        const take = Math.min(len, fadeOutTail.length - fadeOutOffset);
        output.set(fadeOutTail.subarray(fadeOutOffset, fadeOutOffset + take), 0);
        fadeOutOffset += take;
        prefix = take;
        if (fadeOutOffset >= fadeOutTail.length) {
          fadeOutTail = null;
          fadeOutOffset = 0;
        }
        if (prefix === len) {
          totalAudioPlayedSec += len / sr;
          actualAudioPlayedSec += len / sr;
          return true;
        }
      }

      const canPlay = started && totalBuffered > 0 && remainingPartialSamples <= 0;
      if (!canPlay) {
        if (actualAudioPlayedSec > 0) totalAudioPlayedSec += (len - prefix) / sr;
        if (started && remainingPartialSamples > 0) {
          remainingPartialSamples = Math.max(0, remainingPartialSamples - (len - prefix));
        }
        return prefix > 0;
      }

      const queuedBeforePull = totalBuffered;
      const delaySec = queuedBeforePull / sr;
      maxDelaySec = Math.max(maxDelaySec, delaySec);
      minDelaySec = Math.min(minDelaySec, delaySec);

      let outIdx = prefix;
      while (outIdx < len && frames.length > 0) {
        const first = frames[0];
        const toCopy = Math.min(first.length - offsetInFirst, len - outIdx);
        output.set(first.subarray(offsetInFirst, offsetInFirst + toCopy), outIdx);
        offsetInFirst += toCopy;
        totalBuffered -= toCopy;
        outIdx += toCopy;
        if (offsetInFirst >= first.length) {
          frames.shift();
          offsetInFirst = 0;
        }
      }

      const writtenNew = outIdx - prefix;
      minQueueCur = Math.min(minQueueCur, queuedBeforePull);
      minWindowLeft -= writtenNew;
      if (minWindowLeft <= 0) {
        minQueuePrev = minQueueCur;
        minQueueCur = Infinity;
        minWindowLeft = minQueueWindowSamples;
      }

      if (firstOut && writtenNew > 0) {
        firstOut = false;
        const ramp = Math.min(writtenNew, rampLength);
        for (let i = 0; i < ramp; i++) {
          output[prefix + i] *= (i + 1) / ramp;
        }
      }

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
        // Devolver -5 ms de colchón parcial cada 15 s sin cortes para mantener latencia mínima
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

      totalAudioPlayedSec += len / sr;
      actualAudioPlayedSec += outIdx / sr;
      return outIdx > 0;
    },

    stats() {
      return {
        bufferedMs: asMs(totalBuffered),
        minDelayMs: minDelaySec === Infinity ? 0 : Number((minDelaySec * 1000).toFixed(2)),
        maxDelayMs: Number((maxDelaySec * 1000).toFixed(2)),
        partialBufferMs: asMs(partialBufferSamples),
        maxBufferMs: asMs(maxBufferSamples),
        compressedMs: asMs(compressedSamples),
        wsolaEvents,
        shrinkEvents,
        underruns,
        dropEvents,
        droppedSamples,
        isPlaying: started && totalBuffered > 0
      };
    }
  };
}

class VibeCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameSize = Math.max(128, Number(opts.frameSize) || 2048);
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
    this.active = true;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel = input[0];

    let readOffset = 0;
    while (readOffset < channel.length) {
      const space = this.frameSize - this.offset;
      const toCopy = Math.min(space, channel.length - readOffset);
      this.buffer.set(channel.subarray(readOffset, readOffset + toCopy), this.offset);
      this.offset += toCopy;
      readOffset += toCopy;

      if (this.offset >= this.frameSize) {
        const chunk = this.buffer;
        this.port.postMessage({ type: 'samples', samples: chunk }, [chunk.buffer]);
        this.buffer = new Float32Array(this.frameSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

class VibePlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.jb = createWorkletJitterBuffer(sampleRate, opts);
    this.gain = typeof opts.gain === 'number' ? opts.gain : 1.0;
    this.frameCounter = 0;
    this.wasPlaying = false;
    this.active = true;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'push' && msg.samples) {
        const samples = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples);
        this.jb.push(samples);
      } else if (msg.type === 'reset') {
        this.jb.reset(msg.smooth !== false);
      } else if (msg.type === 'gain') {
        this.gain = Math.max(0, Math.min(2, Number(msg.value) || 0));
      } else if (msg.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(inputs, outputs) {
    if (!this.active) return false;
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const ch0 = output[0];
    const hasAudio = this.jb.pull(ch0);
    if (hasAudio && this.gain !== 1.0) {
      for (let i = 0; i < ch0.length; i++) {
        ch0[i] *= this.gain;
      }
    }
    for (let c = 1; c < output.length; c++) {
      output[c].set(ch0);
    }

    const st = this.jb.stats();
    if (st.isPlaying !== this.wasPlaying) {
      this.wasPlaying = st.isPlaying;
      this.port.postMessage({ type: 'state', isPlaying: st.isPlaying, stats: st });
    }

    this.frameCounter++;
    if (this.frameCounter >= 75) {
      this.frameCounter = 0;
      this.port.postMessage({ type: 'stats', stats: st });
    }
    return true;
  }
}

registerProcessor('vibe-capture-processor', VibeCaptureProcessor);
registerProcessor('vibe-playback-processor', VibePlaybackProcessor);
