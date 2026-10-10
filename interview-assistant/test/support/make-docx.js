import zlib from 'node:zlib';

/**
 * Builds a ZIP archive in memory. Each entry: { name, data (string|Buffer), method: 0 (stored) | 8 (deflate) }.
 * Used to create DOCX fixtures without committing binary files.
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A DOCX whose body is the given WordprocessingML fragment, plus optional extra zip entries. */
export function makeDocx(bodyXml, { extraEntries = [] } = {}) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}</w:body></w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: document },
    ...extraEntries,
  ]);
}

/** <w:p> with one run per text. */
export const para = (...texts) => `<w:p>${texts.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('')}</w:p>`;
