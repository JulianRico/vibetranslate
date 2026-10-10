import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextExtractor } from '../../src/infrastructure/extractors/text-extractor.js';
import { createMediaExtractor } from '../../src/infrastructure/extractors/media-extractor.js';
import { createExtractors } from '../../src/infrastructure/extractors/registry.js';
import { NotConfiguredError, ValidationError } from '../../src/domain/errors.js';
import { createFakeLlm } from '../support/fakes.js';

test('text extractor decodes UTF-8 (accents and a BOM)', async () => {
  const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Ingeniería — año 2024', 'utf8')]);
  const out = await createTextExtractor().extract({ buffer });
  assert.equal(out.text, 'Ingeniería — año 2024');
});

test('text extractor refuses binary data and invalid UTF-8', async () => {
  const ex = createTextExtractor();
  await assert.rejects(ex.extract({ buffer: Buffer.from([0x68, 0x00, 0x69]) }), /binarios/);
  await assert.rejects(ex.extract({ buffer: Buffer.from([0xc3, 0x28]) }), ValidationError);
});

test('media extractor sends PDFs to the LLM with the document instruction', async () => {
  const llm = createFakeLlm({ text: 'Texto del PDF' });
  const buffer = Buffer.from('%PDF-1.7');
  const out = await createMediaExtractor({ llm }).extract({ buffer, filename: 'a.pdf', format: 'pdf' });
  assert.equal(out.text, 'Texto del PDF');
  const call = llm.calls.extractText[0];
  assert.equal(call.mimeType, 'application/pdf');
  assert.equal(call.data, buffer);
  assert.match(call.instruction, /Extract all the text/);
});

test('media extractor sends audio with the transcription instruction and the right MIME type', async () => {
  const llm = createFakeLlm({ text: 'Speaker 1: hello' });
  const ex = createMediaExtractor({ llm });
  const ctl = new AbortController();
  await ex.extract({ buffer: Buffer.from('x'), filename: 'a.mp3', format: 'mp3', signal: ctl.signal });
  await ex.extract({ buffer: Buffer.from('x'), filename: 'a.wav', format: 'wav' });
  assert.equal(llm.calls.extractText[0].mimeType, 'audio/mp3');
  assert.equal(llm.calls.extractText[1].mimeType, 'audio/wav');
  assert.match(llm.calls.extractText[0].instruction, /Transcribe this audio verbatim/);
  assert.equal(llm.calls.extractText[0].signal, ctl.signal);
});

test('media extractor fails clearly without an API key and never calls the LLM', async () => {
  const llm = createFakeLlm({ configured: false });
  await assert.rejects(
    createMediaExtractor({ llm }).extract({ buffer: Buffer.from('x'), format: 'pdf' }),
    (e) => e instanceof NotConfiguredError && /PDF requiere GEMINI_API_KEY/.test(e.message),
  );
  assert.equal(llm.calls.extractText.length, 0);
});

test('registry covers every format the domain can detect', () => {
  const extractors = createExtractors({ llm: createFakeLlm() });
  for (const format of ['pdf', 'docx', 'mp3', 'wav', 'text']) {
    assert.equal(extractors.filter((e) => e.supports(format)).length, 1, format);
  }
  assert.equal(extractors.some((e) => e.supports('png')), false);
});
