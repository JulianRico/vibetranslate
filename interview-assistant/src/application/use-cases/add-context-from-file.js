import {
  LIMITS, assertKind, defaultKind, normalizeText, createContextItem, sanitizeName, toSummary,
} from '../../domain/context-item.js';
import { detectFormat } from '../../domain/file-format.js';
import { PayloadTooLargeError, UnsupportedFormatError, ValidationError } from '../../domain/errors.js';

const SOURCE_BY_FORMAT = { pdf: 'pdf', docx: 'docx', mp3: 'audio', wav: 'audio', text: 'text' };

/**
 * Extracts the text of an uploaded file and stores it as a context item. The original file is never stored.
 * @param {{contextRepo: import('../ports.js').ContextRepository, extractors: import('../ports.js').DocumentExtractor[], ids: import('../ports.js').IdGenerator, clock: import('../ports.js').Clock}} deps
 */
export function createAddContextFromFile({ contextRepo, extractors, ids, clock }) {
  return async function addContextFromFile({ buffer, filename, kind, signal }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new ValidationError('El archivo está vacío');
    if (buffer.length > LIMITS.MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeError(
        `El archivo supera ${LIMITS.MAX_UPLOAD_BYTES / 1024 / 1024} MB. Caben unos 12 minutos de MP3 o unos 6 de WAV 16 kHz mono; comprime el audio a MP3 si es más largo.`,
      );
    }
    if ((await contextRepo.list()).length >= LIMITS.MAX_ITEMS) {
      throw new ValidationError(`Máximo ${LIMITS.MAX_ITEMS} elementos de contexto; borra alguno primero`);
    }
    const { format } = detectFormat(buffer, filename);
    const extractor = extractors.find((e) => e.supports(format));
    if (!extractor) throw new UnsupportedFormatError(`No hay extractor para el formato ${format}`);
    const source = SOURCE_BY_FORMAT[format];
    const chosenKind = kind === undefined || kind === null || kind === '' ? defaultKind(source) : assertKind(kind);

    const { text: raw, warnings: fromExtractor = [] } = await extractor.extract({ buffer, filename, format, signal });
    const { text, warnings } = normalizeText(raw);
    const item = createContextItem({
      id: ids.next(), name: sanitizeName(filename), kind: chosenKind, source, text,
      warnings: [...fromExtractor, ...warnings], now: clock.now(),
    });
    await contextRepo.add(item);
    return toSummary(item);
  };
}
