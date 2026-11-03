const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LicenseService, LicenseError, DAY_MS, TERM_DAYS } = require('../src/licenses');

function memoryStore() {
  const map = new Map();
  return {
    all: () => [...map.values()],
    get: (id) => map.get(id) || null,
    find: (pred) => [...map.values()].find(pred) || null,
    put: (r) => map.set(r.id, JSON.parse(JSON.stringify(r))),
    save() {},
  };
}

function setup(start = Date.parse('2026-11-03T12:00:00Z')) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const clock = { t: start };
  const sent = [];
  const mailer = { send: async (m) => sent.push(m) };
  const svc = new LicenseService({ store: memoryStore(), privateKey, publicKey, now: () => clock.t, mailer });
  return { svc, clock, sent };
}

test('una clave se activa una vez, dura 30 días y queda ligada al equipo', () => {
  const { svc, clock } = setup();
  const { key, license } = svc.createLicense({ customer: 'Ana', email: 'ana@example.com' });
  assert.match(key, /^VBTP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(license.status, 'pending');

  const act = svc.activate(key, 'equipo-1');
  assert.equal(act.expiresAt, clock.t + TERM_DAYS * DAY_MS);
  assert.equal(svc.list()[0].status, 'active');
  assert.equal(svc.list()[0].deviceId, 'equipo-1');
});

test('la clave no funciona en un segundo equipo', () => {
  const { svc } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  svc.activate(key, 'equipo-1');
  assert.throws(() => svc.activate(key, 'equipo-2'), (e) => e instanceof LicenseError && e.code === 'bound_to_other_device');
});

test('la clave se acepta sin distinguir mayúsculas y espacios', () => {
  const { svc } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  assert.doesNotThrow(() => svc.activate('  ' + key.toLowerCase() + ' ', 'equipo-1'));
});

test('una clave inventada no activa nada', () => {
  const { svc } = setup();
  svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  assert.throws(() => svc.activate('VBTP-AAAA-BBBB-CCCC', 'equipo-1'), (e) => e.code === 'invalid_key');
});

test('el token válido se acepta y se renueva en cada validación', () => {
  const { svc, clock } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  const { token } = svc.activate(key, 'equipo-1');
  clock.t += DAY_MS;
  const v = svc.validate(token, 'equipo-1');
  assert.equal(v.valid, true);
  assert.equal(v.expiresAt, svc.list()[0].expiresAt);
  assert.equal(svc.verifyToken(v.token).dev, 'equipo-1');
});

test('un token de otro equipo o alterado no vale', () => {
  const { svc } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  const { token } = svc.activate(key, 'equipo-1');
  assert.throws(() => svc.validate(token, 'equipo-2'), (e) => e.code === 'invalid_token');
  const [body, sig] = token.split('.');
  const forged = body + '.' + Buffer.from('firma-falsa').toString('base64url');
  assert.throws(() => svc.validate(forged, 'equipo-1'), (e) => e.code === 'invalid_token');
  assert.ok(sig);
});

test('al vencer, la validación falla', () => {
  const { svc, clock } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  const { token } = svc.activate(key, 'equipo-1');
  clock.t += TERM_DAYS * DAY_MS + 1;
  assert.throws(() => svc.validate(token, 'equipo-1'), (e) => e.code === 'expired');
});

test('renovar suma 30 días desde el vencimiento si aún no ha vencido', () => {
  const { svc, clock } = setup();
  const { key, license } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  svc.activate(key, 'equipo-1');
  const before = svc.list()[0].expiresAt;
  clock.t += 5 * DAY_MS;
  const renewed = svc.renew(license.id);
  assert.equal(renewed.expiresAt, before + TERM_DAYS * DAY_MS);
});

test('renovar una licencia vencida parte de hoy', () => {
  const { svc, clock } = setup();
  const { key, license } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  svc.activate(key, 'equipo-1');
  clock.t += 60 * DAY_MS;
  const renewed = svc.renew(license.id);
  assert.equal(renewed.expiresAt, clock.t + TERM_DAYS * DAY_MS);
  assert.equal(renewed.status, 'active');
});

test('una licencia revocada no valida ni se activa', () => {
  const { svc } = setup();
  const { key, license } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  const { token } = svc.activate(key, 'equipo-1');
  svc.revoke(license.id);
  assert.throws(() => svc.validate(token, 'equipo-1'), (e) => e.code === 'revoked');
});

test('el cron marca vencidas y envía avisos a 7, 3 y 0 días, una sola vez cada uno', async () => {
  const { svc, clock, sent } = setup();
  const { key } = svc.createLicense({ customer: 'Ana', email: 'ana@x.com' });
  svc.activate(key, 'equipo-1');

  clock.t += (TERM_DAYS - 7) * DAY_MS; // quedan 7 días
  await svc.runCron();
  assert.deepEqual(sent.map((m) => m.threshold), [7]);

  await svc.runCron();
  assert.equal(sent.length, 1, 'no repite el mismo aviso');

  clock.t += 4 * DAY_MS; // quedan 3 días
  await svc.runCron();
  assert.deepEqual(sent.map((m) => m.threshold), [7, 3]);

  clock.t += 2.5 * DAY_MS; // queda medio día
  await svc.runCron();
  assert.deepEqual(sent.map((m) => m.threshold), [7, 3, 0]);

  clock.t += 1 * DAY_MS; // vencida
  await svc.runCron();
  assert.equal(svc.list()[0].status, 'expired');
});

test('renovar reinicia los avisos', async () => {
  const { svc, clock, sent } = setup();
  const { key, license } = svc.createLicense({ customer: 'Ana', email: 'a@x.com' });
  svc.activate(key, 'equipo-1');
  clock.t += (TERM_DAYS - 7) * DAY_MS;
  await svc.runCron();
  svc.renew(license.id); // vence en 60 días desde el inicio; hoy quedan 37
  clock.t += TERM_DAYS * DAY_MS; // quedan 7 días otra vez
  await svc.runCron();
  assert.deepEqual(sent.map((m) => m.threshold), [7, 7]);
});
