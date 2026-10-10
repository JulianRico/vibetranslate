import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tinyPdf, toneWav } from '../../scripts/fixtures.js';
import { detectFormat } from '../../src/domain/file-format.js';

test('tinyPdf is recognized as a PDF and its xref offsets point at the objects', () => {
  const pdf = tinyPdf('Hello Julian Quintero');
  assert.equal(detectFormat(pdf, 'x.pdf').format, 'pdf');
  const text = pdf.toString('latin1');
  assert.match(text, /\(Hello Julian Quintero\) Tj/);
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(xrefAt).startsWith('xref\n'));
  const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});

test('toneWav is a valid 16 kHz mono PCM WAV of the requested length', () => {
  const wav = toneWav({ seconds: 2 });
  assert.equal(detectFormat(wav, 'x.wav').format, 'wav');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 2 * 16000 * 2);
  assert.equal(wav.length, 44 + 2 * 16000 * 2);
});
