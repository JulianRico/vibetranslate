import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiGateway, parseJsonLoose } from '../../src/infrastructure/gemini-gateway.js';
import { NotConfiguredError, UpstreamError } from '../../src/domain/errors.js';

const KEY = 'AIzaSyFAKE-KEY-1234567890';

const reply = (text, extra = {}) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...extra }] }), { status: 200 });
const httpError = (status, message) => new Response(JSON.stringify({ error: { message } }), { status });

/** fetch double: each step is a Response, an Error to throw, or a function(url, init). Records the calls. */
function fakeFetch(...steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const step = steps.length > 1 ? steps.shift() : steps[0];
    const out = typeof step === 'function' ? await step(url, init) : step;
    if (out instanceof Error) throw out;
    return out.clone ? out.clone() : out;
  };
  fn.calls = calls;
  return fn;
}

const make = (fetchImpl, over = {}) => createGeminiGateway({ apiKey: KEY, fetchImpl, retryDelayMs: 1, ...over });

test('parseJsonLoose handles fences, prose around JSON, and rejects non-JSON', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! Here it is: {"a":1} Hope it helps'), { a: 1 });
  assert.deepEqual(parseJsonLoose('[1,2]'), [1, 2]);
  assert.throws(() => parseJsonLoose('no json here'));
});

test('generateJson sends the system prompt, JSON mode, temperature, output cap and no-thinking config', async () => {
  const f = fakeFetch(reply('{"ok":true}'));
  const out = await make(f).generateJson({ system: 'SYS', prompt: 'USER', temperature: 0.3 });
  assert.deepEqual(out, { ok: true });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.equal(body.systemInstruction.parts[0].text, 'SYS');
  assert.equal(body.contents[0].parts[0].text, 'USER');
  assert.deepEqual(body.generationConfig, {
    responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 },
  });
});

test('the model name is configurable and URL-encoded', async () => {
  const f = fakeFetch(reply('{}'));
  await make(f, { model: 'gemini 3/pro' }).generateJson({ system: 's', prompt: 'p' });
  assert.match(f.calls[0].url, /models\/gemini%203%2Fpro:generateContent$/);
});

test('generateJson accepts fenced JSON and JSON surrounded by prose', async () => {
  assert.deepEqual(await make(fakeFetch(reply('```json\n{"a":1}\n```'))).generateJson({ system: 's', prompt: 'p' }), { a: 1 });
  assert.deepEqual(await make(fakeFetch(reply('Here: {"a":2}'))).generateJson({ system: 's', prompt: 'p' }), { a: 2 });
});

test('unparseable output is flagged invalidOutput, and a cut-off reply says so', async () => {
  await assert.rejects(
    make(fakeFetch(reply('{"a": ', { finishReason: 'MAX_TOKENS' }))).generateJson({ system: 's', prompt: 'p' }),
    (e) => e instanceof UpstreamError && e.invalidOutput === true && /MAX_TOKENS/.test(e.message),
  );
});

test('an empty reply reports why (block reason or finish reason)', async () => {
  const blocked = new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 });
  await assert.rejects(make(fakeFetch(blocked)).generateJson({ system: 's', prompt: 'p' }), /SAFETY/);
});

test('extractText sends the file inline as base64 plus the instruction', async () => {
  const f = fakeFetch(reply('Texto extraído'));
  const out = await make(f).extractText({ mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7 hola'), instruction: 'Extract' });
  assert.equal(out, 'Texto extraído');
  const parts = f.calls[0].body.contents[0].parts;
  assert.deepEqual(parts[0].inlineData, { mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7 hola').toString('base64') });
  assert.equal(parts[1].text, 'Extract');
  assert.equal(f.calls[0].body.generationConfig.temperature, 0);
});

test('retries 429 and 5xx with backoff, then succeeds', async () => {
  const f = fakeFetch(httpError(429, 'quota'), httpError(503, 'busy'), reply('{"ok":1}'));
  assert.deepEqual(await make(f).generateJson({ system: 's', prompt: 'p' }), { ok: 1 });
  assert.equal(f.calls.length, 3);
});

test('gives up after the retries are exhausted, reporting Gemini’s message', async () => {
  const f = fakeFetch(httpError(503, 'The model is overloaded'));
  await assert.rejects(make(f).generateJson({ system: 's', prompt: 'p' }), /Gemini HTTP 503: The model is overloaded/);
  assert.equal(f.calls.length, 3);
});

test('does not retry client errors', async () => {
  const f = fakeFetch(httpError(400, 'API key not valid'));
  await assert.rejects(make(f).generateJson({ system: 's', prompt: 'p' }), /Gemini HTTP 400: API key not valid/);
  assert.equal(f.calls.length, 1);
});

test('the API key never appears in errors', async () => {
  const echoed = fakeFetch(httpError(400, `Invalid key ${KEY} for project`));
  await assert.rejects(make(echoed).generateJson({ system: 's', prompt: 'p' }), (e) => !e.message.includes(KEY) && e.message.includes('***'));
  const down = fakeFetch(new TypeError(`fetch failed for ${KEY}`));
  await assert.rejects(make(down).generateJson({ system: 's', prompt: 'p' }), (e) => !e.message.includes(KEY));
});

test('a model that rejects thinkingConfig is retried without it, and later calls omit it', async () => {
  const f = fakeFetch(httpError(400, 'Thinking is not supported for this model'), reply('{"a":1}'), reply('{"b":2}'));
  const gw = make(f);
  assert.deepEqual(await gw.generateJson({ system: 's', prompt: 'p' }), { a: 1 });
  assert.equal('thinkingConfig' in f.calls[1].body.generationConfig, false);
  await gw.generateJson({ system: 's', prompt: 'p' });
  assert.equal('thinkingConfig' in f.calls[2].body.generationConfig, false);
});

test('without an API key it is not configured and refuses to call', async () => {
  const f = fakeFetch(reply('{}'));
  const gw = createGeminiGateway({ apiKey: '', fetchImpl: f });
  assert.equal(gw.isConfigured(), false);
  await assert.rejects(gw.generateJson({ system: 's', prompt: 'p' }), NotConfiguredError);
  await assert.rejects(gw.extractText({ mimeType: 'audio/mp3', data: Buffer.from('x'), instruction: 'i' }), NotConfiguredError);
  assert.equal(f.calls.length, 0);
});

test('a caller abort surfaces as AbortError, not as an upstream failure', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const ctl = new AbortController();
  const pending = make(fakeFetch(hang)).generateJson({ system: 's', prompt: 'p', signal: ctl.signal });
  ctl.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('a request that takes too long fails with a clear upstream error', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(
    make(fakeFetch(hang), { timeoutMs: 20 }).generateJson({ system: 's', prompt: 'p' }),
    (e) => e instanceof UpstreamError && /tardó demasiado/.test(e.message),
  );
});
