/**
 * audio-worklet-processor.js - Procesadores AudioWorklet en hilo de tiempo real
 * =============================================================================
 * 1. `vibe-capture-processor`: reemplaza a `ScriptProcessorNode` para capturar
 *    micrófono, loopback de reunión, validador de hardware y clonación de voz
 *    fuera del hilo principal de UI (cero cortes por repintados del DOM).
 * 2. `vibe-playback-processor`: reproductor continuo con Jitter Buffer adaptativo
 *    inspirado en NVIDIA PersonaPlex / Moshi (auto-ajuste de colchón, descarte
 *    inteligente de retraso acumulado y rampas anti-click en interrupciones).
 */

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

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

  let totalAudioPlayedSec = 0;
  let actualAudioPlayedSec = 0;
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
    },

    push(frame) {
      if (!frame || frame.length === 0) return;
      frames.push(frame);
      totalBuffered += frame.length;
      if (totalBuffered >= initialBufferSamples && !started) {
        started = true;
        remainingPartialSamples = partialBufferSamples;
        firstOut = true;
      }
      const limit = initialBufferSamples + partialBufferSamples + maxBufferSamples;
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

      const delaySec = totalBuffered / sr;
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
      if (firstOut && writtenNew > 0) {
        firstOut = false;
        const ramp = Math.min(writtenNew, rampLength);
        for (let i = 0; i < ramp; i++) {
          output[prefix + i] *= (i + 1) / ramp;
        }
      }

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
    this.jitter = createWorkletJitterBuffer(sampleRate, opts);
    this.quantaCounter = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'push' && msg.samples) {
        const arr = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples);
        this.jitter.push(arr);
      } else if (msg.type === 'reset') {
        this.jitter.reset(msg.smooth !== false);
      } else if (msg.type === 'stats') {
        this.port.postMessage({ type: 'metrics', stats: this.jitter.stats() });
      } else if (msg.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(_inputs, outputs) {
    if (!this.active) return false;
    const outChannel = outputs[0] && outputs[0][0];
    if (!outChannel) return true;
    this.jitter.pull(outChannel);
    this.quantaCounter++;
    if (this.quantaCounter >= 75) { // cada ~400 ms a 24 kHz
      this.quantaCounter = 0;
      this.port.postMessage({ type: 'metrics', stats: this.jitter.stats() });
    }
    return true;
  }
}

registerProcessor('vibe-capture-processor', VibeCaptureProcessor);
registerProcessor('vibe-playback-processor', VibePlaybackProcessor);
