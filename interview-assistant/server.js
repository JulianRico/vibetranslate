import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAddContextFromFile } from './src/application/use-cases/add-context-from-file.js';
import { createAddContextFromText } from './src/application/use-cases/add-context-from-text.js';
import {
  createListContext, createGetContextItem, createUpdateContext, createDeleteContext,
} from './src/application/use-cases/manage-context.js';
import { createGetProfile, createSaveProfile, createGetConfig } from './src/application/use-cases/profile-and-config.js';
import { createBuildCoachSystemPrompt } from './src/application/use-cases/build-coach-system-prompt.js';
import { createSuggestAnswer } from './src/application/use-cases/suggest-answer.js';
import {
  createListPrepared, createAddPrepared, createUpdatePrepared, createDeletePrepared, createGeneratePrepared,
} from './src/application/use-cases/prepared.js';

import { createGeminiGateway } from './src/infrastructure/gemini-gateway.js';
import { createFileProfileRepository } from './src/infrastructure/file-profile-repository.js';
import { createFileContextRepository } from './src/infrastructure/file-context-repository.js';
import { createFilePreparedRepository } from './src/infrastructure/file-prepared-repository.js';
import { createExtractors } from './src/infrastructure/extractors/registry.js';
import { createIdGenerator, createClock } from './src/infrastructure/system.js';
import { loadEnv } from './src/infrastructure/env.js';

import { createRouter } from './src/interface/http/router.js';
import { createStaticHandler } from './src/interface/http/static-files.js';
import { createConfigRoutes, createProfileRoutes } from './src/interface/http/controllers/config-and-profile.js';
import { createContextRoutes } from './src/interface/http/controllers/context.js';
import { createCoachRoutes } from './src/interface/http/controllers/coach.js';
import { createPreparedRoutes } from './src/interface/http/controllers/prepared.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3100;

/**
 * Composition root: the only place that knows the concrete implementations and wires them to the use cases.
 * `llm` can be injected (tests); otherwise the Gemini gateway is built from `env`.
 */
export function buildApp({
  env = {}, llm, dataDir = path.join(ROOT, 'data'), publicDir = path.join(ROOT, 'public'), seedProfileFile,
} = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const gateway = llm ?? createGeminiGateway({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || undefined });
  const profileRepo = createFileProfileRepository({ dir: dataDir, seedFile: seedProfileFile });
  const contextRepo = createFileContextRepository({ dir: path.join(dataDir, 'context') });
  const preparedRepo = createFilePreparedRepository({ dir: dataDir });
  const extractors = createExtractors({ llm: gateway });
  const ids = createIdGenerator();
  const preparedIds = createIdGenerator('p_');
  const clock = createClock();
  const suggestAnswer = createSuggestAnswer({ llm: gateway, profileRepo, contextRepo });

  const routes = [
    ...createConfigRoutes({ getConfig: createGetConfig({ llm: gateway, version }) }),
    ...createProfileRoutes({ getProfile: createGetProfile({ profileRepo }), saveProfile: createSaveProfile({ profileRepo }) }),
    ...createContextRoutes({
      listContext: createListContext({ contextRepo }),
      getContextItem: createGetContextItem({ contextRepo }),
      addContextFromFile: createAddContextFromFile({ contextRepo, extractors, ids, clock }),
      addContextFromText: createAddContextFromText({ contextRepo, ids, clock }),
      updateContext: createUpdateContext({ contextRepo }),
      deleteContext: createDeleteContext({ contextRepo }),
    }),
    ...createCoachRoutes({
      suggestAnswer,
      buildCoachSystemPrompt: createBuildCoachSystemPrompt({ profileRepo, contextRepo }),
    }),
    ...createPreparedRoutes({
      listPrepared: createListPrepared({ preparedRepo, clock }),
      addPrepared: createAddPrepared({ preparedRepo, ids: preparedIds, clock }),
      updatePrepared: createUpdatePrepared({ preparedRepo, clock }),
      deletePrepared: createDeletePrepared({ preparedRepo, clock }),
      generatePrepared: createGeneratePrepared({ preparedRepo, suggestAnswer, clock }),
    }),
  ];
  return http.createServer(createRouter({ routes, staticHandler: createStaticHandler(publicDir) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
  const port = Number(env.PORT) || DEFAULT_PORT;
  buildApp({ env, seedProfileFile: path.join(ROOT, '..', 'data', 'profile.json') }).listen(port, '127.0.0.1', () => {
    const model = env.GEMINI_API_KEY ? env.GEMINI_MODEL || 'gemini-2.5-flash' : 'sin GEMINI_API_KEY (PDF, audio y sugerencias desactivados)';
    console.log(`Interview Assistant → http://127.0.0.1:${port}  (Gemini: ${model})`);
  });
}
