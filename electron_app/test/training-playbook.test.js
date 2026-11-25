const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECTORS,
  getTopicsFor,
  resolveSectorLabel,
  createEmptyTurn,
  updatePlaybookTurn,
  addPlaybookTurn,
  removePlaybookTurn,
  mergeVocabularyText,
  upsertRecentPlaybook
} = require('../training-catalog');
const {
  createInterviewer,
  playbookPrompt,
  parsePlaybook,
  interviewPrompt,
  evaluationPrompt,
  parseEvaluation
} = require('../training-interviewer');
const { formatPlaybookReport, formatReport } = require('../training-session');

function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return {
      ok: r.status === undefined || r.status === 200,
      status: r.status || 200,
      headers: { get: () => null },
      json: async () => (r.gemini
        ? { candidates: [{ content: { parts: [{ text: r.content }] } }] }
        : { choices: [{ message: { content: r.content } }] }),
      text: async () => r.content || ''
    };
  };
  return { fetchImpl, calls };
}

test('el catálogo cubre múltiples sectores con temas para entrevista y para reunión internacional', () => {
  assert.ok(SECTORS.length >= 8);
  for (const s of SECTORS) {
    assert.ok(getTopicsFor('interview', s.id).length >= 3, `${s.id} necesita temas de entrevista`);
    assert.ok(getTopicsFor('meeting', s.id).length >= 3, `${s.id} necesita temas de reunión`);
  }
  assert.equal(resolveSectorLabel('custom', 'Energía Solar'), 'Energía Solar');
  assert.equal(resolveSectorLabel('finance'), 'Finanzas, Banca y Fintech');
});

test('operaciones sobre el libreto: añadir, editar, quitar turnos, fusionar vocabulario e historial reciente', () => {
  let pb = {
    scenarioTitle: { en: 'Sprint Demo', es: 'Demo de Sprint' },
    turns: [createEmptyTurn(1, 'meeting')]
  };
  pb = addPlaybookTurn(pb, createEmptyTurn(2, 'meeting'));
  assert.equal(pb.turns.length, 2);

  pb = updatePlaybookTurn(pb, 1, { question: { en: 'What is our rollback plan?' } });
  assert.equal(pb.turns[1].question.en, 'What is our rollback plan?');

  pb = removePlaybookTurn(pb, 0);
  assert.equal(pb.turns.length, 1);
  // Nunca deja el libreto vacío (mínimo 1 turno)
  assert.equal(removePlaybookTurn(pb, 0).turns.length, 1);

  const merged = mergeVocabularyText('spfx = SPFx', [
    { term: 'SPFx', es: 'SharePoint Framework' },
    { term: 'Throttling', es: 'Limitación de peticiones' },
    { term: 'Stakeholder', es: 'Interesado clave' }
  ]);
  assert.equal(merged.addedCount, 2);
  assert.match(merged.text, /throttling = Throttling/);
  assert.match(merged.text, /stakeholder = Stakeholder/);

  let recents = [];
  for (let i = 0; i < 8; i++) {
    recents = upsertRecentPlaybook(recents, { id: `id-${i}`, setup: { topic: `T${i}` }, playbook: pb }, 6);
  }
  assert.equal(recents.length, 6);
  assert.equal(recents[0].id, 'id-7');
});

