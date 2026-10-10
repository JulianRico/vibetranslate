import fs from 'node:fs/promises';
import path from 'node:path';

/** Parsed JSON file, or `fallback` when it is missing or corrupt. */
export async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes through a temp file + rename so a crash never leaves a half-written file. */
export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Runs async functions one at a time, in call order (a failure does not block the next one). */
export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}
