import zlib from 'node:zlib';
import { UnsupportedFormatError } from '../../domain/errors.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

const invalid = () => new UnsupportedFormatError('El archivo ZIP/DOCX está dañado o no es válido');

function findEndOfCentralDirectory(buf) {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new UnsupportedFormatError('No es un archivo ZIP/DOCX válido');
}

/**
 * Minimal read-only ZIP reader (stored and deflate entries, no ZIP64).
 * Decompression is capped at `maxBytes` per entry to defuse zip bombs, whatever the headers claim.
 */
export function openZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new UnsupportedFormatError('Los ZIP64 no están soportados');

  const entries = new Map();
  let p = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIG) throw invalid();
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    entries.set(buffer.toString('utf8', p + 46, p + 46 + nameLength), {
      method: buffer.readUInt16LE(p + 10),
      compressedSize: buffer.readUInt32LE(p + 20),
      size: buffer.readUInt32LE(p + 24),
      localOffset: buffer.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    /** Contents of an entry, or null when it does not exist. */
    read(name, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.size > maxBytes) throw new UnsupportedFormatError('El contenido del archivo es demasiado grande al descomprimirlo');
      const at = entry.localOffset;
      if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LOCAL_SIG) throw invalid();
      const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
      const raw = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return Buffer.from(raw);
      if (entry.method === 8) {
        try {
          return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
        } catch {
          throw new UnsupportedFormatError('El contenido del archivo está dañado o es demasiado grande al descomprimirlo');
        }
      }
      throw new UnsupportedFormatError(`Método de compresión ZIP no soportado (${entry.method})`);
    },
  };
}
