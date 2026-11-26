/**
 * personaplex-protocol.js - Codec Binario de 1 Byte y Catálogo de Voces PersonaPlex
 * =================================================================================
 * Compatible a nivel de byte con `NVIDIA/personaplex` (`moshi.server` + `protocol/types.ts`):
 *   0x00 : Handshake [0x00, version=0, model=0] (el servidor puede enviar 1 byte [0x00])
 *   0x01 : Audio Frame [0x01, ...bytes] (Opus o PCM16 a 24 kHz, cero sobrecoste Base64)
 *   0x02 : Text Token  [0x02, ...utf8Bytes] (tokens de texto generados en simultáneo)
 *   0x03 : Control     [0x03, actionByte] (0=start, 1=endTurn, 2=pause, 3=restart)
 *   0x04 : Metadata    [0x04, ...utf8Json]
 *   0x05 : Error       [0x05, ...utf8Error]
 *   0x06 : Ping        [0x06]
 */

const MSG_HANDSHAKE = 0x00;
const MSG_AUDIO = 0x01;
const MSG_TEXT = 0x02;
const MSG_CONTROL = 0x03;
const MSG_METADATA = 0x04;
const MSG_ERROR = 0x05;
const MSG_PING = 0x06;

const CONTROL_CODES = {
  start: 0x00,
  endTurn: 0x01,
  pause: 0x02,
  restart: 0x03
};

const CODE_TO_CONTROL = {
  0x00: 'start',
  0x01: 'endTurn',
  0x02: 'pause',
  0x03: 'restart'
};

/** Las 18 voces pre-entrenadas oficiales de NVIDIA PersonaPlex (NAT = conversacional natural, VAR = variada). */
const PERSONAPLEX_VOICES = [
  { id: 'NATF2', file: 'NATF2.pt', gender: 'female', group: 'NAT', label: 'NATF2 · Femenina natural, cálida y ejecutiva' },
  { id: 'NATM1', file: 'NATM1.pt', gender: 'male', group: 'NAT', label: 'NATM1 · Masculina natural, clara y técnica' },
  { id: 'NATF0', file: 'NATF0.pt', gender: 'female', group: 'NAT', label: 'NATF0 · Femenina natural, serena (HR / Discovery)' },
  { id: 'NATF1', file: 'NATF1.pt', gender: 'female', group: 'NAT', label: 'NATF1 · Femenina natural, dinámica (Product / Agile)' },
  { id: 'NATF3', file: 'NATF3.pt', gender: 'female', group: 'NAT', label: 'NATF3 · Femenina natural, directa (VP / Dirección)' },
  { id: 'NATM0', file: 'NATM0.pt', gender: 'male', group: 'NAT', label: 'NATM0 · Masculina natural, cercana (Colaborativo)' },
  { id: 'NATM2', file: 'NATM2.pt', gender: 'male', group: 'NAT', label: 'NATM2 · Masculina natural, analítica (Staff Engineer)' },
  { id: 'NATM3', file: 'NATM3.pt', gender: 'male', group: 'NAT', label: 'NATM3 · Masculina natural, firme (Ejecutivo / C-Level)' },
  { id: 'VARF0', file: 'VARF0.pt', gender: 'female', group: 'VAR', label: 'VARF0 · Femenina expresiva I' },
  { id: 'VARF1', file: 'VARF1.pt', gender: 'female', group: 'VAR', label: 'VARF1 · Femenina expresiva II' },
  { id: 'VARF2', file: 'VARF2.pt', gender: 'female', group: 'VAR', label: 'VARF2 · Femenina expresiva III' },
  { id: 'VARF3', file: 'VARF3.pt', gender: 'female', group: 'VAR', label: 'VARF3 · Femenina expresiva IV' },
  { id: 'VARF4', file: 'VARF4.pt', gender: 'female', group: 'VAR', label: 'VARF4 · Femenina expresiva V' },
  { id: 'VARM0', file: 'VARM0.pt', gender: 'male', group: 'VAR', label: 'VARM0 · Masculina expresiva I' },
  { id: 'VARM1', file: 'VARM1.pt', gender: 'male', group: 'VAR', label: 'VARM1 · Masculina expresiva II' },
  { id: 'VARM2', file: 'VARM2.pt', gender: 'male', group: 'VAR', label: 'VARM2 · Masculina expresiva III' },
  { id: 'VARM3', file: 'VARM3.pt', gender: 'male', group: 'VAR', label: 'VARM3 · Masculina expresiva IV' },
  { id: 'VARM4', file: 'VARM4.pt', gender: 'male', group: 'VAR', label: 'VARM4 · Masculina expresiva V' }
];

function normalizeVoicePromptFile(voiceId = 'NATF2') {
  const clean = String(voiceId || 'NATF2').trim();
  if (!clean) return 'NATF2.pt';
  if (clean.endsWith('.pt') || clean.endsWith('.wav')) return clean;
  return `${clean}.pt`;
}

