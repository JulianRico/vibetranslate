import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openZip } from '../../src/infrastructure/extractors/zip-reader.js';
import { createDocxExtractor } from '../../src/infrastructure/extractors/docx-extractor.js';
import { UnsupportedFormatError } from '../../src/domain/errors.js';
import { buildZip, makeDocx, para } from '../support/make-docx.js';

const extractor = createDocxExtractor();
const extract = (buffer) => extractor.extract({ buffer, filename: 'cv.docx', format: 'docx' });

test('zip-reader reads stored and deflated entries and lists names', () => {
  const zip = openZip(buildZip([{ name: 'a.txt', data: 'hola', method: 0 }, { name: 'dir/b.txt', data: 'mundo '.repeat(50), method: 8 }]));
  assert.deepEqual(zip.names, ['a.txt', 'dir/b.txt']);
  assert.equal(zip.read('a.txt').toString(), 'hola');
  assert.equal(zip.read('dir/b.txt').toString(), 'mundo '.repeat(50));
  assert.equal(zip.read('missing.txt'), null);
  assert.equal(zip.has('a.txt'), true);
});

test('zip-reader rejects things that are not zips', () => {
  assert.throws(() => openZip(Buffer.from('definitely not a zip file at all')), UnsupportedFormatError);
  assert.throws(() => openZip(Buffer.alloc(5)), UnsupportedFormatError);
});

test('zip-reader refuses unknown compression methods', () => {
  const zip = buildZip([{ name: 'a.txt', data: 'hola', method: 0 }]);
  const patched = Buffer.from(zip);
  const central = patched.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  patched.writeUInt16LE(12, central + 10); // bzip2
  assert.throws(() => openZip(patched).read('a.txt'), /Método de compresión ZIP no soportado \(12\)/);
});

test('zip-reader defuses zip bombs regardless of what the headers claim', () => {
  const bomb = buildZip([{ name: 'big.txt', data: Buffer.alloc(5 * 1024 * 1024, 65), method: 8 }]);
  assert.throws(() => openZip(bomb).read('big.txt', { maxBytes: 1000 }), UnsupportedFormatError);

  // Headers lie: they claim 10 bytes, the stream inflates to 5 MiB.
  const liar = Buffer.from(bomb);
  const central = liar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  liar.writeUInt32LE(10, central + 24);
  assert.throws(() => openZip(liar).read('big.txt', { maxBytes: 1000 }), UnsupportedFormatError);
});

test('docx: one line per paragraph, empty paragraphs kept as blank lines', async () => {
  const { text, warnings } = await extract(makeDocx(`${para('Julian Quintero')}<w:p></w:p>${para('Full Stack ', 'Lead')}`));
  assert.equal(text, 'Julian Quintero\n\nFull Stack Lead');
  assert.deepEqual(warnings, []);
});

test('docx: decodes XML entities, smart quotes and numeric references', async () => {
  const { text } = await extract(makeDocx(para('Tom &amp; Jerry &lt;3 &quot;quoted&quot; It&#x2019;s &#8220;fine&#8221; caf&#233;')));
  assert.equal(text, 'Tom & Jerry <3 "quoted" It’s “fine” café');
});

test('docx: tabs and line breaks inside a paragraph', async () => {
  const { text } = await extract(makeDocx('<w:p><w:r><w:t>Nombre</w:t><w:tab/><w:t>Julian</w:t><w:br/><w:t>Colombia</w:t></w:r></w:p>'));
  assert.equal(text, 'Nombre\tJulian\nColombia');
});

test('docx: table rows become "cell | cell" lines and multi-paragraph cells are joined', async () => {
  const table = `<w:tbl><w:tr><w:tc>${para('Rol')}</w:tc><w:tc>${para('Empresa')}</w:tc></w:tr>`
    + `<w:tr><w:tc>${para('Lead')}</w:tc><w:tc>${para('Acme')}${para('Remoto')}</w:tc></w:tr></w:tbl>${para('Fin')}`;
  const { text } = await extract(makeDocx(table));
  assert.equal(text, 'Rol | Empresa\nLead | Acme Remoto\nFin');
});

test('docx: field codes and other elements are not mixed into the text', async () => {
  const { text } = await extract(makeDocx('<w:p><w:r><w:instrText> HYPERLINK "http://x" </w:instrText></w:r><w:r><w:t>Visible</w:t></w:r></w:p>'));
  assert.equal(text, 'Visible');
});

test('docx: warns when headers, footers or images exist but are not read', async () => {
  const { warnings } = await extract(makeDocx(para('x'), { extraEntries: [{ name: 'word/header1.xml', data: '<w:hdr/>' }] }));
  assert.deepEqual(warnings, ['partial']);
});

test('docx: a zip without word/document.xml is not a DOCX', async () => {
  await assert.rejects(extract(buildZip([{ name: 'hello.txt', data: 'hi' }])), /falta word\/document\.xml/);
});

test('docx: a corrupted deflate stream is reported, not thrown raw', async () => {
  const docx = makeDocx(para('x'));
  const patched = Buffer.from(docx);
  const at = patched.indexOf(Buffer.from('word/document.xml')) + 'word/document.xml'.length;
  patched.fill(0xff, at, at + 8);
  await assert.rejects(extract(patched), UnsupportedFormatError);
});

test('docx extractor only supports docx', () => {
  assert.equal(extractor.supports('docx'), true);
  assert.equal(extractor.supports('pdf'), false);
});
