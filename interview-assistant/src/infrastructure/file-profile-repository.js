import path from 'node:path';
import { emptyProfile, normalizeProfile } from '../domain/profile.js';
import { profileFromCvAgent } from './cv-agent-profile.js';
import { createLock, readJsonFile, writeJsonAtomic } from './json-file.js';

/**
 * ProfileRepository stored as `<dir>/profile.json`. When it does not exist yet (or is corrupt), the profile is
 * seeded from `seedFile` (the CV Agent's profile.json, read-only) and otherwise starts empty.
 */
export function createFileProfileRepository({ dir, seedFile }) {
  const file = path.join(dir, 'profile.json');
  const locked = createLock();
  return {
    async load() {
      const saved = await readJsonFile(file, null);
      if (saved) return normalizeProfile(saved, { clamp: true });
      const seed = seedFile ? await readJsonFile(seedFile, null) : null;
      if (seed) return normalizeProfile(profileFromCvAgent(seed), { clamp: true });
      return emptyProfile();
    },
    async save(profile) {
      const normalized = normalizeProfile(profile);
      await locked(() => writeJsonAtomic(file, normalized));
      return normalized;
    },
  };
}
