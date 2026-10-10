import { createTextExtractor } from './text-extractor.js';
import { createDocxExtractor } from './docx-extractor.js';
import { createMediaExtractor } from './media-extractor.js';

/** All document extractors. To support a new format, add its extractor here and its signature in domain/file-format.js. */
export function createExtractors({ llm }) {
  return [createTextExtractor(), createDocxExtractor(), createMediaExtractor({ llm })];
}
