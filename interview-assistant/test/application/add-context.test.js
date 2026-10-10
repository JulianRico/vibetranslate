import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAddContextFromFile } from '../../src/application/use-cases/add-context-from-file.js';
import { createAddContextFromText } from '../../src/application/use-cases/add-context-from-text.js';
import { LIMITS } from '../../src/domain/context-item.js';
import {
  NotConfiguredError, PayloadTooLargeError, UnsupportedFormatError, ValidationError,
} from '../../src/domain/errors.js';
import { createMemoryContextRepository, fakeExtractor, sequentialIds, fixedClock } from '../support/fakes.js';

const PDF = Buffer.from('%PDF-1.7 fake body');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);

function setup(extractors) {
  const contextRepo = createMemoryContextRepository();
  const ids = sequentialIds();
  const clock = fixedClock();
  return { contextRepo, add: createAddContextFromFile({ contextRepo, extractors, ids, clock }) };
}

test('stores the extracted text and returns a summary without the full text', async () => {
  const text = fakeExtractor({ formats: ['text'], result: { text: '  Hola mundo  ' } });
  const { add, contextRepo } = setup([text]);
  const out = await add({ buffer: Buffer.from('hola'), filename: '../../notas.md' });
  assert.equal('text' in out, false);
  assert.deepEqual(
    { id: out.id, name: out.name, kind: out.kind, source: out.source, chars: out.chars, active: out.active, preview: out.preview },
    { id: 'c_1', name: 'notas.md', kind: 'other', source: 'text', chars: 10, active: true, preview: 'Hola mundo' },
  );
  assert.equal((await contextRepo.get('c_1')).text, 'Hola mundo');
});

test('audio defaults to the transcript kind; an explicit kind wins', async () => {
  const media = fakeExtractor({ formats: ['pdf', 'wav'], result: { text: 'transcripción' } });
  const { add } = setup([media]);
  assert.equal((await add({ buffer: WAV, filename: 'charla.wav' })).kind, 'transcript');
  assert.equal((await add({ buffer: PDF, filename: 'oferta.pdf', kind: 'job' })).kind, 'job');
});

test('an invalid kind is rejected and nothing is stored', async () => {
  const { add, contextRepo } = setup([fakeExtractor({ formats: ['pdf'] })]);
  await assert.rejects(add({ buffer: PDF, filename: 'a.pdf', kind: 'secret' }), ValidationError);
  assert.deepEqual(await contextRepo.list(), []);
});

test('rejects empty files and files over the upload limit', async () => {
  const { add } = setup([fakeExtractor({ formats: ['text'] })]);
  await assert.rejects(add({ buffer: Buffer.alloc(0), filename: 'a.txt' }), ValidationError);
  await assert.rejects(add({ buffer: Buffer.alloc(LIMITS.MAX_UPLOAD_BYTES + 1, 97), filename: 'a.txt' }), PayloadTooLargeError);
});

test('rejects unsupported formats and formats without an extractor', async () => {
  const { add } = setup([fakeExtractor({ formats: ['text'] })]);
  await assert.rejects(add({ buffer: Buffer.from('MZ'), filename: 'virus.pdf' }), UnsupportedFormatError);
  await assert.rejects(add({ buffer: PDF, filename: 'a.pdf' }), UnsupportedFormatError);
});

test('rejects when the library is full', async () => {
  const { add } = setup([fakeExtractor({ formats: ['text'] })]);
  for (let i = 0; i < LIMITS.MAX_ITEMS; i++) await add({ buffer: Buffer.from(`t${i}`), filename: `n${i}.txt` });
  await assert.rejects(add({ buffer: Buffer.from('uno más'), filename: 'x.txt' }), /Máximo 20/);
});

test('files with no text are rejected with a clear message', async () => {
  const { add, contextRepo } = setup([fakeExtractor({ formats: ['pdf'], result: { text: '  \n ' } })]);
  await assert.rejects(add({ buffer: PDF, filename: 'vacio.pdf' }), /No se encontró texto/);
  assert.deepEqual(await contextRepo.list(), []);
});

test('merges extractor warnings with truncation warnings', async () => {
  const big = 'x'.repeat(LIMITS.MAX_ITEM_CHARS + 500);
  const { add } = setup([fakeExtractor({ formats: ['pdf'], result: { text: big, warnings: ['partial'] } })]);
  const out = await add({ buffer: PDF, filename: 'grande.pdf' });
  assert.deepEqual(out.warnings, ['partial', 'truncated']);
  assert.equal(out.chars, LIMITS.MAX_ITEM_CHARS);
});

test('extractor failures propagate and the abort signal reaches the extractor', async () => {
  const failing = fakeExtractor({ formats: ['pdf'], result: new NotConfiguredError('Falta GEMINI_API_KEY') });
  const { add } = setup([failing]);
  const ctl = new AbortController();
  await assert.rejects(add({ buffer: PDF, filename: 'a.pdf', signal: ctl.signal }), NotConfiguredError);
  assert.equal(failing.calls[0].signal, ctl.signal);
});

test('pasted text is stored with a default name and kind', async () => {
  const contextRepo = createMemoryContextRepository();
  const addText = createAddContextFromText({ contextRepo, ids: sequentialIds(), clock: fixedClock() });
  const out = await addText({ text: 'Oferta: Full Stack Lead', kind: 'job' });
  assert.equal(out.name, 'Texto pegado');
  assert.equal(out.kind, 'job');
  assert.equal(out.source, 'text');
});

test('pasted text rejects blanks and non-strings, and truncates very long text', async () => {
  const contextRepo = createMemoryContextRepository();
  const addText = createAddContextFromText({ contextRepo, ids: sequentialIds(), clock: fixedClock() });
  await assert.rejects(addText({ text: '   ' }), ValidationError);
  await assert.rejects(addText({ text: 42 }), ValidationError);
  const out = await addText({ text: 'y'.repeat(LIMITS.MAX_ITEM_CHARS + 1) });
  assert.deepEqual(out.warnings, ['truncated']);
});
