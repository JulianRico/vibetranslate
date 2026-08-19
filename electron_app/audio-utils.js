/**
 * audio-utils.js - Utilidades de audio para conversión PCM de Gemini Live
 */

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function resampleTo16kHZ(audioBuffer, sampleRate = 48000) {
  if (sampleRate === 16000) return audioBuffer;
  const ratio = sampleRate / 16000;
  const newLength = Math.round(audioBuffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origIndex = Math.floor(i * ratio);
    result[i] = audioBuffer[origIndex] || 0;
  }
  return result;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function encodeWAV(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF identifier
  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, 36 + samples.length * 2, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"

  // fmt sub-chunk
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 mono)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample

  // data sub-chunk
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, samples.length * 2, true);

  // PCM data
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return buffer;
}

/**
 * Detecta si el texto devuelto por Whisper es una alucinación generada por silencio o ruido de fondo.
 */
function isWhisperHallucination(text) {
  if (!text || typeof text !== 'string') return true;
  const cleaned = text.trim();
  if (cleaned.length === 0) return true;

  // Si contiene solo caracteres especiales, puntos, espacios o corchetes de sonido
  if (/^[.\s\-–—,;:!¡?¿"'\(\)\[\]{}…*~_/\\]+$/.test(cleaned)) {
    return true;
  }

  // Notaciones de sonido o subtítulos automáticos ej. [Música], (Risas), [Aplausos], [silence]
  if (/^\[.+\]$/.test(cleaned) || /^\(.+\)$/.test(cleaned)) {
    return true;
  }

  // Normalizar: minúsculas, sin acentos para matching robusto, sin puntuación
  const normalized = cleaned
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes/diacríticos
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'¡¿♪…«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length === 0) return true;

  const hallucinationPatterns = [
    /^gracias$/,
    /^muchas gracias$/,
    /^muchas gracias por ver$/,
    /^muchas gracias por su atencion$/,
    /^gracias por ver$/,
    /^gracias por ver el video$/,
    /^gracias por ver el video$/,
    /^gracias por ver este video$/,
    /^gracias por su atencion$/,
    /^gracias por su tiempo$/,
    /^gracias a todos$/,
    /^thank you$/,
    /^thank you very much$/,
    /^thank you so much$/,
    /^thank you for watching$/,
    /^thank you for watching this video$/,
    /^thanks$/,
    /^thanks for watching$/,
    /^thanks for watching this video$/,
    /^subtitulos/i,
    /^amara\.?org/i,
    /^sous-titres/i,
    /^transcribed by/i,
    /^translated by/i,
    /^captions by/i,
    /^you$/,
    /^bye$/,
    /^goodbye$/,
    /^hello$/,
    /^mbc$/,
    /^mooji$/,
    /^silence$/,
    /^music$/,
    /^applause$/,
    /^laughter$/,
    /^cough$/
  ];

  for (const pattern of hallucinationPatterns) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    floatTo16BitPCM,
    resampleTo16kHZ,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    encodeWAV,
    isWhisperHallucination
  };
}


