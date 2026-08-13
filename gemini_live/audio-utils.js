/**
 * audio-utils.js - Utilidades de Conversión y Resampling de Audio para Gemini Live
 * =================================================================================
 * Gemini Multimodal Live API requiere:
 *   - Entrada: PCM de 16kHz, 16 bits, Mono (Little-Endian) codificado en Base64.
 *   - Salida:  PCM de 24kHz, 16 bits, Mono (Little-Endian) codificado en Base64.
 */

/**
 * Convierte un Float32Array de WebAudio a PCM 16-bit (Int16Array / ArrayBuffer).
 */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // true = Little-Endian
  }
  return buffer;
}

/**
 * Re-muestrea un Float32Array del sample rate de entrada (ej. 44.1k o 48k) a 16kHz.
 */
function resampleTo16kHZ(float32Array, inputSampleRate = 48000) {
  if (inputSampleRate === 16000) return float32Array;

  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(float32Array.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const originIdx = i * ratio;
    const idx = Math.floor(originIdx);
    const decimal = originIdx - idx;

    const nextIdx = idx + 1 < float32Array.length ? idx + 1 : idx;
    result[i] = float32Array[idx] * (1 - decimal) + float32Array[nextIdx] * decimal;
  }

  return result;
}

/**
 * Convierte un ArrayBuffer a String Base64.
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convierte String Base64 a Uint8Array.
 */
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convierte PCM de 24kHz 16-bit Mono (retornado por Gemini Live) a un AudioBuffer de WebAudio.
 */
function pcm24kToAudioBuffer(audioCtx, pcm24kArrayBuffer) {
  const dataView = new DataView(pcm24kArrayBuffer);
  const numSamples = pcm24kArrayBuffer.byteLength / 2;
  const audioBuffer = audioCtx.createBuffer(1, numSamples, 24000);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < numSamples; i++) {
    const int16 = dataView.getInt16(i * 2, true); // Little-Endian
    channelData[i] = int16 < 0 ? int16 / 32768.0 : int16 / 32767.0;
  }

  return audioBuffer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    floatTo16BitPCM,
    resampleTo16kHZ,
    arrayBufferToBase64,
    base64ToUint8Array,
    pcm24kToAudioBuffer
  };
}
