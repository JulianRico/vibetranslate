import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter, reply, STATUS_BY_CODE } from '../../src/interface/http/router.js';
import { createStaticHandler } from '../../src/interface/http/static-files.js';
import { readBody, readJson } from '../../src/interface/http/body.js';
import {
  ForbiddenError, NotConfiguredError, NotFoundError, PayloadTooLargeError, UnsupportedFormatError, UpstreamError, ValidationError,
} from '../../src/domain/errors.js';

async function serve(routes, { staticHandler, logger = { error() {} } } = {}) {
  const server = http.createServer(createRouter({ routes, staticHandler, logger }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

test('routes by method and path, passes :params (decoded) and the query string', async () => {
  const app = await serve([
    { method: 'GET', path: '/api/things/:id', handler: async ({ params, url }) => reply({ id: params.id, q: url.searchParams.get('q') }) },
  ]);
  try {
    const res = await fetch(`${app.base}/api/things/a%20b?q=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { id: 'a b', q: '1' });
    assert.equal((await fetch(`${app.base}/api/things/x`, { method: 'DELETE' })).status, 404);
  } finally { await app.close(); }
});

test('maps every domain error code to its HTTP status with { error, code }', async () => {
  const cases = [
    [new ValidationError('v'), 400, 'VALIDATION'], [new NotFoundError('n'), 404, 'NOT_FOUND'],
    [new PayloadTooLargeError('p'), 413, 'PAYLOAD_TOO_LARGE'], [new UnsupportedFormatError('u'), 415, 'UNSUPPORTED_FORMAT'],
    [new NotConfiguredError('c'), 503, 'NOT_CONFIGURED'], [new UpstreamError('g'), 502, 'UPSTREAM'], [new ForbiddenError('x'), 403, 'FORBIDDEN'],
  ];
  const app = await serve(cases.map(([err], i) => ({ method: 'GET', path: `/api/e${i}`, handler: async () => { throw err; } })));
  try {
    for (const [i, [err, status, code]] of cases.entries()) {
      const res = await fetch(`${app.base}/api/e${i}`);
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), { error: err.message, code });
    }
    assert.equal(Object.keys(STATUS_BY_CODE).length, 7);
  } finally { await app.close(); }
});

test('unexpected errors become a generic 500 and never leak their message', async () => {
  const logged = [];
  const app = await serve([{ method: 'GET', path: '/api/boom', handler: async () => { throw new Error('secret db password'); } }], { logger: { error: (e) => logged.push(e) } });
  try {
    const res = await fetch(`${app.base}/api/boom`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Internal error', code: 'INTERNAL' });
    assert.equal(logged.length, 1);
  } finally { await app.close(); }
});

test('unknown /api paths are JSON 404s; a null body is an empty 204', async () => {
  const app = await serve([{ method: 'DELETE', path: '/api/x/:id', handler: async () => reply(null, 204) }]);
  try {
    const missing = await fetch(`${app.base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'NOT_FOUND');
    const del = await fetch(`${app.base}/api/x/1`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal(await del.text(), '');
  } finally { await app.close(); }
});

test('a malformed percent-encoding in a param is a 400, not a crash', async () => {
  const app = await serve([{ method: 'GET', path: '/api/t/:id', handler: async () => reply({}) }]);
  try {
    assert.equal((await fetch(`${app.base}/api/t/%E0%A4%A`)).status, 400);
  } finally { await app.close(); }
});

test('the handler signal aborts when the client disconnects', async () => {
  let seen;
  const app = await serve([{
    method: 'GET', path: '/api/slow',
    handler: ({ signal }) => new Promise((resolve) => { seen = signal; signal.addEventListener('abort', () => resolve(reply({}))); }),
  }]);
  try {
    const ctl = new AbortController();
    const pending = fetch(`${app.base}/api/slow`, { signal: ctl.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.aborted, true);
  } finally { await app.close(); }
});

test('readJson: invalid JSON and non-objects are 400-class validation errors; empty body is {}', async () => {
  const app = await serve([{ method: 'POST', path: '/api/j', handler: async ({ req }) => reply(await readJson(req)) }]);
  try {
    const post = (body) => fetch(`${app.base}/api/j`, { method: 'POST', body });
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.deepEqual(await (await post('{"a":1}')).json(), { a: 1 });
    assert.deepEqual(await (await post('')).json(), {});
  } finally { await app.close(); }
});

test('readBody enforces the limit while reading and still delivers a 413 (declared and undeclared sizes)', async () => {
  const app = await serve([{ method: 'POST', path: '/api/up', handler: async ({ req }) => reply({ bytes: (await readBody(req, 1000)).length }) }]);
  try {
    const ok = await fetch(`${app.base}/api/up`, { method: 'POST', body: Buffer.alloc(900) });
    assert.deepEqual(await ok.json(), { bytes: 900 });
    const drained = await fetch(`${app.base}/api/up`, { method: 'POST', body: Buffer.alloc(3000) });
    assert.equal(drained.status, 413, 'between 1x and 4x the limit: drained, then 413');
    assert.equal((await drained.json()).code, 'PAYLOAD_TOO_LARGE');
    const declared = await fetch(`${app.base}/api/up`, { method: 'POST', body: Buffer.alloc(5000) });
    assert.equal(declared.status, 413, 'over 4x the limit: refused as soon as the cap is reached');
    const chunked = await fetch(`${app.base}/api/up`, {
      method: 'POST', duplex: 'half',
      body: new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(Buffer.alloc(500)); c.close(); } }),
    });
    assert.equal(chunked.status, 413);
  } finally { await app.close(); }
});

test('static handler serves files from the public dir, with CSP on HTML, and nothing outside it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-static-'));
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hola</h1>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(publicDir, 'sub', 'index.html'), '<h1>sub</h1>');
  fs.writeFileSync(path.join(root, 'secret.html'), 'TOP SECRET');
  fs.writeFileSync(path.join(publicDir, 'data.json'), '{}');
  const app = await serve([], { staticHandler: createStaticHandler(publicDir) });
  try {
    const home = await fetch(`${app.base}/`);
    assert.equal(await home.text(), '<h1>hola</h1>');
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const js = await fetch(`${app.base}/app.js`);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    assert.equal(js.headers.get('content-security-policy'), null);
    assert.equal(await (await fetch(`${app.base}/sub/`)).text(), '<h1>sub</h1>');
    assert.equal((await fetch(`${app.base}/..%2fsecret.html`)).status, 404);
    assert.equal((await fetch(`${app.base}/%2e%2e/secret.html`)).status, 404);
    assert.equal((await fetch(`${app.base}/..%5csecret.html`)).status, 404);
    assert.equal((await fetch(`${app.base}/data.json`)).status, 404, 'unknown types are not served');
    assert.equal((await fetch(`${app.base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${app.base}/`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${app.base}/%00`)).status, 404);
  } finally { await app.close(); }
});

/** Raw request so the test controls Host and Origin (fetch does not let a page set them). */
function rawRequest(base, { method = 'GET', path = '/api/ping', headers = {} } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a Host that is not localhost is refused before anything runs (DNS rebinding)', async () => {
  let ran = 0;
  const app = await serve([{ method: 'GET', path: '/api/ping', handler: async () => { ran++; return reply({ ok: true }); } }]);
  const port = new URL(app.base).port;
  try {
    for (const host of ['rebind.evil.example', 'rebind.evil.example:' + port, '127.0.0.1.evil.example', 'localhost.evil.example:80']) {
      const res = await rawRequest(app.base, { headers: { host } });
      assert.equal(res.status, 403, host);
      assert.equal(JSON.parse(res.body).code, 'FORBIDDEN');
    }
    assert.equal(ran, 0, 'the handler never ran');
    for (const host of ['127.0.0.1:' + port, 'localhost:' + port, 'LOCALHOST:' + port, '[::1]:' + port]) {
      assert.equal((await rawRequest(app.base, { headers: { host } })).status, 200, host);
    }
  } finally { await app.close(); }
});

test('a request from another site (foreign Origin) is refused; same-origin and Origin-less requests pass', async () => {
  let ran = 0;
  const app = await serve([{ method: 'POST', path: '/api/ping', handler: async () => { ran++; return reply({ ok: true }); } }]);
  const port = new URL(app.base).port;
  const host = '127.0.0.1:' + port;
  try {
    for (const origin of ['https://evil.example', 'null', 'http://localhost:9999', 'http://' + host + '.evil.example', 'http://127.0.0.1']) {
      const res = await rawRequest(app.base, { method: 'POST', headers: { host, origin } });
      assert.equal(res.status, 403, origin);
      assert.equal(JSON.parse(res.body).code, 'FORBIDDEN');
    }
    assert.equal(ran, 0, 'no foreign request reached the handler');
    assert.equal((await rawRequest(app.base, { method: 'POST', headers: { host, origin: 'http://' + host } })).status, 200);
    assert.equal((await rawRequest(app.base, { method: 'POST', headers: { host } })).status, 200);
    assert.equal(ran, 2);
  } finally { await app.close(); }
});
