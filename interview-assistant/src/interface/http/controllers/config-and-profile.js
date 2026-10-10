import { readJson } from '../body.js';
import { reply } from '../router.js';

export function createConfigRoutes({ getConfig }) {
  return [{ method: 'GET', path: '/api/config', handler: async () => reply(await getConfig()) }];
}

export function createProfileRoutes({ getProfile, saveProfile }) {
  return [
    { method: 'GET', path: '/api/profile', handler: async () => reply(await getProfile()) },
    { method: 'PUT', path: '/api/profile', handler: async ({ req }) => reply(await saveProfile(await readJson(req))) },
  ];
}
