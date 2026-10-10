import { readJson } from '../body.js';
import { reply } from '../router.js';

export function createPreparedRoutes({ listPrepared, addPrepared, updatePrepared, deletePrepared, generatePrepared }) {
  return [
    { method: 'GET', path: '/api/prepared', handler: async () => reply(await listPrepared()) },
    {
      method: 'POST',
      path: '/api/prepared',
      handler: async ({ req }) => {
        const body = await readJson(req);
        return reply(await addPrepared({ question: body.question, triggers: body.triggers }), 201);
      },
    },
    {
      method: 'PATCH',
      path: '/api/prepared/:id',
      handler: async ({ req, params }) => reply(await updatePrepared({ id: params.id, patch: await readJson(req) })),
    },
    {
      method: 'DELETE',
      path: '/api/prepared/:id',
      handler: async ({ params }) => { await deletePrepared({ id: params.id }); return reply(null, 204); },
    },
    {
      // `?force=1` regenerates an answer the user edited.
      method: 'POST',
      path: '/api/prepared/:id/generate',
      handler: async ({ params, url, signal }) => reply(await generatePrepared({ id: params.id, force: url.searchParams.get('force') === '1', signal })),
    },
  ];
}
