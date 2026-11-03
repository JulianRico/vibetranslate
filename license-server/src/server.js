// server.js - API HTTP de licencias para ViBeTranslate Pro.
// Va detrás de un proxy inverso con HTTPS (nginx, Caddy, IIS...). No sirve HTTP sin cifrar a internet.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { LicenseService, LicenseError } = require('./licenses');
const { JsonStore } = require('./store');
const { makeMailer } = require('./mailer');

const MAX_BODY = 10 * 1024;

function loadSigningKeys(dataDir) {
  const file = path.join(dataDir, 'ed25519-private.pem');
  if (!fs.existsSync(file)) {
    const pair = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new LicenseError('body_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new LicenseError('bad_json', 400));
      }
    });
    req.on('error', reject);
  });
}

function adminAuthorized(req, adminToken) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(adminToken);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function createApp({ service, publicKeyPem, adminToken }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/public-key') {
        return send(res, 200, { publicKey: publicKeyPem });
      }

      if (req.method === 'POST' && url.pathname === '/v1/activate') {
        const b = await readJson(req);
        const out = service.activate(b.key, b.deviceId);
        return send(res, 200, { token: out.token, expiresAt: out.expiresAt });
      }

      if (req.method === 'POST' && url.pathname === '/v1/validate') {
        const b = await readJson(req);
        const out = service.validate(b.token, b.deviceId);
        return send(res, 200, out);
      }

      if (url.pathname.startsWith('/admin/')) {
        if (!adminAuthorized(req, adminToken)) return send(res, 401, { error: 'unauthorized' });

        if (req.method === 'GET' && url.pathname === '/admin/licenses') {
          return send(res, 200, { licenses: service.list() });
        }
        if (req.method === 'POST' && url.pathname === '/admin/licenses') {
          const b = await readJson(req);
          return send(res, 201, service.createLicense({ customer: b.customer, email: b.email }));
        }
        const m = url.pathname.match(/^\/admin\/licenses\/([0-9a-f-]{36})\/(renew|revoke)$/);
        if (req.method === 'POST' && m) {
          const license = m[2] === 'renew' ? service.renew(m[1]) : service.revoke(m[1]);
          return send(res, 200, { license });
        }
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof LicenseError) return send(res, err.status, { error: err.code });
      console.error('error interno:', err);
      return send(res, 500, { error: 'internal' });
    }
  };
}

function start(config = {}) {
  const dataDir = config.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const adminToken = config.adminToken || process.env.ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 32) {
    throw new Error('ADMIN_TOKEN debe existir y tener al menos 32 caracteres');
  }
  const { privateKey, publicKey } = loadSigningKeys(dataDir);
  const store = new JsonStore(path.join(dataDir, 'licenses.json'));
  const mailer = makeMailer({ dataDir, env: process.env });
  const service = new LicenseService({ store, privateKey, publicKey, mailer });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const server = http.createServer(createApp({ service, publicKeyPem, adminToken }));

  const DAY = 24 * 60 * 60 * 1000;
  const cron = setInterval(() => {
    service.runCron().catch((err) => console.error('cron:', err));
  }, DAY);
  cron.unref();

  const port = Number(config.port || process.env.PORT || 8080);
  const host = config.host || process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`licencias escuchando en ${host}:${port}`));
  return { server, service, cron };
}

if (require.main === module) {
  start();
}

module.exports = { start, createApp, loadSigningKeys };
