// licenses.js - Núcleo del servidor de licencias. Sin dependencias externas.
// Una licencia es una clave VBTP-XXXX-XXXX-XXXX, activa 30 días desde la activación,
// ligada a un único equipo. El servidor firma tokens con Ed25519; la app solo necesita la clave pública.
const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const TERM_DAYS = 30;
const REMINDER_DAYS = [7, 3, 0];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0, O, 1, I

function normalizeKey(key) {
  return String(key || '').trim().toUpperCase();
}

function hashKey(key) {
  return crypto.createHash('sha256').update(normalizeKey(key)).digest('hex');
}

function newKey() {
  // 256 es múltiplo de 32: el módulo no introduce sesgo.
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `VBTP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

class LicenseError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

class LicenseService {
  /**
   * @param {object} opts
   * @param {object} opts.store      { all(), get(id), find(pred), put(record), save() }
   * @param {import('node:crypto').KeyObject} opts.privateKey  Ed25519
   * @param {import('node:crypto').KeyObject} opts.publicKey   Ed25519
   * @param {() => number} [opts.now]
   * @param {{send(msg):Promise<void>}} [opts.mailer]
   */
  constructor({ store, privateKey, publicKey, now = () => Date.now(), mailer = null }) {
    this.store = store;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.now = now;
    this.mailer = mailer;
  }

  createLicense({ customer, email }) {
    if (!customer || !email) throw new LicenseError('missing_fields', 400);
    const key = newKey();
    const record = {
      id: crypto.randomUUID(),
      keyHash: hashKey(key),
      customer: String(customer).slice(0, 200),
      email: String(email).slice(0, 200),
      status: 'pending', // pending | active | expired | revoked
      deviceId: null,
      activatedAt: null,
      expiresAt: null,
      createdAt: this.now(),
      reminders: [],
    };
    this.store.put(record);
    this.store.save();
    return { key, license: publicView(record) };
  }

  activate(key, deviceId) {
    if (!deviceId) throw new LicenseError('missing_device', 400);
    const record = this.store.find((r) => r.keyHash === hashKey(key));
    if (!record) throw new LicenseError('invalid_key', 404);
    if (record.status === 'revoked') throw new LicenseError('revoked', 403);
    if (record.deviceId && record.deviceId !== deviceId) throw new LicenseError('bound_to_other_device', 409);

    const now = this.now();
    if (record.status === 'pending') {
      record.status = 'active';
      record.deviceId = deviceId;
      record.activatedAt = now;
      record.expiresAt = now + TERM_DAYS * DAY_MS;
      this.store.put(record);
      this.store.save();
    }
    if (record.expiresAt <= now) throw new LicenseError('expired', 403);
    return { token: this.issueToken(record), expiresAt: record.expiresAt, license: publicView(record) };
  }

  validate(token, deviceId) {
    const payload = this.verifyToken(token);
    if (!payload || payload.dev !== deviceId) throw new LicenseError('invalid_token', 401);
    const record = this.store.get(payload.lid);
    if (!record || record.deviceId !== deviceId) throw new LicenseError('invalid_token', 401);
    if (record.status === 'revoked') throw new LicenseError('revoked', 403);
    if (record.expiresAt <= this.now()) throw new LicenseError('expired', 403);
    // Se devuelve un token nuevo en cada validación: así una renovación llega a la app en la siguiente comprobación.
    return { valid: true, expiresAt: record.expiresAt, token: this.issueToken(record) };
  }

  renew(id) {
    const record = this.store.get(id);
    if (!record) throw new LicenseError('not_found', 404);
    if (record.status === 'revoked') throw new LicenseError('revoked', 403);
    const base = Math.max(this.now(), record.expiresAt || 0);
    record.expiresAt = base + TERM_DAYS * DAY_MS;
    record.status = record.deviceId ? 'active' : 'pending';
    record.reminders = [];
    this.store.put(record);
    this.store.save();
    return publicView(record);
  }

  revoke(id) {
    const record = this.store.get(id);
    if (!record) throw new LicenseError('not_found', 404);
    record.status = 'revoked';
    this.store.put(record);
    this.store.save();
    return publicView(record);
  }

  list() {
    return this.store.all().map(publicView);
  }

  /** Ejecutar una vez al día. Marca vencidas y envía avisos a 7, 3 y 0 días. */
  async runCron() {
    const now = this.now();
    const sent = [];
    for (const record of this.store.all()) {
      if (record.status !== 'active' || !record.expiresAt) continue;
      if (record.expiresAt <= now) {
        record.status = 'expired';
        this.store.put(record);
        continue;
      }
      const remainingMs = record.expiresAt - now;
      for (const threshold of REMINDER_DAYS) {
        // El aviso de "0" significa que queda menos de un día.
        const limitMs = threshold === 0 ? DAY_MS : threshold * DAY_MS;
        if (remainingMs <= limitMs && !record.reminders.includes(threshold)) {
          record.reminders.push(threshold);
          this.store.put(record);
          if (this.mailer) {
            await this.mailer.send({
              to: record.email,
              threshold,
              customer: record.customer,
              expiresAt: record.expiresAt,
            });
          }
          sent.push({ id: record.id, threshold });
          break; // un aviso por ejecución
        }
      }
    }
    this.store.save();
    return sent;
  }

  issueToken(record) {
    const payload = { lid: record.id, dev: record.deviceId, exp: record.expiresAt };
    const body = b64url(JSON.stringify(payload));
    const sig = crypto.sign(null, Buffer.from(body), this.privateKey).toString('base64url');
    return `${body}.${sig}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const ok = crypto.verify(null, Buffer.from(body), this.publicKey, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
}

function publicView(record) {
  return {
    id: record.id,
    customer: record.customer,
    email: record.email,
    status: record.status,
    deviceId: record.deviceId,
    activatedAt: record.activatedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

module.exports = { LicenseService, LicenseError, newKey, hashKey, normalizeKey, TERM_DAYS, REMINDER_DAYS, DAY_MS };
