import fs from 'node:fs/promises';
import path from 'node:path';
import { createLock, writeJsonAtomic } from './json-file.js';

/**
 * PreparedRepository stored as `<dir>/prepared.json` (an array). Writes are serialized.
 * `list()` returns null when there is no usable file yet (the use cases then seed the starter bank).
 * A file that cannot be read as an array is moved aside to `prepared.json.corrupt-<time>` instead of being overwritten.
 */
export function createFilePreparedRepository({ dir }) {
  const file = path.join(dir, 'prepared.json');
  const locked = createLock();

  async function read() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return data;
    } catch { /* corrupt: handled below */ }
    // Only a file that vanished meanwhile may be ignored: if it cannot be set aside, fail rather than let the seed overwrite it.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    return null;
  }
  const write = (items) => writeJsonAtomic(file, items);

  return {
    list: read,
    replaceAll: (items) => locked(() => write(items)),
    async get(id) {
      return ((await read()) ?? []).find((item) => item.id === id) ?? null;
    },
    add: (item) => locked(async () => {
      const items = (await read()) ?? [];
      items.push(item);
      await write(items);
      return item;
    }),
    update: (id, item) => locked(async () => {
      const items = (await read()) ?? [];
      const idx = items.findIndex((i) => i.id === id);
      if (idx < 0) return null;
      items[idx] = item;
      await write(items);
      return item;
    }),
    remove: (id) => locked(async () => {
      const items = (await read()) ?? [];
      const next = items.filter((i) => i.id !== id);
      if (next.length === items.length) return false;
      await write(next);
      return true;
    }),
  };
}
