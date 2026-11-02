const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionReport } = require('../session-report');

const BASE = {
  now: new Date(2026, 10, 2, 12, 4, 0),
  engine: 'local',
  sourceLang: 'es-ES',
  targetLang: 'en',
  hasVirtualCable: true,
  conversationSize: 0,
  conversationText: '',
  logs: []
};

test('el informe lleva el motor, los idiomas y si está el cable virtual', () => {
  const report = buildSessionReport(BASE);
  assert.match(report, /Motor: local/);
  assert.match(report, /Idiomas: es-ES → en/);
  assert.match(report, /Cable virtual: instalado/);
  assert.match(report, /No se registró ninguna frase/);
  assert.match(buildSessionReport({ ...BASE, hasVirtualCable: false }), /Cable virtual: no encontrado/);
});

test('el informe incluye la conversación y solo los últimos 40 eventos del registro', () => {
  const logs = Array.from({ length: 45 }, (_, i) => `evento ${i + 1}`);
  const report = buildSessionReport({ ...BASE, conversationSize: 2, conversationText: 'Tú: hola\nReunión: hi', logs });
  assert.match(report, /Conversación \(2 frases\)/);
  assert.match(report, /Tú: hola\nReunión: hi/);
  assert.ok(!report.includes('evento 5\n'));
  assert.match(report, /evento 6\n/);
  assert.match(report, /evento 45/);
});
