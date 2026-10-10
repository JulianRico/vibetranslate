import { UnsupportedFormatError } from '../../domain/errors.js';
import { openZip } from './zip-reader.js';

const TOKEN = new RegExp([
  '<w:t(?:\\s[^>]*)?>([\\s\\S]*?)</w:t>', // 1: text run
  '<w:tab\\s*/>',
  '<w:br\\b[^>]*/>',
  '<w:cr\\s*/>',
  '</w:p>',
  '</w:tc>',
  '</w:tr>',
  '<w:tbl(?:\\s[^>]*)?>',
  '</w:tbl>',
].join('|'), 'g');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** WordprocessingML → plain text: one line per paragraph, table rows as "cell | cell | cell". */
function xmlToText(xml) {
  const lines = [];
  let current = '';
  let cells = [];
  let tableDepth = 0;
  for (const m of xml.matchAll(TOKEN)) {
    const tag = m[0];
    if (m[1] !== undefined) current += decodeEntities(m[1]);
    else if (/^<w:tab\s*\/>$/.test(tag)) current += '\t';
    else if (tag.startsWith('<w:br') || tag.startsWith('<w:cr')) current += '\n';
    else if (tag === '</w:p>') {
      if (tableDepth === 0) { lines.push(current); current = ''; } else current += ' ';
    } else if (tag === '</w:tc>') { cells.push(current.trim()); current = ''; }
    else if (tag === '</w:tr>') { lines.push(cells.join(' | ')); cells = []; current = ''; }
    else if (tag.startsWith('<w:tbl')) tableDepth++;
    else if (tag === '</w:tbl>') tableDepth = Math.max(0, tableDepth - 1);
  }
  if (current.trim()) lines.push(current);
  return lines.join('\n');
}

const PARTIAL_PARTS = /^word\/(header|footer|footnotes|endnotes|media\/)/;

/** Local DOCX reader: unzips word/document.xml with node:zlib. Headers, footers, notes and images are not read. */
export function createDocxExtractor() {
  return {
    supports: (format) => format === 'docx',
    async extract({ buffer }) {
      const zip = openZip(buffer);
      const xml = zip.read('word/document.xml');
      if (!xml) throw new UnsupportedFormatError('El archivo no parece un DOCX válido (falta word/document.xml)');
      const warnings = zip.names.some((n) => PARTIAL_PARTS.test(n)) ? ['partial'] : [];
      return { text: xmlToText(xml.toString('utf8')), warnings };
    },
  };
}
