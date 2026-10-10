import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeTranslator } from '../../public/adapters/chrome-translator.js';
import { createHttpClient, createHttpSuggestionGateway, createHttpContextGateway } from '../../public/adapters/http-gateways.js';
import { createNanoSuggestionGateway, parseBullets } from '../../public/adapters/nano-suggestion-gateway.js';
import { scheduler } from '../../public/adapters/timers.js';
import { createFakeTranslator } from '../support/fakes-client.js';

/* ---------- chrome translator ---------- */

function fakeTranslatorWindow({ availability = 'available', createFails = false } = {}) {
  const seen = { availability: [], create: [] };
  return {
    seen,
    win: {
      Translator: {
        availability: async (pair) => { seen.availability.push(pair); return availability; },
        create: async (options) => {
          seen.create.push(options);
          if (createFails) throw new Error('NotAllowedError: needs user activation');
          const listeners = [];
          options.monitor({ addEventListener: (_, fn) => listeners.push(fn) });
          listeners.forEach((fn) => fn({ loaded: 0.4 }));
          return { translate: async (text) => `ES<${text}>` };
        },
      },
    },
  };
}

test('translator: checks en→es, creates the translator, reports progress and translates', async () => {
  const { win, seen } = fakeTranslatorWindow({ availability: 'downloadable' });
  const t = createChromeTranslator({ win });
  const states = [];
  t.onState((s) => states.push(s));
  await t.ensureReady();
  assert.deepEqual(seen.availability, [{ sourceLanguage: 'en', targetLanguage: 'es' }]);
  assert.equal(states.some((s) => s.status === 'downloading' && s.detail === '40 %'), true);
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(await t.translate('Hello'), 'ES<Hello>');
  await t.ensureReady();
  assert.equal(seen.create.length, 1, 'created only once');
});

test('translator: translate before ensureReady fails clearly', async () => {
  const t = createChromeTranslator({ win: fakeTranslatorWindow().win });
  await assert.rejects(t.translate('Hello'), /no está listo/);
});

test('translator: no API, unavailable pair and a failing create are reported', async () => {
  const none = createChromeTranslator({ win: {} });
  const states = [];
  none.onState((s) => states.push(s));
  await assert.rejects(none.ensureReady(), /no trae la API de traducción/);
  assert.equal(states.at(-1).status, 'unavailable');
  await assert.rejects(createChromeTranslator({ win: fakeTranslatorWindow({ availability: 'unavailable' }).win }).ensureReady(), /no está disponible/);
  const failing = createChromeTranslator({ win: fakeTranslatorWindow({ createFails: true }).win });
  const failStates = [];
  failing.onState((s) => failStates.push(s));
  await assert.rejects(failing.ensureReady(), /user activation/);
  assert.equal(failStates.at(-1).status, 'error');
});

/* ---------- http gateways ---------- */

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const out = await handler(url, init);
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('http: suggest posts JSON and returns the parsed answer', async () => {
  const f = fakeFetch(() => jsonResponse({ suggestion: { answer: { en: 'x', es: 'y' } } }));
  const gateway = createHttpSuggestionGateway(createHttpClient({ fetchImpl: f }));
  const ctl = new AbortController();
  const out = await gateway.suggest({ turns: ['Hi'], history: [] }, { signal: ctl.signal });
  assert.equal(out.suggestion.answer.en, 'x');
  assert.equal(f.calls[0].url, '/api/suggest');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { turns: ['Hi'], history: [] });
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(f.calls[0].init.signal, ctl.signal);
});

test('http: server errors surface the server message with status and code', async () => {
  const f = fakeFetch(() => jsonResponse({ error: 'Sin clave de Gemini', code: 'NOT_CONFIGURED' }, 503));
  const gateway = createHttpSuggestionGateway(createHttpClient({ fetchImpl: f }));
  await assert.rejects(gateway.suggest({}), (e) => e.message === 'Sin clave de Gemini' && e.status === 503 && e.code === 'NOT_CONFIGURED');
});

test('http: a non-JSON error body gives a generic message; a network failure explains how to fix it; aborts pass through', async () => {
  const gateway = (handler) => createHttpSuggestionGateway(createHttpClient({ fetchImpl: fakeFetch(handler) }));
  await assert.rejects(gateway(() => new Response('<html>oops</html>', { status: 500 })).suggest({}), /Error 500/);
  await assert.rejects(gateway(() => new TypeError('Failed to fetch')).suggest({}), /npm start/);
  await assert.rejects(gateway(() => Object.assign(new Error('aborted'), { name: 'AbortError' })).suggest({}), (e) => e.name === 'AbortError');
});

