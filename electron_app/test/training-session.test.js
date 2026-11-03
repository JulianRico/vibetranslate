const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnswerCollector, answerReady, ttsChunks, formatScore, formatReport } = require('../training-session');

test('la respuesta junta las líneas en el orden en que aparecieron, con su última traducción', () => {
  const answer = createAnswerCollector();
  answer.add({ lineId: 3, original: 'Hice una intranet', translated: 'I made an intranet', at: 1000 });
  answer.add({ lineId: 4, original: 'con SPFx.', translated: 'with SPFx.', at: 2000 });
  // la nube mejora la primera línea más tarde
  answer.add({ lineId: 3, original: 'Hice una intranet', translated: 'I built an intranet', at: 2500 });
  assert.deepEqual(answer.get(), { spanish: 'Hice una intranet con SPFx.', english: 'I built an intranet with SPFx.', count: 2, lastAt: 2500 });
  answer.reset();
  assert.deepEqual(answer.get(), { spanish: '', english: '', count: 0, lastAt: 0 });
});

test('la respuesta sabe qué líneas son suyas: la mejora tardía de una respuesta anterior no se cuela', () => {
  const answer = createAnswerCollector();
  answer.add({ lineId: 7, original: 'Uso Polly.', translated: 'I use Polly.', at: 1000 });
  assert.equal(answer.has(7), true);
  assert.equal(answer.has(6), false);
  answer.reset();
  assert.equal(answer.has(7), false);
});

test('con «pausa», la respuesta termina tras 3 s de silencio y cuando la traducción dejó de cambiar', () => {
  const base = { mode: 'pause', count: 2, lastVoiceAt: 10000, lastLineAt: 11000 };
  assert.equal(answerReady({ ...base, now: 12500 }), false); // solo 2,5 s de silencio
  assert.equal(answerReady({ ...base, now: 13100 }), true);
  assert.equal(answerReady({ ...base, lastLineAt: 12500, now: 13100 }), false); // la nube aún está mejorando la línea
  assert.equal(answerReady({ ...base, count: 0, now: 20000 }), false); // sin nada oído no se responde por el usuario
});

test('con «solo botón» la respuesta nunca termina sola', () => {
  assert.equal(answerReady({ mode: 'button', count: 3, lastVoiceAt: 0, lastLineAt: 0, now: 60000 }), false);
});

test('la voz del entrevistador se trocea por frases sin pasar de 190 caracteres', () => {
  const text = 'Thanks for joining. ' + 'Could you walk me through how you would design a provisioning solution for SharePoint sites, including approvals, templates, permissions and the governance rules your client asked for, and why? ' + 'Take your time.';
  const chunks = ttsChunks(text);
  assert.ok(chunks.every((c) => c.length <= 190), chunks.map((c) => c.length).join(','));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.trim().replace(/\s+/g, ' '));
  assert.deepEqual(ttsChunks('   '), []);
});

test('la nota se escribe con coma decimal', () => {
  assert.equal(formatScore(7.5), '7,5');
  assert.equal(formatScore(8), '8');
});

test('el informe guardado lleva la nota, el veredicto y la entrevista en ambos idiomas', () => {
  const report = formatReport({
    date: new Date(2026, 10, 2, 18, 30),
    setup: { role: 'Senior SharePoint Online Developer', questions: 8 },
    history: [
      { role: 'interviewer', text: 'How do you handle throttling?', translated: '¿Cómo manejas el throttling?' },
      { role: 'candidate', text: 'I respect Retry-After.', original: 'Respeto el Retry-After.' }
    ],
    evaluation: {
      overall: 7.5, verdict: { en: 'Solid senior profile', es: 'Perfil sénior sólido' }, recommendation: 'hire',
      categories: [{ name: { en: 'Technical depth', es: 'Profundidad técnica' }, score: 8, note: { en: 'Good', es: 'Bien' } }],
      strengths: [{ en: 'Graph', es: 'Graph' }], improvements: [], translationIssues: [{ en: 'throttling garbled', es: 'throttling deformado' }]
    }
  });
  assert.match(report, /Senior SharePoint Online Developer/);
  assert.match(report, /7,5 \/ 10/);
  assert.match(report, /Perfil sénior sólido/);
  assert.match(report, /Profundidad técnica: 8/);
  assert.match(report, /throttling deformado/);
  assert.match(report, /Entrevistador: How do you handle throttling\?/);
  assert.match(report, /Tú: Respeto el Retry-After\./);
  assert.match(report, /Lo que recibió: I respect Retry-After\./);
});
