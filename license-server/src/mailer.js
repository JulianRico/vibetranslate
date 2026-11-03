// mailer.js - Envío de avisos de vencimiento desde ventas@tikal.com.co.
// Sin SMTP configurado, los avisos se guardan en outbox.jsonl (útil para probar).
const fs = require('node:fs');
const path = require('node:path');

const SUBJECTS = {
  7: 'Tu licencia de ViBeTranslate Pro vence en 7 días',
  3: 'Tu licencia de ViBeTranslate Pro vence en 3 días',
  0: 'Tu licencia de ViBeTranslate Pro vence hoy',
};

function bodyFor(msg) {
  const date = new Date(msg.expiresAt).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  return [
    `Hola ${msg.customer},`,
    '',
    `Tu licencia de ViBeTranslate Pro vence el ${date}.`,
    'Para renovarla, responde a este correo o escribe a ventas@tikal.com.co con el identificador de tu equipo, que aparece en la pantalla de licencia de la app.',
    '',
    'Equipo de Tikal Solutions',
  ].join('\n');
}

class OutboxMailer {
  constructor(file) {
    this.file = file;
  }
  async send(msg) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), to: msg.to, subject: SUBJECTS[msg.threshold], body: bodyFor(msg) });
    fs.appendFileSync(this.file, line + '\n');
  }
}

class SmtpMailer {
  constructor(cfg) {
    // nodemailer se carga solo si hay SMTP configurado.
    const nodemailer = require('nodemailer');
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: Number(cfg.port || 587),
      secure: Number(cfg.port) === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    this.from = cfg.from || 'ventas@tikal.com.co';
  }
  async send(msg) {
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: SUBJECTS[msg.threshold],
      text: bodyFor(msg),
    });
  }
}

function makeMailer({ dataDir, env }) {
  if (env.SMTP_HOST) {
    return new SmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.MAIL_FROM,
    });
  }
  return new OutboxMailer(path.join(dataDir, 'outbox.jsonl'));
}

module.exports = { makeMailer, OutboxMailer, SmtpMailer, bodyFor, SUBJECTS };
