import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.js';

/** Domain error code → HTTP status. This is the only place that knows about status numbers. */
export const STATUS_BY_CODE = Object.freeze({
  VALIDATION: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FORMAT: 415,
  NOT_CONFIGURED: 503,
  UPSTREAM: 502,
  FORBIDDEN: 403,
});

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const JSON_HEADERS = { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' };

/** What route handlers return. A null body sends no content (e.g. 204). */
export const reply = (body, status = 200) => ({ status, body });

function sendReply(res, { status, body }) {
  if (res.destroyed) return;
  if (body === null || body === undefined) {
    res.writeHead(status, BASE_HEADERS);
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function sendError(res, err, logger) {
  if (res.destroyed || res.headersSent || err?.name === 'AbortError') {
    if (!res.destroyed && !res.writableEnded) res.end();
    return;
  }
  const status = STATUS_BY_CODE[err?.code];
  if (!status) {
    logger.error(err);
    res.writeHead(500, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'Internal error', code: 'INTERNAL' }));
    return;
  }
  res.writeHead(status, status === 413 ? { ...JSON_HEADERS, connection: 'close' } : JSON_HEADERS);
  res.end(JSON.stringify({ error: err.message, code: err.code }));
}

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOf(host) {
  const h = String(host ?? '').toLowerCase();
  return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
}

/**
 * This server holds a Gemini key and the user's documents, so only the page it serves may talk to it.
 * - Host must be localhost: a page on another domain that rebinds its DNS to 127.0.0.1 still sends its own Host.
 * - Origin, when present, must be this very origin: browsers always send it on cross-site writes (even no-cors forms).
 */
function assertLocalRequest(req) {
  const host = req.headers.host;
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host))) throw new ForbiddenError('Host no permitido: esta app solo responde en localhost');
  const origin = req.headers.origin;
  if (origin !== undefined && String(origin).toLowerCase() !== `http://${String(host).toLowerCase()}`) {
    throw new ForbiddenError('Origen no permitido: la petición viene de otra página');
  }
}

function compile(route) {
  const keys = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
  const regex = new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, '([^/]+)')}$`);
  return { ...route, keys, regex };
}

/**
 * HTTP ↔ use-case adapter. A route is `{ method, path, handler }`; `path` may contain `:params`.
 * Handlers receive `{ req, res, url, params, signal }` (the signal aborts when the client disconnects)
 * and return `reply(body, status)`.
 */
export function createRouter({ routes, staticHandler, logger = console }) {
  const compiled = routes.map(compile);
  return async function handle(req, res) {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      assertLocalRequest(req);
      const url = new URL(req.url, 'http://localhost');
      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        let params;
        try {
          params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
        } catch {
          throw new ValidationError('Ruta con codificación inválida');
        }
        sendReply(res, await route.handler({ req, res, url, params, signal: abort.signal }));
        return;
      }
      if (!url.pathname.startsWith('/api/') && staticHandler && await staticHandler(req, res, url)) return;
      throw new NotFoundError('No encontrado');
    } catch (err) {
      sendError(res, err, logger);
    }
  };
}
