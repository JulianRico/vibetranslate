import { LIMITS } from '../../../domain/context-item.js';
import { readBody, readJson } from '../body.js';
import { reply } from '../router.js';

export function createContextRoutes({
  listContext, getContextItem, addContextFromFile, addContextFromText, updateContext, deleteContext,
}) {
  return [
    { method: 'GET', path: '/api/context', handler: async () => reply(await listContext()) },
    { method: 'GET', path: '/api/context/:id', handler: async ({ params }) => reply(await getContextItem({ id: params.id })) },
    {
      // Raw file bytes in the body (no multipart); name and kind travel in the query string.
      method: 'POST',
      path: '/api/context/file',
      handler: async ({ req, url, signal }) => {
        const buffer = await readBody(req, LIMITS.MAX_UPLOAD_BYTES);
        const item = await addContextFromFile({
          buffer,
          filename: url.searchParams.get('filename') ?? '',
          kind: url.searchParams.get('kind') ?? undefined,
          signal,
        });
        return reply(item, 201);
      },
    },
    { method: 'POST', path: '/api/context/text', handler: async ({ req }) => reply(await addContextFromText(await readJson(req)), 201) },
    {
      method: 'PATCH',
      path: '/api/context/:id',
      handler: async ({ req, params }) => reply(await updateContext({ id: params.id, patch: await readJson(req) })),
    },
    {
      method: 'DELETE',
      path: '/api/context/:id',
      handler: async ({ params }) => { await deleteContext({ id: params.id }); return reply(null, 204); },
    },
  ];
}