test('http context: list, config, profile and text go to the right endpoints', async () => {
  const f = fakeFetch(() => jsonResponse({ ok: true }));
  const g = createHttpContextGateway(createHttpClient({ fetchImpl: f }));
  await g.config();
  await g.list();
  await g.getProfile();
  await g.saveProfile({ name: 'Julian' });
  await g.addText({ name: 'Notas', kind: 'notes', text: 'hola' });
  assert.deepEqual(f.calls.map((c) => `${c.init.method} ${c.url}`), [
    'GET /api/config', 'GET /api/context', 'GET /api/profile', 'PUT /api/profile', 'POST /api/context/text',
  ]);
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { name: 'Julian' });
});

test('http context: update and remove encode the id; remove returns null on 204', async () => {
  const f = fakeFetch((url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({ id: 'x' })));
  const g = createHttpContextGateway(createHttpClient({ fetchImpl: f }));
  await g.update('c_1/../x', { active: false });
  assert.equal(await g.remove('c_1'), null);
  assert.equal(f.calls[0].url, '/api/context/c_1%2F..%2Fx');
  assert.equal(f.calls[0].init.method, 'PATCH');
  assert.equal(f.calls[1].url, '/api/context/c_1');
});

test('http context: uploadFile sends the raw file with its name and kind in the query string', async () => {
  const f = fakeFetch(() => jsonResponse({ id: 'c_1' }, 201));
  const g = createHttpContextGateway(createHttpClient({ fetchImpl: f }));
  const file = { name: 'Oferta Ñandú & Co.pdf', size: 10 };
  const ctl = new AbortController();
  await g.uploadFile(file, { kind: 'job' }, { signal: ctl.signal });
  const { url, init } = f.calls[0];
  const parsed = new URL(url, 'http://x');
  assert.equal(parsed.pathname, '/api/context/file');
  assert.equal(parsed.searchParams.get('filename'), 'Oferta Ñandú & Co.pdf');
  assert.equal(parsed.searchParams.get('kind'), 'job');
  assert.equal(init.body, file);
  assert.equal(init.method, 'POST');
  assert.equal(init.signal, ctl.signal);
  await g.uploadFile({ name: 'a.txt' });
  assert.equal(new URL(f.calls[1].url, 'http://x').searchParams.has('kind'), false);
});

test('http context: coachSystemPrompt passes mode and maxChars', async () => {
  const f = fakeFetch(() => jsonResponse({ systemPrompt: 'sys' }));
  await createHttpContextGateway(createHttpClient({ fetchImpl: f })).coachSystemPrompt({ mode: 'nano', maxChars: 3000 });
  assert.equal(f.calls[0].url, '/api/coach/system-prompt?mode=nano&maxChars=3000');
});

/* ---------- nano ---------- */

function fakeNanoWindow({ output = '- Lead teams\n- Use .NET and Azure\n- Mention results', hasApi = true } = {}) {
  const log = { created: [], clones: 0, destroyed: 0, prompts: [] };
  const session = {
    clone: async () => { log.clones++; return { prompt: async (text, opts) => { log.prompts.push({ text, opts }); return output; }, destroy: () => { log.destroyed++; } }; },
    destroy: () => { log.destroyed++; },
  };
  const win = hasApi ? { LanguageModel: { create: async (options) => { log.created.push(options); return session; } } } : {};
  return { win, log };
}
const contextGateway = (prompt = 'SYSTEM') => ({
  calls: [],
  async coachSystemPrompt(args) { this.calls.push(args); return { systemPrompt: prompt, usedContext: [{ id: 'c_1', name: 'Oferta' }], omittedContext: [] }; },
});

test('nano: parseBullets strips markers and keeps at most 3 points', () => {
  assert.deepEqual(parseBullets('- one\n* two\n• three\n1. four'), ['one', 'two', 'three']);
  assert.deepEqual(parseBullets('\n  \n2) only\n'), ['only']);
  assert.deepEqual(parseBullets(''), []);
});

