import path from 'node:path';
import { createLock, readJsonFile, writeJsonAtomic } from './json-file.js';

/** ContextRepository stored as `<dir>/index.json` (an array of items, text included). Writes are serialized. */
export function createFileContextRepository({ dir }) {
  const file = path.join(dir, 'index.json');
  const locked = createLock();
  const read = async () => {
    const data = await readJsonFile(file, []);
    return Array.isArray(data) ? data : [];
  };
  return {
    list: read,
    async get(id) {
      return (await read()).find((item) => item.id === id) ?? null;
    },
    add: (item) => locked(async () => {
      const items = await read();
      items.push(item);
      await writeJsonAtomic(file, items);
      return item;
    }),
    update: (id, patch) => locked(async () => {
      const items = await read();
      const idx = items.findIndex((item) => item.id === id);
      if (idx < 0) return null;
      items[idx] = { ...items[idx], ...patch };
      await writeJsonAtomic(file, items);
      return items[idx];
    }),
    remove: (id) => locked(async () => {
      const items = await read();
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return false;
      await writeJsonAtomic(file, next);
      return true;
    }),
  };
}
