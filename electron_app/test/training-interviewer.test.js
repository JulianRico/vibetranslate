const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInterviewer,
  interviewPrompt,
  parseEvaluation,
  extractJsonObject,
  matchPlaybookTurn,
  computeScriptProgress
} = require('../training-interviewer');

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

test('extractJsonObject y evaluate reparan JSON truncado y nunca devuelven ok:false si hay respuestas del candidato', async () => {
  // 1. JSON truncado a mitad del cierre (típico cuando un modelo razonador agota max_tokens)
  const truncated = '{"overall": 8.2, "verdict": {"en": "Strong technical answers", "es": "Respuestas sólidas"}, "categories": [{"name": {"en": "Depth", "es": "Profundidad"}, "score": 8.5, "note": {"en": "Clear", "es": "Claro"}}], "recommendation": "hire", "strengths": [{"en": "Good architecture", "es": "Buena arquitec';
  const parsed = parseEvaluation(truncated);
  assert.equal(parsed.overall, 8.2);
  assert.equal(parsed.recommendation, 'hire');
  assert.equal(parsed.categories[0].score, 8.5);
  assert.ok(extractJsonObject('sin llaves') === null);

  // 2. Incluso si el proveedor devuelve basura dos veces seguidas, evaluate entrega evaluación de respaldo y preserva la sesión
  const { fetchImpl } = fakeFetch([{ content: 'texto sin json' }, { content: 'tampoco json' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const r = await interviewer.evaluate({
    setup: SETUP,
    history: [
      { role: 'interviewer', text: 'How do you handle Graph throttling?' },
      { role: 'candidate', text: 'We implement exponential backoff and honor Retry-After headers.', original: 'Aplicamos backoff exponencial y respetamos Retry-After.' }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.fallback, true);
  assert.equal(r.evaluation.turnFeedback.length, 1);
});

test('matchPlaybookTurn y computeScriptProgress mantienen intacto el orden del libreto cuando hay preguntas fuera de guion', async () => {
  const playbook = {
    turns: [
      { question: { en: 'How do you design SPFx governance across tenants?', es: '¿Cómo diseñas gobernanza SPFx entre tenants?' } },
      { question: { en: 'How do you mitigate Microsoft Graph API throttling in migrations?', es: '¿Cómo mitigas el throttling de Microsoft Graph en migraciones?' } },
      { question: { en: 'How do you align stakeholders when a deadline slips?', es: '¿Cómo alineas stakeholders si se retrasa una entrega?' } }
    ]
  };

  const covered = new Set();
  // Turno 1: pregunta 1 del guion con saludo previo
  const m1 = matchPlaybookTurn('Hi! Welcome today. How do you design SPFx governance across multiple tenants?', playbook.turns, 0, covered);
  assert.equal(m1.matched, true);
  assert.equal(m1.turnIndex, 0);
  assert.equal(m1.nextScriptIndex, 1);
  covered.add(m1.turnIndex);

  // Turno 2: el entrevistador mete una repregunta espontánea que NO está en el libreto -> NO debe avanzar el índice 1
  const mExtra = matchPlaybookTurn('Interesting—how many users were affected during that outage in Madrid?', playbook.turns, m1.nextScriptIndex, covered);
  assert.equal(mExtra.matched, false);
  assert.equal(mExtra.nextScriptIndex, 1, 'una pregunta fuera de guion no debe saltar la pregunta 2 del libreto');

  // Turno 3: ahora sí hace la pregunta 2 del libreto -> coincide con índice 1 y avanza a 2
  const m2 = matchPlaybookTurn('Great context. Now, how do you mitigate Microsoft Graph API throttling during large migrations?', playbook.turns, mExtra.nextScriptIndex, covered);
  assert.equal(m2.matched, true);
  assert.equal(m2.turnIndex, 1);
  assert.equal(m2.nextScriptIndex, 2);

  // Verificar también que next() inyecta el recordatorio exacto de la pregunta 2 tras una repregunta fuera de guion
  const prog = computeScriptProgress([
    { role: 'interviewer', text: 'Hi! How do you design SPFx governance across tenants?' },
    { role: 'candidate', text: 'We use app catalog policies.' },
    { role: 'interviewer', text: 'Which team approves those policies?' },
    { role: 'candidate', text: 'The cloud platform security team.' }
  ], playbook.turns);
  assert.equal(prog.coveredCount, 1);
  assert.equal(prog.nextScriptIndex, 1);
  assert.match(prog.nextTurn.question.en, /Graph API throttling/);
});

test('generateTurnCoach crea respuesta modelo bilingüe para preguntas fuera del libreto', async () => {
  const coachJson = JSON.stringify({
    intent: 'Verificar manejo real de incidentes bajo presión.',
    howToAnswer: 'Indica impacto, acción concreta y prevención.',
    keyPhrases: [{ en: 'We isolated the root cause within 15 minutes', es: 'Aislamos la causa raíz en 15 minutos' }],
    sampleAnswer: {
      en: 'During that incident, we isolated the failing webhook within 15 minutes and rolled back safely.',
      es: 'Durante ese incidente, aislamos el webhook fallido en 15 minutos y revertimos sin pérdida de datos.'
    }
  });
  const { fetchImpl } = fakeFetch([{ content: coachJson }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const r = await interviewer.generateTurnCoach({
    setup: SETUP,
    question: 'What did you do in the first 15 minutes of that production outage?',
    history: []
  });
  assert.equal(r.ok, true);
  assert.match(r.coach.sampleAnswer.en, /15 minutes/);
  assert.match(r.coach.sampleAnswer.es, /15 minutos/);
  assert.equal(r.coach.isDynamic, true);
});
