import { PayloadTooLargeError, ValidationError } from '../../domain/errors.js';

export const JSON_LIMIT_BYTES = 256 * 1024;

/** Past `maxBytes` the body is discarded (not buffered) up to this many times the limit, then the request is refused outright. */
const DRAIN_FACTOR = 4;

const human = (bytes) => (bytes >= 1024 * 1024 ? `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`);
const tooBig = (maxBytes) => new PayloadTooLargeError(`El cuerpo de la petición supera ${human(maxBytes)}`);

/**
 * Reads the whole request body, never holding more than `maxBytes` in memory.
 * An oversize body is drained and then rejected with PayloadTooLargeError: answering while the client is still
 * uploading would make it see a connection reset instead of the 413.
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let over = Number.isFinite(declared) && declared > maxBytes;
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (!over && size > maxBytes) {
        over = true;
        chunks.length = 0;
      }
      if (over) {
        if (size > maxBytes * DRAIN_FACTOR) reject(tooBig(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => (over ? reject(tooBig(maxBytes)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('request aborted')); });
  });
}

/** JSON object body (an empty body is `{}`). */
export async function readJson(req, maxBytes = JSON_LIMIT_BYTES) {
  const buffer = await readBody(req, maxBytes);
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ValidationError('El cuerpo no es JSON válido');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('El cuerpo debe ser un objeto JSON');
  }
  return parsed;
}