function pickVoiceForSetup(setup = {}) {
  if (setup.personaplexVoice && setup.personaplexVoice !== 'auto') {
    return normalizeVoicePromptFile(setup.personaplexVoice);
  }
  const name = String(setup?.playbook?.interlocutor?.name || '').toLowerCase();
  const femaleHint = /\b(sarah|emily|claire|rachel|hannah|laura|elena|maya|sophia|olivia|priya|anna|jessica|kate|maria|nina|chloe)\b/.test(name);
  const maleHint = /\b(david|michael|james|alex|marcus|daniel|ryan|thomas|liam|ethan|noah|carlos|kevin|brian|andrew|jason)\b/.test(name);
  const level = String(setup.level || 'senior');

  if (femaleHint) {
    if (level === 'executive') return 'NATF3.pt';
    if (level === 'collaborative') return 'NATF0.pt';
    return 'NATF2.pt';
  }
  if (maleHint) {
    if (level === 'executive') return 'NATM3.pt';
    if (level === 'collaborative') return 'NATM0.pt';
    return 'NATM1.pt';
  }
  if (level === 'executive') return 'NATM3.pt';
  if (level === 'collaborative') return 'NATF0.pt';
  return 'NATF2.pt';
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data || []);
}

function encodeHandshake(version = 0, model = 0) {
  return Buffer.from([MSG_HANDSHAKE, version & 0xff, model & 0xff]);
}

function encodeAudioFrame(audioBytes) {
  const payload = toBuffer(audioBytes);
  const out = Buffer.allocUnsafe(1 + payload.length);
  out[0] = MSG_AUDIO;
  payload.copy(out, 1);
  return out;
}

function encodeTextToken(text) {
  const payload = Buffer.from(String(text ?? ''), 'utf8');
  const out = Buffer.allocUnsafe(1 + payload.length);
  out[0] = MSG_TEXT;
  payload.copy(out, 1);
  return out;
}

function encodeControl(action) {
  const code = typeof action === 'number' ? action : (CONTROL_CODES[action] ?? CONTROL_CODES.start);
  return Buffer.from([MSG_CONTROL, code & 0xff]);
}

function encodeMetadata(obj) {
  const payload = Buffer.from(JSON.stringify(obj ?? {}), 'utf8');
  const out = Buffer.allocUnsafe(1 + payload.length);
  out[0] = MSG_METADATA;
  payload.copy(out, 1);
  return out;
}

function encodeError(message) {
  const payload = Buffer.from(String(message || 'Unknown error'), 'utf8');
  const out = Buffer.allocUnsafe(1 + payload.length);
  out[0] = MSG_ERROR;
  payload.copy(out, 1);
  return out;
}

function encodePing() {
  return Buffer.from([MSG_PING]);
}

function decodeMessage(raw) {
  const buf = toBuffer(raw);
  if (buf.length === 0) return { type: 'empty' };
  const kind = buf[0];
  const body = buf.subarray(1);

  switch (kind) {
    case MSG_HANDSHAKE:
      return {
        type: 'handshake',
        version: body.length >= 1 ? body[0] : 0,
        model: body.length >= 2 ? body[1] : 0
      };
    case MSG_AUDIO:
      return { type: 'audio', data: body };
    case MSG_TEXT:
      return { type: 'text', data: body.toString('utf8') };
    case MSG_CONTROL: {
      const code = body.length >= 1 ? body[0] : 0;
      return { type: 'control', code, action: CODE_TO_CONTROL[code] || 'unknown' };
    }
    case MSG_METADATA: {
      const text = body.toString('utf8');
      try {
        return { type: 'metadata', data: JSON.parse(text) };
      } catch {
        return { type: 'metadata', data: text };
      }
    }
    case MSG_ERROR:
      return { type: 'error', data: body.toString('utf8') };
    case MSG_PING:
      return { type: 'ping' };
    default:
      return { type: 'unknown', kind, data: body };
  }
}

/** Envuelve el texto del rol con las etiquetas `<system> ... <system>` que exige PersonaPlex. */
function wrapSystemPrompt(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('<system>') && cleaned.endsWith('<system>')) return cleaned;
  return `<system> ${cleaned} <system>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MSG_HANDSHAKE,
    MSG_AUDIO,
    MSG_TEXT,
    MSG_CONTROL,
    MSG_METADATA,
    MSG_ERROR,
    MSG_PING,
    CONTROL_CODES,
    PERSONAPLEX_VOICES,
    normalizeVoicePromptFile,
    pickVoiceForSetup,
    encodeHandshake,
    encodeAudioFrame,
    encodeTextToken,
    encodeControl,
    encodeMetadata,
    encodeError,
    encodePing,
    decodeMessage,
    wrapSystemPrompt
  };
}
