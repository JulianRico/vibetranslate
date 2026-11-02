const test = require('node:test');
const assert = require('node:assert/strict');
const { directionText, formatElapsed, readiness } = require('../ui-state');

const READY = {
  micCount: 2,
  hasVirtualCable: true,
  engine: 'local',
  sourceLang: 'es-ES',
  groqKey: '',
  geminiKey: '',
  local: { ready: true, missingBytes: 0 }
};

const stateOf = (result, id) => result.checks.find((c) => c.id === id).state;

test('la línea de idiomas dice en qué idioma hablas y en cuál te oye la reunión', () => {
  assert.equal(directionText('es-ES', 'en'), 'Hablas en español y la reunión te oye en inglés.');
  assert.equal(directionText('en-US', 'es'), 'Hablas en inglés y la reunión te oye en español.');
});

test('con destino automático o igual al origen, la reunión te oye en el otro idioma', () => {
  assert.equal(directionText('es-ES', 'auto'), 'Hablas en español y la reunión te oye en inglés.');
  assert.equal(directionText('en-US', 'en'), 'Hablas en inglés y la reunión te oye en español.');
});

test('con origen automático se explica que cada frase va al otro idioma', () => {
  assert.equal(directionText('auto', 'auto'), 'Detecta si hablas en español o en inglés y traduce cada frase al otro idioma.');
});

test('el cronómetro muestra minutos y segundos, y horas cuando las hay', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65000), '1:05');
  assert.equal(formatElapsed(3723000), '1:02:03');
  assert.equal(formatElapsed(-5), '0:00');
  assert.equal(formatElapsed(NaN), '0:00');
});

test('con todo listo las tres comprobaciones están bien y no hay aviso', () => {
  const result = readiness(READY);
  assert.deepEqual(result.checks.map((c) => [c.id, c.label, c.state]), [
    ['mic', 'Micrófono', 'ok'], ['cable', 'Cable virtual', 'ok'], ['engine', 'Motor', 'ok']
  ]);
  assert.equal(result.notice, null);
});

test('sin cable virtual se avisa qué deja de funcionar y se ofrece instalarlo', () => {
  const result = readiness({ ...READY, hasVirtualCable: false });
  assert.equal(stateOf(result, 'cable'), 'error');
  assert.equal(result.notice.state, 'error');
  assert.match(result.notice.text, /la reunión no oye tu traducción/);
  assert.deepEqual(result.notice.action, { id: 'install-cable', label: 'Instalar VB-CABLE' });
});

test('sin micrófono se pide elegir uno, y ese aviso va antes que el del cable', () => {
  const result = readiness({ ...READY, micCount: 0, hasVirtualCable: false });
  assert.equal(stateOf(result, 'mic'), 'error');
  assert.deepEqual(result.notice.action, { id: 'open-audio', label: 'Elegir micrófono' });
});

test('un motor en la nube sin su clave no está listo y se ofrece ponerla', () => {
  const gemini = readiness({ ...READY, engine: 'gemini_35_transcribe', geminiKey: '' });
  assert.equal(stateOf(gemini, 'engine'), 'error');
  assert.match(gemini.notice.text, /clave de Gemini/);
  assert.deepEqual(gemini.notice.action, { id: 'open-engine', label: 'Poner la clave' });

  const groq = readiness({ ...READY, engine: 'whisper_groq', groqKey: 'abc' });
  assert.equal(stateOf(groq, 'engine'), 'error');
  assert.match(groq.notice.text, /clave de Groq/);

  assert.equal(stateOf(readiness({ ...READY, engine: 'gemini_live', geminiKey: 'AIzaSyEjemplo' }), 'engine'), 'ok');
});

test('el motor local con modelos por descargar avisa del tamaño sin bloquear', () => {
  const result = readiness({ ...READY, local: { ready: false, missingBytes: 52e6 } });
  assert.equal(stateOf(result, 'engine'), 'warn');
  assert.equal(result.notice.state, 'warn');
  assert.equal(result.notice.text, 'Al empezar se descargarán 52 MB del motor local, solo la primera vez.');
  assert.equal(result.notice.action, null);
});

test('el motor local necesita un idioma fijo: con origen automático no está listo', () => {
  const result = readiness({ ...READY, sourceLang: 'auto' });
  assert.equal(stateOf(result, 'engine'), 'error');
  assert.deepEqual(result.notice.action, { id: 'open-languages', label: 'Elegir idioma' });
});

test('un error se avisa antes que una advertencia', () => {
  const result = readiness({ ...READY, hasVirtualCable: false, local: { ready: false, missingBytes: 52e6 } });
  assert.equal(result.notice.state, 'error');
  assert.equal(result.notice.action.id, 'install-cable');
});

test('mientras no se sabe si los modelos locales están, el motor no se marca como problema', () => {
  assert.equal(stateOf(readiness({ ...READY, local: null }), 'engine'), 'ok');
});
