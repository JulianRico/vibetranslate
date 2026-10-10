const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveLogsDir } = require('../logger');

test('en desarrollo los registros van junto al código', () => {
  const dir = path.join('C:', 'repo', 'electron_app');
  assert.equal(resolveLogsDir(dir, () => { throw new Error('no debe consultarse'); }), path.join(dir, 'logs'));
});

test('empaquetada, la app no puede escribir dentro de app.asar: los registros van a la carpeta de datos del usuario', () => {
  const dir = path.join('C:', 'Program Files', 'App', 'resources', 'app.asar');
  const userData = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'App');
  assert.equal(resolveLogsDir(dir, () => userData), path.join(userData, 'logs'));
});

test('si no hay carpeta de datos disponible usa la carpeta temporal del sistema', () => {
  const dir = path.join('C:', 'App', 'resources', 'app.asar');
  const resolved = resolveLogsDir(dir, () => { throw new Error('sin app'); });
  assert.ok(resolved.startsWith(require('node:os').tmpdir()), resolved);
});