test('nano: asks the server for the 3000-char nano prompt, prompts a clone and translates each point', async () => {
  const { win, log } = fakeNanoWindow();
  const ctx = contextGateway();
  const gateway = createNanoSuggestionGateway({ translator: createFakeTranslator(), contextGateway: ctx, win });
  const ctl = new AbortController();
  const out = await gateway.suggest({ turns: ['Tell me about', 'a project.'] }, { signal: ctl.signal });
  assert.deepEqual(ctx.calls, [{ mode: 'nano', maxChars: 3000 }]);
  assert.equal(log.created[0].initialPrompts[0].content, 'SYSTEM');
  assert.equal(log.prompts[0].text, 'Tell me about a project.');
  assert.equal(log.prompts[0].opts.signal, ctl.signal);
  assert.equal(log.destroyed, 1, 'the clone is destroyed');
  assert.deepEqual(out.suggestion.points, [
    { en: 'Lead teams', es: 'ES:Lead teams' }, { en: 'Use .NET and Azure', es: 'ES:Use .NET and Azure' }, { en: 'Mention results', es: 'ES:Mention results' },
  ]);
  assert.equal(out.suggestion.answer, null);
  assert.deepEqual(out.usedContext, [{ id: 'c_1', name: 'Oferta' }]);
});

test('nano: the base session is reused for the same prompt and recreated (old one destroyed) when it changes', async () => {
  const { win, log } = fakeNanoWindow();
  let prompt = 'A';
  const ctx = { coachSystemPrompt: async () => ({ systemPrompt: prompt, usedContext: [], omittedContext: [] }) };
  const gateway = createNanoSuggestionGateway({ translator: createFakeTranslator(), contextGateway: ctx, win });
  await gateway.suggest({ turns: ['q1'] });
  await gateway.suggest({ turns: ['q2'] });
  assert.equal(log.created.length, 1);
  assert.equal(log.clones, 2);
  prompt = 'B';
  await gateway.suggest({ turns: ['q3'] });
  assert.equal(log.created.length, 2);
  assert.equal(log.destroyed, 3 + 1, 'three clones and the replaced base');
});

test('nano: a failing translation still returns the English point', async () => {
  const { win } = fakeNanoWindow({ output: '- Lead teams' });
  const gateway = createNanoSuggestionGateway({ translator: createFakeTranslator({ fail: () => true }), contextGateway: contextGateway(), win });
  assert.deepEqual((await gateway.suggest({ turns: ['q'] })).suggestion.points, [{ en: 'Lead teams', es: '' }]);
});

test('nano: no API in this Chrome and an empty answer are clear errors', async () => {
  const none = createNanoSuggestionGateway({ translator: createFakeTranslator(), contextGateway: contextGateway(), win: fakeNanoWindow({ hasApi: false }).win });
  await assert.rejects(none.suggest({ turns: ['q'] }), /Gemini Nano no está disponible/);
  const empty = createNanoSuggestionGateway({ translator: createFakeTranslator(), contextGateway: contextGateway(), win: fakeNanoWindow({ output: '  \n' }).win });
  await assert.rejects(empty.suggest({ turns: ['q'] }), /no devolvió puntos clave/);
});

/* ---------- scheduler ---------- */

test('scheduler.after runs the function later and the returned function cancels it', async () => {
  let ran = 0;
  scheduler.after(5, () => ran++);
  const cancel = scheduler.after(5, () => ran += 10);
  cancel();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, 1);
});

/* ---------- prepared gateway ---------- */

test('http prepared: list, add, update, remove and generate hit the right endpoints', async () => {
  const { createHttpPreparedGateway } = await import('../../public/adapters/http-gateways.js');
  const f = fakeFetch((url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({ ok: true })));
  const g = createHttpPreparedGateway(createHttpClient({ fetchImpl: f }));
  const ctl = new AbortController();
  await g.list();
  await g.add({ question: 'Why?', triggers: ['why'] });
  await g.update('p_1/../x', { answer: null });
  assert.equal(await g.remove('p_1'), null);
  await g.generate('strengths');
  await g.generate('strengths', { force: true, signal: ctl.signal });
  assert.deepEqual(f.calls.map((c) => c.init.method + ' ' + c.url), [
    'GET /api/prepared', 'POST /api/prepared', 'PATCH /api/prepared/p_1%2F..%2Fx', 'DELETE /api/prepared/p_1',
    'POST /api/prepared/strengths/generate', 'POST /api/prepared/strengths/generate?force=1',
  ]);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { question: 'Why?', triggers: ['why'] });
  assert.equal(f.calls[5].init.signal, ctl.signal);
});
