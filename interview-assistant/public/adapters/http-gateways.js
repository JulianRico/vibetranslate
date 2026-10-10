/**
 * HTTP adapters for SuggestionGatewayPort and ContextGatewayPort.
 * Errors carry the server's own message (`{ error }`) plus `status` and `code`.
 * `fetchImpl` is injectable for tests.
 */
export function createHttpClient({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  return async function request(path, { method = 'GET', body, headers, signal } = {}) {
    let res;
    try {
      res = await fetchImpl(path, { method, body, headers, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new Error('No se pudo conectar con el servidor local. ¿Sigue corriendo `npm start`?');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status, code: data?.code });
    return data;
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export function createHttpSuggestionGateway(request) {
  return {
    suggest: (payload, { signal } = {}) => request('/api/suggest', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload), signal }),
  };
}

export function createHttpPreparedGateway(request) {
  const json = (method, path, body) => request(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
  const url = (id) => `/api/prepared/${encodeURIComponent(id)}`;
  return {
    list: () => request('/api/prepared'),
    add: (body) => json('POST', '/api/prepared', body),
    update: (id, patch) => json('PATCH', url(id), patch),
    remove: (id) => request(url(id), { method: 'DELETE' }),
    /** `force` regenerates an answer the user edited. */
    generate: (id, { force = false, signal } = {}) => request(`${url(id)}/generate${force ? '?force=1' : ''}`, { method: 'POST', signal }),
  };
}

export function createHttpContextGateway(request) {
  const json = (method, path, body) => request(path, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
  return {
    config: () => request('/api/config'),
    list: () => request('/api/context'),
    /** Sends the raw bytes of the file (no multipart); name and kind go in the query string. */
    uploadFile: (file, { kind } = {}, { signal } = {}) => {
      const query = new URLSearchParams({ filename: file.name });
      if (kind) query.set('kind', kind);
      return request(`/api/context/file?${query}`, { method: 'POST', body: file, signal });
    },
    addText: (body) => json('POST', '/api/context/text', body),
    update: (id, patch) => json('PATCH', `/api/context/${encodeURIComponent(id)}`, patch),
    remove: (id) => request(`/api/context/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getProfile: () => request('/api/profile'),
    saveProfile: (profile) => json('PUT', '/api/profile', profile),
    coachSystemPrompt: ({ mode, maxChars }) => request(`/api/coach/system-prompt?${new URLSearchParams({ mode, maxChars: String(maxChars) })}`),
  };
}
