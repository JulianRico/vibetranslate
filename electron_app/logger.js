/**
 * logger.js - Sistema Unificado de Registro y Diagnóstico para MeetTranslate Desktop
 */

const fs = require('fs');
const path = require('path');

class DesktopLogger {
  constructor(logFileName = 'desktop_app.log') {
    this.logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
    this.logFilePath = path.join(this.logsDir, logFileName);
    this.listeners = [];
  }

  log(category, message, data = null) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    let logLine = `[${timestamp}] [${category.toUpperCase()}] ${message}`;
    if (data !== null) {
      if (typeof data === 'object') {
        try { logLine += ` | ${JSON.stringify(data)}`; } catch (e) { logLine += ` | [Object]`; }
      } else {
        logLine += ` | ${data}`;
      }
    }

    console.log(logLine);

    try {
      fs.appendFileSync(this.logFilePath, logLine + '\n', 'utf8');
    } catch (e) {}

    // Notificar a listeners de UI si existen
    this.listeners.forEach(fn => {
      try { fn({ timestamp, category, message, data, raw: logLine }); } catch (e) {}
    });
  }

  info(cat, msg, data) { this.log(cat, msg, data); }
  warn(cat, msg, data) { this.log(`⚠️ ${cat}`, msg, data); }
  error(cat, msg, data) { this.log(`🔴 ERROR:${cat}`, msg, data); }
  success(cat, msg, data) { this.log(`🟢 ${cat}`, msg, data); }

  onLog(fn) {
    this.listeners.push(fn);
  }

  clear() {
    try {
      fs.writeFileSync(this.logFilePath, `=== MeetTranslate Desktop Logs Iniciados: ${new Date().toISOString()} ===\n`, 'utf8');
    } catch (e) {}
  }
}

const defaultLogger = new DesktopLogger();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { defaultLogger, DesktopLogger };
}
