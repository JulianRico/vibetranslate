import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, MIME_BY_FORMAT } from '../../src/domain/file-format.js';
import { UnsupportedFormatError } from '../../src/domain/errors.js';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
const MP3_ID3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x00]);
const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]);

test('detects each supported format from its bytes', () => {
  assert.deepEqual(detectFormat(PDF, 'oferta.pdf'), { format: 'pdf', mimeType: MIME_BY_FORMAT.pdf });
  assert.equal(detectFormat(ZIP, 'cv.docx').format, 'docx');
  assert.equal(detectFormat(WAV, 'nota.wav').format, 'wav');
  assert.equal(detectFormat(MP3_ID3, 'charla.mp3').format, 'mp3');
  assert.equal(detectFormat(MP3_FRAME, 'charla.mp3').format, 'mp3');
  assert.equal(detectFormat(Buffer.from('hola'), 'notas.md').format, 'text');
  assert.equal(detectFormat(Buffer.from('hola'), 'NOTAS.TXT').format, 'text');
});

test('maps formats to the MIME types Gemini expects', () => {
  assert.equal(MIME_BY_FORMAT.pdf, 'application/pdf');
  assert.equal(MIME_BY_FORMAT.mp3, 'audio/mp3');
  assert.equal(MIME_BY_FORMAT.wav, 'audio/wav');
});

test('rejects an executable renamed to .pdf', () => {
  assert.throws(() => detectFormat(Buffer.from('MZ\x90\x00\x03'), 'virus.pdf'), UnsupportedFormatError);
});

test('rejects a ZIP that is not named .docx', () => {
  assert.throws(() => detectFormat(ZIP, 'datos.zip'), UnsupportedFormatError);
});

test('rejects bytes that disagree with the extension', () => {
  assert.throws(() => detectFormat(PDF, 'notas.txt'), UnsupportedFormatError);
  assert.throws(() => detectFormat(WAV, 'charla.mp3'), UnsupportedFormatError);
});

test('rejects unknown extensions and files without a signature', () => {
  assert.throws(() => detectFormat(Buffer.from('abc'), 'foto.png'), UnsupportedFormatError);
  assert.throws(() => detectFormat(Buffer.from('abc'), 'sin-extension'), UnsupportedFormatError);
});

test('a text file that merely starts with "ID3" is still text', () => {
  assert.equal(detectFormat(Buffer.from('ID3 tags notes for the interview'), 'ideas.txt').format, 'text');
});

test('error messages list the supported formats', () => {
  assert.throws(() => detectFormat(Buffer.from('abc'), 'foto.png'), /\.pdf, \.docx, \.mp3, \.wav, \.txt, \.md/);
});
