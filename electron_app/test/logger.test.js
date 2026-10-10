const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resolveLogsDir } = require('../logger');

const devDir = path.join('C:', 'repo', 'electron_app');
const userData = path.join('C:', 'Users', 'x', 'AppData', 'Roaming', 'App');
const packagedApp = { isPackaged: true, getPath: () => userData };

test('en desarrollo los registros van junto al código', () => {
  assert.equal(resolveLogsDir(devDir, () => ({ isPackaged: false, getPath: () => userData })), path.join(devDir, 'logs'));
});

test('instalada, los registros van a la carpeta de datos del usuario', () => {
  const installDir = path.join('C:', 'Program Files', 'App', 'resources', 'app.asar');
  assert.equal(resolveLogsDir(installDir, () => packagedApp), path.join(userData, 'logs'));
});

test('instalada sin asar tampoco escribe en la carpeta de instalación', () => {
  const installDir = path.join('C:', 'Program Files', 'App', 'resources', 'app');
  assert.equal(resolveLogsDir(installDir, () => packagedApp), path.join(userData, 'logs'));
});

test('fuera de Electron (pruebas, scripts) usa la carpeta junto al código', () => {
  assert.equal(resolveLogsDir(devDir, () => undefined), path.join(devDir, 'logs'));
  assert.equal(resolveLogsDir(devDir, () => { throw new Error('sin electron'); }), path.join(devDir, 'logs'));
});

test('dentro de un asar sin poder preguntar a Electron usa la carpeta temporal: ahí no se puede escribir', () => {
  const installDir = path.join('C:', 'App', 'resources', 'app.asar');
  const resolved = resolveLogsDir(installDir, () => { throw new Error('sin electron'); });
  assert.ok(resolved.startsWith(os.tmpdir()), resolved);
});
