const test = require('node:test');
const assert = require('node:assert/strict');
const { createInterviewer, interviewPrompt, parseEvaluation } = require('../training-interviewer');

const SETUP = { role: 'Senior SharePoint Online Developer', questions: 8 };

/** fetch falso: devuelve las respuestas en orden y guarda lo que se pidió. */
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status || 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: r.content } }] }),
      text: async () => r.content || ''
    };
  };
  return { fetchImpl, calls };
}

test('el entrevistador habla solo en inglés del puesto elegido y sabe que oye una traducción', () => {
  const prompt = interviewPrompt(SETUP);
  assert.match(prompt, /Senior SharePoint Online Developer/);
  assert.match(prompt, /only English/);
  assert.match(prompt, /translation/);
  assert.match(prompt, /8 main questions/);
  assert.match(prompt, /\[END\]/);
});

test('el primer turno abre la entrevista y el historial llega como conversación', async () => {
  const { fetchImpl, calls } = fakeFetch([{ content: 'Hi, I am Alex. Tell me about your last SPFx project.' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const first = await interviewer.next({ setup: SETUP, history: [] });
  assert.deepEqual(first, { ok: true, text: 'Hi, I am Alex. Tell me about your last SPFx project.', end: false, model: 'openai/gpt-oss-120b' });
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.equal(calls[0].body.messages.at(-1).role, 'user');

  await interviewer.next({ setup: SETUP, history: [
    { role: 'interviewer', text: 'Tell me about your last SPFx project.' },
    { role: 'candidate', text: 'I built an intranet with web parts.', original: 'Hice una intranet con web parts.' }
  ] });
  const roles = calls[1].body.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ['assistant', 'user']);
  assert.equal(calls[1].body.messages.at(-1).content, 'I built an intranet with web parts.');
});

test('cuando el entrevistador termina, se detecta [END] y no se dice en voz alta', async () => {
  const { fetchImpl } = fakeFetch([{ content: 'Thank you, that was the last question. [END]' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const r = await interviewer.next({ setup: SETUP, history: [{ role: 'interviewer', text: 'Q' }, { role: 'candidate', text: 'A' }] });
  assert.equal(r.end, true);
  assert.equal(r.text, 'Thank you, that was the last question.');
});

test('si la entrevista se alarga de más, se le pide que cierre', async () => {
  const { fetchImpl, calls } = fakeFetch([{ content: 'Thanks for your time. [END]' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const history = [];
  for (let i = 0; i < 12; i++) history.push({ role: 'interviewer', text: `Q${i}` }, { role: 'candidate', text: `A${i}` });
  await interviewer.next({ setup: SETUP, history });
  assert.match(calls[0].body.messages.at(-1).content, /close the interview now/i);
});

test('con el primer modelo en su límite se usa el segundo', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 429, content: 'rate limited' }, { content: 'Next question?' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const r = await interviewer.next({ setup: SETUP, history: [] });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'openai/gpt-oss-20b');
  assert.equal(calls[1].body.model, 'openai/gpt-oss-20b');
});

test('sin clave de Groq se explica qué falta', async () => {
  const { fetchImpl } = fakeFetch([{ content: 'x' }]);
  const r = await createInterviewer({ fetchImpl, getGroqKey: () => '' }).next({ setup: SETUP, history: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /clave de Groq/);
});

test('la evaluación se lee aunque venga entre marcas de código, y las notas quedan entre 0 y 10', () => {
  const raw = '```json\n{"overall": 12, "verdict": {"en": "Strong", "es": "Fuerte"}, "categories": [{"name": {"en": "Technical depth", "es": "Profundidad técnica"}, "score": 8.5, "note": {"en": "Good", "es": "Bien"}}, {"name": {"en": "Communication", "es": "Comunicación"}, "score": -1, "note": {"en": "", "es": ""}}], "strengths": [{"en": "SPFx", "es": "SPFx"}], "recommendation": "hire"}\n```';
  const e = parseEvaluation(raw);
  assert.equal(e.overall, 10);
  assert.equal(e.categories[0].score, 8.5);
  assert.equal(e.categories[1].score, 0);
  assert.deepEqual(e.verdict, { en: 'Strong', es: 'Fuerte' });
  assert.deepEqual(e.improvements, []);
  assert.deepEqual(e.translationIssues, []);
  assert.equal(e.recommendation, 'hire');
});

test('una evaluación ilegible da un error claro', () => {
  assert.throws(() => parseEvaluation('no json here'), /evaluación/);
});

test('evaluar envía la entrevista completa con lo que dijo el candidato en ambos idiomas', async () => {
  const json = JSON.stringify({ overall: 7, verdict: { en: 'Solid', es: 'Sólido' }, categories: [], strengths: [], improvements: [], translationIssues: [], recommendation: 'maybe' });
  const { fetchImpl, calls } = fakeFetch([{ content: json }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const r = await interviewer.evaluate({ setup: SETUP, history: [
    { role: 'interviewer', text: 'Tell me about throttling.' },
    { role: 'candidate', text: 'I respect the Retry-After header.', original: 'Respeto el header Retry-After.' }
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.evaluation.overall, 7);
  const sent = calls[0].body.messages.map((m) => m.content).join('\n');
  assert.match(sent, /Retry-After header/);
  assert.match(sent, /Respeto el header Retry-After/);
});
