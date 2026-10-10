/**
 * Manual smoke test against the REAL Gemini API (uses GEMINI_API_KEY from .env or the environment).
 * Confirms the request shapes this app relies on: JSON text, inline PDF, inline audio, and the latency
 * of a realistic coach suggestion. Run with: npm run smoke:gemini
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/infrastructure/env.js';
import { createGeminiGateway } from '../src/infrastructure/gemini-gateway.js';
import { buildSystemPrompt, buildUserPrompt } from '../src/domain/coach-prompt.js';
import { normalizeProfile } from '../src/domain/profile.js';
import { normalizeSuggestion } from '../src/domain/suggestion.js';
import { tinyPdf, toneWav } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env };
if (!env.GEMINI_API_KEY) {
  console.error('Falta GEMINI_API_KEY: ponla en interview-assistant/.env (copia .env.example) o en el entorno.');
  process.exit(1);
}
const llm = createGeminiGateway({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || undefined, retries: 0 });
console.log(`Modelo: ${llm.model}\n`);

let failed = 0;
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const out = await fn();
    console.log(`✔ ${name} — ${Math.round(performance.now() - t0)} ms\n  ${out}\n`);
  } catch (err) {
    failed++;
    console.log(`✖ ${name} — ${Math.round(performance.now() - t0)} ms\n  ${err.message}\n`);
  }
}

await step('1. JSON de texto', async () => {
  const out = await llm.generateJson({ system: 'Reply with the JSON {"ok": true, "say": "hello"}.', prompt: 'ping', temperature: 0 });
  if (out?.ok !== true) throw new Error(`respuesta inesperada: ${JSON.stringify(out)}`);
  return JSON.stringify(out);
});

await step('2. PDF en línea (debe devolver el texto "Hello Julian Quintero")', async () => {
  const text = await llm.extractText({
    mimeType: 'application/pdf', data: tinyPdf('Hello Julian Quintero'),
    instruction: 'Extract all the text of this document. Output only the text.',
  });
  if (!/Julian/i.test(text)) throw new Error(`no encontré "Julian" en: ${text.slice(0, 120)}`);
  return JSON.stringify(text.slice(0, 120));
});

await step('3. Audio WAV en línea (un tono: sin voz que transcribir)', async () => {
  try {
    const text = await llm.extractText({
      mimeType: 'audio/wav', data: toneWav({ seconds: 1 }),
      instruction: 'Transcribe this audio verbatim. If there is no speech, say "(no speech)".',
    });
    return `petición aceptada; respuesta: ${JSON.stringify(text.slice(0, 80))}`;
  } catch (err) {
    if (/no devolvió texto/.test(err.message)) return 'petición aceptada (sin texto que devolver)';
    throw err;
  }
});

await step('4. Sugerencia realista del coach (objetivo: menos de ~3000 ms)', async () => {
  const profile = normalizeProfile({
    name: 'Julian', headline: 'Full Stack Lead', summary: '14 years leading teams building .NET, Azure and React products.',
    skills: ['.NET', 'Azure', 'React', 'TypeScript'],
    experience: [{ company: 'Acme', role: 'Development Lead', period: '2020-2024', highlights: ['Led a team of 6', 'Migrated a monolith to Azure'] }],
  });
  const raw = await llm.generateJson({
    system: buildSystemPrompt({ profile, included: [], mode: 'cloud' }),
    prompt: buildUserPrompt({ turns: ['Tell me about a time you led a team through a difficult migration.'] }),
    temperature: 0.5,
  });
  const s = normalizeSuggestion(raw);
  return `${s.answer.en}\n  ${s.answer.es}`;
});

console.log(failed ? `${failed} paso(s) fallaron.` : 'Todo en orden: las peticiones de Gemini tienen la forma esperada.');
process.exit(failed ? 1 : 0);
