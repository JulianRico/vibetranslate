/** Minimal Chrome DevTools Protocol driver (no dependencies) for end-to-end tests. */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome(env = process.env) {
  const local = env.LOCALAPPDATA || '';
  const candidates = [
    env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

/**
 * Launches headless Chrome and returns a small driver.
 * `scriptOnNewDocument` runs before any page script (used to inject fake speech/translator).
 */
export async function launch({ width = 1400, height = 900, scriptOnNewDocument } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-e2e-chrome-'));
  const proc = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(message.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(`${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.trim()); // CSP violations, failed loads
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  if (scriptOnNewDocument) await send('Page.addScriptToEvaluateOnNewDocument', { source: scriptOnNewDocument });

  const api = {
    errors,
    send,
    async goto(url) { await send('Page.navigate', { url }); await sleep(400); },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n${expression}`);
      return r.result.value;
    },
    async waitFor(expression, timeout = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await api.eval(expression)) return true; } catch { /* page still loading */ }
        await sleep(100);
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    },
    click: (selector) => api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('no element ' + ${JSON.stringify(selector)}); e.click(); return true; })()`),
    fill: (selector, value) => api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('no element ' + ${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`),
    text: (selector) => api.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`),
    count: (selector) => api.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    /** Selects files in an <input type=file> (hidden inputs work too). */
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no element ${selector}`);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      proc.kill();
      await sleep(300);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Chrome still releasing files */ }
    },
  };
  return api;
}