test('generatePlaybook construye el libreto bilingüe completo y parsePlaybook valida sus campos', async () => {
  const sampleJson = JSON.stringify({
    scenarioTitle: { en: 'US Client Scope Negotiation', es: 'Negociación de alcance con cliente en EE. UU.' },
    interlocutor: { name: 'Sarah Chen', role: 'VP of Product', location: 'New York, US', style: 'Directa y orientada a fechas' },
    brief: { en: 'Client asks for two extra modules before Friday.', es: 'El cliente pide dos módulos extra antes del viernes.' },
    culturalTip: { en: 'Lead with the trade-off, not an apology.', es: 'Empieza por el impacto y opciones, no pidiendo disculpas.' },
    turns: [
      {
        question: { en: 'Can your team squeeze these two reports into Friday release?', es: '¿Puede tu equipo meter estos dos reportes en la entrega del viernes?' },
        intent: 'Evalúa si sabes decir no con datos y ofrecer alternativas.',
        howToAnswer: 'Usa BLUF: reconoce la importancia, explica el impacto en calidad y propone dos opciones claras.',
        sampleAnswer: { en: 'We can deliver report A by Friday without risking stability, or both by Tuesday.', es: 'Podemos entregar el reporte A el viernes sin arriesgar estabilidad, o ambos el martes.' },
        keyPhrases: [{ en: 'To protect release stability…', es: 'Para proteger la estabilidad de la entrega…' }],
        evalCriteria: ['No promete algo imposible', 'Propone opciones concretas']
      }
    ],
    vocabulary: [{ term: 'Scope creep', es: 'Crecimiento descontrolado del alcance', usage: 'Let us avoid scope creep before launch.' }]
  });

  const { fetchImpl, calls } = fakeFetch([{ content: '```json\n' + sampleJson + '\n```' }]);
  const interviewer = createInterviewer({ fetchImpl, getGroqKey: () => 'gsk_test_key' });
  const setup = {
    mode: 'meeting',
    sector: 'Finanzas, Banca y Fintech',
    topic: 'Negociación de alcance y plazos',
    role: 'Tech Lead',
    level: 'executive',
    questions: 1
  };
  const res = await interviewer.generatePlaybook({ setup, refineNote: 'Hazlo exigente con fechas' });
  assert.equal(res.ok, true);
  assert.equal(res.playbook.interlocutor.name, 'Sarah Chen');
  assert.equal(res.playbook.turns.length, 1);
  assert.equal(res.playbook.vocabulary[0].term, 'Scope creep');
  assert.match(calls[0].body.messages[0].content, /Hazlo exigente con fechas/);

  const prompt = interviewPrompt({ ...setup, playbook: res.playbook });
  assert.match(prompt, /Sarah Chen/);
  assert.match(prompt, /Can your team squeeze these two reports/);
  assert.match(prompt, /international work meeting/i);

  const md = formatPlaybookReport({ setup, playbook: res.playbook });
  assert.match(md, /Negociación de alcance con cliente en EE\. UU\./);
  assert.match(md, /Scope creep/);
  assert.match(md, /Cómo responder:/);

  assert.throws(() => parsePlaybook('sin json', setup), /libreto legible/);
  assert.match(playbookPrompt(setup), /international work meeting/);
});

test('evaluate en modo reunión devuelve turnFeedback, nextSteps y recomendación de preparación internacional', async () => {
  const evalJson = JSON.stringify({
    overall: 8.2,
    verdict: { en: 'Ready for international meetings.', es: 'Listo para reuniones internacionales.' },
    categories: [
      { name: { en: 'Executive clarity', es: 'Claridad ejecutiva' }, score: 8.5, note: { en: 'Clear BLUF', es: 'Al grano' } }
    ],
    turnFeedback: [
      {
        question: 'Can we add two reports for Friday?',
        score: 8,
        strength: { en: 'Offered two clear options', es: 'Ofreciste dos opciones claras' },
        improvement: { en: 'State the exact date upfront', es: 'Di la fecha exacta al inicio' },
        betterAnswer: { en: 'We can ship report A Friday and report B Tuesday.', es: 'Podemos entregar el reporte A el viernes y el B el martes.' }
      }
    ],
    strengths: [{ en: 'Calm tone', es: 'Tono sereno' }],
    improvements: [{ en: 'Lead with metrics', es: 'Abrir con métricas' }],
    translationIssues: [],
    nextSteps: [{ en: 'Practice polite pushback phrases', es: 'Practicar frases de negociación diplomática' }],
    recommendation: 'ready'
  });

  const setup = { mode: 'meeting', sector: 'Fintech', topic: 'Negociación de plazos', role: 'Tech Lead', questions: 1 };
  const parsed = parseEvaluation(evalJson, setup);
  assert.equal(parsed.recommendation, 'ready');
  assert.equal(parsed.turnFeedback.length, 1);
  assert.equal(parsed.nextSteps.length, 1);
  assert.match(evaluationPrompt(setup), /"ready" \| "almost" \| "needs_practice"/);

  const report = formatReport({
    setup,
    history: [
      { role: 'interviewer', text: 'Can we add two reports for Friday?' },
      { role: 'candidate', text: 'We can do one Friday and the other Tuesday.', original: 'Podemos hacer uno el viernes y otro el martes.' }
    ],
    evaluation: parsed
  });
  assert.match(report, /Listo para equipo internacional/);
  assert.match(report, /Revisión turno por turno/);
  assert.match(report, /Plan de acción para equipos internacionales/);
});

test('si Groq falla y hay clave de Gemini, el motor usa Gemini automáticamente como respaldo', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 429, content: 'rate limit' },
    { status: 429, content: 'rate limit' },
    { status: 200, gemini: true, content: 'Welcome everyone, let us review the sprint blockers.' }
  ]);
  const interviewer = createInterviewer({
    fetchImpl,
    getGroqKey: () => 'gsk_test_key',
    getGeminiKey: () => 'AIza_test_gemini_key'
  });
  const res = await interviewer.next({ setup: { mode: 'meeting', role: 'Tech Lead', questions: 3 }, history: [] });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'Welcome everyone, let us review the sprint blockers.');
  assert.match(calls[2].url, /generativelanguage\.googleapis\.com/);
});
