import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// The page may only load its own scripts and styles and talk to its own origin.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Serves files from `publicDir` and nothing outside it. Returns true when it handled the request. */
export function createStaticHandler(publicDir) {
  const root = path.resolve(publicDir);
  return async function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    if (rel.includes('\0')) return false;
    const target = path.resolve(root, `.${rel.endsWith('/') ? `${rel}index.html` : rel}`);
    if (target !== root && !target.startsWith(root + path.sep)) return false;
    const type = MIME[path.extname(target).toLowerCase()];
    if (!type) return false;
    let data;
    try {
      if (!(await fs.stat(target)).isFile()) return false;
      data = await fs.readFile(target);
    } catch {
      return false;
    }
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  };
}
