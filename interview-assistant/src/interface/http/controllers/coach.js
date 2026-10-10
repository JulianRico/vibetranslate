import { readJson } from '../body.js';
import { reply } from '../router.js';

export function createCoachRoutes({ suggestAnswer, buildCoachSystemPrompt }) {
  return [
    {
      method: 'POST',
      path: '/api/suggest',
      handler: async ({ req, signal }) => {
        const body = await readJson(req);
        return reply(await suggestAnswer({ turns: body.turns, history: body.history, signal }));
      },
    },
    {
      method: 'GET',
      path: '/api/coach/system-prompt',
      handler: async ({ url }) => {
        const raw = url.searchParams.get('maxChars');
        return reply(await buildCoachSystemPrompt({
          mode: url.searchParams.get('mode') ?? 'cloud',
          maxChars: raw === null ? undefined : Number(raw),
        }));
      },
    },
  ];
}
