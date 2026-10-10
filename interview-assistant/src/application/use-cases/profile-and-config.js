import { LIMITS } from '../../domain/context-item.js';
import { normalizeProfile } from '../../domain/profile.js';

export function createGetProfile({ profileRepo }) {
  return async function getProfile() {
    return profileRepo.load();
  };
}

export function createSaveProfile({ profileRepo }) {
  return async function saveProfile(raw) {
    return profileRepo.save(normalizeProfile(raw));
  };
}

/** Capabilities depend on whether a Gemini key is configured: PDF and audio need it, DOCX and text do not. */
export function createGetConfig({ llm, version }) {
  return async function getConfig() {
    const ai = llm.isConfigured();
    return {
      ai,
      model: ai ? llm.model : null,
      version,
      limits: { maxUploadBytes: LIMITS.MAX_UPLOAD_BYTES, maxItems: LIMITS.MAX_ITEMS, maxActiveChars: LIMITS.MAX_ACTIVE_CHARS },
      capabilities: { pdf: ai, audio: ai, docx: true, text: true },
    };
  };
}
