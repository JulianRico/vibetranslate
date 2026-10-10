import { NotConfiguredError } from '../../domain/errors.js';
import { MIME_BY_FORMAT } from '../../domain/file-format.js';

const INSTRUCTION = {
  pdf: 'Extract all the text of this document in reading order, preserving headings and lists. '
    + 'If pages are scanned images, apply OCR. Do not add comments, summaries or explanations; output only the document text.',
  audio: 'Transcribe this audio verbatim in its original language. If there are several speakers, label them Speaker 1, Speaker 2, and so on. '
    + 'Do not add comments or summaries; output only the transcript.',
};

/** PDF, MP3 and WAV: Gemini reads the file and returns its text (this is the only part that needs the network). */
export function createMediaExtractor({ llm }) {
  return {
    supports: (format) => format === 'pdf' || format === 'mp3' || format === 'wav',
    async extract({ buffer, format, signal }) {
      if (!llm.isConfigured()) {
        throw new NotConfiguredError(`Procesar archivos ${format.toUpperCase()} requiere GEMINI_API_KEY en el servidor`);
      }
      const text = await llm.extractText({
        mimeType: MIME_BY_FORMAT[format],
        data: buffer,
        instruction: format === 'pdf' ? INSTRUCTION.pdf : INSTRUCTION.audio,
        signal,
      });
      return { text, warnings: [] };
    },
  };
}
