import { ValidationError } from '../../domain/errors.js';

/** Plain text and Markdown: decodes strict UTF-8 and refuses binary data. */
export function createTextExtractor() {
  return {
    supports: (format) => format === 'text',
    async extract({ buffer }) {
      if (buffer.includes(0)) throw new ValidationError('El archivo contiene datos binarios, no es texto');
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), warnings: [] };
      } catch {
        throw new ValidationError('El archivo no es texto UTF-8 válido');
      }
    },
  };
}
