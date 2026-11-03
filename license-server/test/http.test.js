const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, loadSigningKeys } = require('../src/server');
const { LicenseService } = require('../src/licenses');
const { JsonStore } = require('../src/store');

const ADMIN = 'x'.repeat(40);

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'));
  const { privateKey, publicKey } = loadSigningKeys(dir);
  const service = new LicenseService({ store: new JsonStore(path.join(dir, 'l.json')), privateKey, publicKey });
  const app = createApp({ service, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), adminToken: ADMIN });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  };
  return { server, call };
}

test('flujo completo: crear, activar, validar y rechazar sin token de administrador', async () => {
  const { server, call } = await boot();
  try {
    const admin = { Authorization: 'Bearer ' + ADMIN };

    const noAuth = await call('POST', '/admin/licenses', { customer: 'Ana', email: 'a@x.com' });
    assert.equal(noAuth.status, 401);

    const created = await call('POST', '/admin/licenses', { customer: 'Ana', email: 'a@x.com' }, admin);
    assert.equal(created.status, 201);
    const { key } = created.json;

    const act = await call('POST', '/v1/activate', { key, deviceId: 'equipo-1' });
    assert.equal(act.status, 200);
    assert.ok(act.json.token.includes('.'));

    const val = await call('POST', '/v1/validate', { token: act.json.token, deviceId: 'equipo-1' });
    assert.equal(val.status, 200);
    assert.equal(val.json.valid, true);

    const other = await call('POST', '/v1/activate', { key, deviceId: 'equipo-2' });
    assert.equal(other.status, 409);
    assert.equal(other.json.error, 'bound_to_other_device');

    const pk = await call('GET', '/v1/public-key');
    assert.match(pk.json.publicKey, /BEGIN PUBLIC KEY/);
  } finally {
    server.close();
  }
});

test('cuerpo demasiado grande o JSON inválido devuelven error controlado', async () => {
  const { server, call } = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{no es json',
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
