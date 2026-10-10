import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSuggestAnswer } from '../../src/application/use-cases/suggest-answer.js';
import { createBuildCoachSystemPrompt } from '../../src/application/use-cases/build-coach-system-prompt.js';
import { createContextItem } from '../../src/domain/context-item.js';
import { normalizeProfile } from '../../src/domain/profile.js';
import { NotConfiguredError, UpstreamError, ValidationError } from '../../src/domain/errors.js';
import { createMemoryContextRepository, createMemoryProfileRepository, createFakeLlm } from '../support/fakes.js';

const GOOD = {
  questionEs: '¿Cuéntame de ti?', intent: 'introducción',
  points: [{ en: 'Full Stack Lead', es: 'Líder Full Stack' }],
  answer: { en: 'I lead teams building .NET and React products.', es: 'Lidero equipos que construyen productos .NET y React.' },
};

const item = (id, kind, text, over = {}) => createContextItem({ id, name: `${id}.pdf`, kind, source: 'pdf', text, now: `2026-10-01T10:0${id.length}:00Z`, ...over });

function setup({ llm, items = [] } = {}) {
  const profileRepo = createMemoryProfileRepository(normalizeProfile({ name: 'Julian', headline: 'Full Stack Lead' }));
  const contextRepo = createMemoryContextRepository(items);
  const fake = llm ?? createFakeLlm({ json: GOOD });
  return { fake, suggest: createSuggestAnswer({ llm: fake, profileRepo, contextRepo }), buildPrompt: createBuildCoachSystemPrompt({ profileRepo, contextRepo }) };
}

test('returns the validated suggestion plus used and omitted context', async () => {
  const { suggest, fake } = setup({ items: [item('a', 'job', 'Need a lead.')] });
  const out = await suggest({ turns: ['Tell me about yourself.'] });
  assert.deepEqual(out.suggestion, GOOD);
  assert.deepEqual(out.usedContext, [{ id: 'a', name: 'a.pdf' }]);
  assert.deepEqual(out.omittedContext, []);
  const call = fake.calls.generateJson[0];
  assert.match(call.system, /helping Julian/);
  assert.match(call.system, /Need a lead\./);
  assert.match(call.prompt, /Tell me about yourself\./);
  assert.equal(call.temperature, 0.5);
});

test('the abort signal reaches the LLM', async () => {
  const { suggest, fake } = setup();
  const ctl = new AbortController();
  await suggest({ turns: ['Hi'], signal: ctl.signal });
  assert.equal(fake.calls.generateJson[0].signal, ctl.signal);
});

test('retries once, telling the model what was wrong, when the output is invalid', async () => {
  const llm = createFakeLlm({ json: [{ nonsense: true }, GOOD] });
  const { suggest } = setup({ llm });
  const out = await suggest({ turns: ['Hi'] });
  assert.deepEqual(out.suggestion, GOOD);
  assert.equal(llm.calls.generateJson.length, 2);
  assert.match(llm.calls.generateJson[1].prompt, /Your previous reply was rejected: La sugerencia no tiene puntos clave/);
});

test('retries when the gateway reports unparseable output', async () => {
  const bad = Object.assign(new UpstreamError('Gemini devolvió JSON inválido'), { invalidOutput: true });
  const llm = createFakeLlm({ json: [bad, GOOD] });
  const { suggest } = setup({ llm });
  assert.deepEqual((await suggest({ turns: ['Hi'] })).suggestion, GOOD);
});

test('fails with UpstreamError after two invalid outputs', async () => {
  const llm = createFakeLlm({ json: { nonsense: true } });
  const { suggest } = setup({ llm });
  await assert.rejects(suggest({ turns: ['Hi'] }), (e) => e instanceof UpstreamError && /sugerencia inválida/.test(e.message));
  assert.equal(llm.calls.generateJson.length, 2);
});

test('other upstream errors are not retried', async () => {
  const llm = createFakeLlm({ json: new UpstreamError('Gemini HTTP 503') });
  const { suggest } = setup({ llm });
  await assert.rejects(suggest({ turns: ['Hi'] }), UpstreamError);
  assert.equal(llm.calls.generateJson.length, 1);
});

test('without a key it fails with NotConfiguredError before calling anything', async () => {
  const llm = createFakeLlm({ configured: false });
  const { suggest } = setup({ llm });
  await assert.rejects(suggest({ turns: ['Hi'] }), NotConfiguredError);
  assert.equal(llm.calls.generateJson.length, 0);
});

test('validates turns and history', async () => {
  const { suggest } = setup();
  const bad = [
    { turns: [] }, { turns: undefined }, { turns: ['a', 'b', 'c', 'd'] }, { turns: ['  '] }, { turns: [42] },
    { turns: ['x'.repeat(601)] },
    { turns: ['ok'], history: Array(5).fill({ interviewer: 'q' }) },
    { turns: ['ok'], history: [{ interviewer: '' }] },
    { turns: ['ok'], history: 'nope' },
  ];
  for (const input of bad) await assert.rejects(suggest(input), ValidationError, JSON.stringify(input).slice(0, 60));
});

test('reports context that did not fit in the budget', async () => {
  const items = [item('a', 'job', 'x'.repeat(29000)), item('bb', 'cv', 'y'.repeat(5000)), item('ccc', 'other', 'z'.repeat(2000))];
  const { suggest } = setup({ items });
  const out = await suggest({ turns: ['Hi'] });
  assert.deepEqual(out.usedContext.map((u) => u.id), ['a']);
  assert.deepEqual(out.omittedContext.map((u) => u.id), ['bb', 'ccc']);
});

test('buildCoachSystemPrompt builds the nano prompt within the requested budget', async () => {
  const { buildPrompt } = setup({ items: [item('a', 'job', 'j'.repeat(4000)), item('bb', 'notes', 'n'.repeat(1000))] });
  const out = await buildPrompt({ maxChars: 3000, mode: 'nano' });
  assert.match(out.systemPrompt, /2 or 3 short bullet points/);
  assert.deepEqual(out.usedContext.map((u) => u.id), ['a']);
  assert.deepEqual(out.omittedContext.map((u) => u.id), ['bb']);
});

test('buildCoachSystemPrompt validates mode and maxChars', async () => {
  const { buildPrompt } = setup();
  await assert.rejects(buildPrompt({ mode: 'x' }), ValidationError);
  await assert.rejects(buildPrompt({ maxChars: 100 }), ValidationError);
  await assert.rejects(buildPrompt({ maxChars: 99999 }), ValidationError);
  await assert.rejects(buildPrompt({ maxChars: 'abc' }), ValidationError);
  assert.match((await buildPrompt()).systemPrompt, /Reply with JSON only/);
});
