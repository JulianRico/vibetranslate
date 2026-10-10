import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../server.js';
import { createFakeLlm } from '../support/fakes.js';

const GOOD = {
  questionEs: '¿Por qué nosotros?', intent: 'motivación',
  points: [{ en: 'Leading and building', es: 'Liderar y construir' }],
  answer: { en: 'I want to lead and build with .NET and Azure.', es: 'Quiero liderar y construir con .NET y Azure.' },
};

const llm = createFakeLlm({ json: GOOD });
let server;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-prepared-http-'));
  server = buildApp({ env: {}, llm, dataDir: path.join(dir, 'data'), publicDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

const call = (method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('the first GET seeds the starter bank: 31 templates with their answers', async () => {
  const res = await call('GET', '/api/prepared');
  assert.equal(res.status, 200);
  const { items } = await res.json();
  assert.equal(items.length, 31);
  assert.ok(items.every((i) => i.status === 'template' && i.answer?.en && i.triggers.length > 0));
  assert.ok(items.some((i) => i.id === 'tell-me-about-yourself'));
});

test('add a question: 201 with p_ id and empty status; invalid input is 400', async () => {
  const res = await call('POST', '/api/prepared', { question: 'Tell me about Kubernetes', triggers: ['kubernetes', 'kubernetes experience'] });
  assert.equal(res.status, 201);
  const item = await res.json();
  assert.match(item.id, /^p_[0-9a-f]{8}$/);
  assert.deepEqual([item.status, item.answer], ['empty', null]);
  assert.equal((await call('POST', '/api/prepared', { question: '', triggers: ['x'] })).status, 400);
  assert.equal((await call('POST', '/api/prepared', { question: 'Q', triggers: [] })).status, 400);
  assert.equal((await call('POST', '/api/prepared', 'no es objeto')).status, 400);
});

test('edit an answer: 200 and the item becomes edited; unknown id is 404; invalid edit is 400', async () => {
  const res = await call('PATCH', '/api/prepared/strengths', { answer: { en: 'My own strengths.', es: 'Mis propias fortalezas.' } });
  assert.equal(res.status, 200);
  const item = await res.json();
  assert.deepEqual([item.status, item.answer.en], ['edited', 'My own strengths.']);
  assert.equal((await call('PATCH', '/api/prepared/nope', { question: 'x' })).status, 404);
  assert.equal((await call('PATCH', '/api/prepared/strengths', { answer: { en: 'solo inglés' } })).status, 400);
  const { items } = await (await call('GET', '/api/prepared')).json();
  assert.equal(items.find((i) => i.id === 'strengths').answer.en, 'My own strengths.', 'the failed edit changed nothing');
});

test('generate: the coach answers the question itself and the item becomes generated', async () => {
  const before = llm.calls.generateJson.length;
  const res = await call('POST', '/api/prepared/why-this-job/generate');
  assert.equal(res.status, 200);
  const item = await res.json();
  assert.deepEqual([item.status, item.answer, item.points], ['generated', GOOD.answer, GOOD.points]);
  assert.ok(item.generatedAt);
  assert.equal(llm.calls.generateJson.length, before + 1);
  assert.match(llm.calls.generateJson.at(-1).prompt, /Why do you want this job\?/);
});

test('generate protects an edited answer: 400 without force, 200 with ?force=1', async () => {
  const refused = await call('POST', '/api/prepared/strengths/generate');
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /editaste tú/);
  const forced = await call('POST', '/api/prepared/strengths/generate?force=1');
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).status, 'generated');
});

test('generate: unknown id is 404 and a Gemini failure is 502 and leaves the item as it was', async () => {
  assert.equal((await call('POST', '/api/prepared/nope/generate')).status, 404);
  const original = llm.generateJson;
  llm.generateJson = async () => { throw Object.assign(new Error('Gemini HTTP 503: busy'), { code: 'UPSTREAM' }); };
  try {
    const res = await call('POST', '/api/prepared/leaving-current-job/generate');
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Gemini HTTP 503/);
  } finally { llm.generateJson = original; }
  const { items } = await (await call('GET', '/api/prepared')).json();
  assert.equal(items.find((i) => i.id === 'leaving-current-job').status, 'template');
});

test('delete: 204, then 404', async () => {
  assert.equal((await call('DELETE', '/api/prepared/five-years')).status, 204);
  assert.equal((await call('DELETE', '/api/prepared/five-years')).status, 404);
  const { items } = await (await call('GET', '/api/prepared')).json();
  assert.equal(items.some((i) => i.id === 'five-years'), false);
});

test('without a Gemini key generating is 503, but listing and editing by hand still work', async () => {
  const noKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-prepared-nokey-'));
  const app = buildApp({ env: {}, dataDir: noKeyDir, publicDir: noKeyDir });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(`${b}/api/prepared`)).status, 200);
    const generate = await fetch(`${b}/api/prepared/strengths/generate`, { method: 'POST' });
    assert.equal(generate.status, 503);
    assert.match((await generate.json()).error, /GEMINI_API_KEY/);
    const edit = await fetch(`${b}/api/prepared/strengths`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: { en: 'Mine', es: 'Mía' } }) });
    assert.equal(edit.status, 200);
  } finally {
    await new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); });
  }
});

test('a cross-site write to the prepared answers is refused (Host/Origin guard)', async () => {
  const url = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method: 'POST', path: '/api/prepared',
      headers: { host: url.host, origin: 'https://evil.example', 'content-type': 'text/plain' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ question: 'Planted', triggers: ['planted'] }));
  });
  assert.equal(status, 403);
  const { items } = await (await call('GET', '/api/prepared')).json();
  assert.equal(items.some((i) => i.question === 'Planted'), false);
});
