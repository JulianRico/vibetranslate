import { UnsupportedFormatError } from './errors.js';

export const MIME_BY_FORMAT = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mp3',
  wav: 'audio/wav',
  text: 'text/plain',
});

const FORMAT_BY_EXT = { '.pdf': 'pdf', '.docx': 'docx', '.mp3': 'mp3', '.wav': 'wav', '.txt': 'text', '.md': 'text' };
const SUPPORTED = '.pdf, .docx, .mp3, .wav, .txt, .md';

function extOf(filename) {
  const m = /\.[^./\\]+$/.exec(String(filename ?? '').toLowerCase());
  return m ? m[0] : '';
}

const latin1 = (buf, from, to) => buf.toString('latin1', from, to);

function isId3(buf) {
  // ID3v2 header: "ID3", major 2..4, revision, flags, 4 sync-safe size bytes (< 0x80 each).
  return buf.length >= 10 && latin1(buf, 0, 3) === 'ID3' && buf[3] >= 2 && buf[3] <= 4 && buf[4] !== 0xff
    && [6, 7, 8, 9].every((i) => buf[i] < 0x80);
}

/** Identifies a binary format from its first bytes; null when there is no known signature. */
function sniff(buf) {
  if (buf.length >= 5 && latin1(buf, 0, 5) === '%PDF-') return 'pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  if (buf.length >= 12 && latin1(buf, 0, 4) === 'RIFF' && latin1(buf, 8, 12) === 'WAVE') return 'wav';
  if (isId3(buf)) return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/**
 * Decides the format from the file's bytes (never from what the client declares).
 * The extension must agree with the bytes; text files have no signature and rely on .txt/.md.
 * @returns {{format: 'pdf'|'docx'|'mp3'|'wav'|'text', mimeType: string}}
 */
export function detectFormat(buffer, filename) {
  const ext = extOf(filename);
  const byExt = FORMAT_BY_EXT[ext];
  const sig = sniff(buffer);
  const fail = (why) => new UnsupportedFormatError(`${why}. Formatos admitidos: ${SUPPORTED}`);
  const ok = (format) => ({ format, mimeType: MIME_BY_FORMAT[format] });

  if (sig === 'zip') {
    if (byExt !== 'docx') throw fail('Solo se admiten archivos ZIP con extensión .docx');
    return ok('docx');
  }
  if (sig) {
    if (byExt && byExt !== sig) throw fail(`La extensión ${ext} no coincide con el contenido del archivo (${sig})`);
    return ok(sig);
  }
  if (byExt === 'text') return ok('text');
  if (byExt) throw fail(`El contenido del archivo no corresponde a un ${ext}`);
  throw fail('No se reconoce el formato del archivo');
}
