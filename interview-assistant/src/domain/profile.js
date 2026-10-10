import { ValidationError } from './errors.js';

export const PROFILE_LIMITS = Object.freeze({
  FIELD: 300, SUMMARY: 2000, NOTES: 4000, SKILLS: 40, ROLES: 12, HIGHLIGHTS: 8, HIGHLIGHT_CHARS: 300,
});

export function emptyProfile() {
  return { name: '', headline: '', summary: '', skills: [], experience: [], notes: '' };
}

function text(value, max, label, clamp) {
  const s = String(value ?? '').trim();
  if (s.length <= max) return s;
  if (clamp) return s.slice(0, max);
  throw new ValidationError(`${label} excede ${max} caracteres`);
}

function list(value, max, label, clamp) {
  const arr = Array.isArray(value) ? value : [];
  if (arr.length <= max) return arr;
  if (clamp) return arr.slice(0, max);
  throw new ValidationError(`${label}: máximo ${max} elementos`);
}

/** Validates and normalizes a profile. With `clamp`, oversize values are cut instead of rejected. */
export function normalizeProfile(raw, { clamp = false } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const L = PROFILE_LIMITS;
  return {
    name: text(r.name, L.FIELD, 'El nombre', clamp),
    headline: text(r.headline, L.FIELD, 'El titular', clamp),
    summary: text(r.summary, L.SUMMARY, 'El resumen', clamp),
    skills: list(r.skills, L.SKILLS, 'Habilidades', clamp).map((s) => text(s, L.FIELD, 'Una habilidad', clamp)).filter(Boolean),
    experience: list(r.experience, L.ROLES, 'Experiencia', clamp)
      .map((e) => ({
        company: text(e?.company, L.FIELD, 'La empresa', clamp),
        role: text(e?.role, L.FIELD, 'El rol', clamp),
        period: text(e?.period, L.FIELD, 'El periodo', clamp),
        highlights: list(e?.highlights, L.HIGHLIGHTS, 'Logros', clamp).map((h) => text(h, L.HIGHLIGHT_CHARS, 'Un logro', clamp)).filter(Boolean),
      }))
      .filter((e) => e.company || e.role),
    notes: text(r.notes, L.NOTES, 'Las notas', clamp),
  };
}

/** Compact plain-text profile for the coach prompt: headline, summary, skills, 4 latest roles (2 highlights each). */
export function toPromptSummary(profile, maxChars = 2500) {
  const lines = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.skills.length) lines.push(`Skills: ${profile.skills.join(', ')}`);
  if (profile.experience.length) {
    lines.push('Recent roles:');
    for (const e of profile.experience.slice(0, 4)) {
      const where = [e.role, e.company && `at ${e.company}`, e.period && `(${e.period})`].filter(Boolean).join(' ');
      const wins = e.highlights.slice(0, 2).join('; ');
      lines.push(`- ${where}${wins ? `: ${wins}` : ''}`);
    }
  }
  if (profile.notes) lines.push(`Notes: ${profile.notes}`);
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars).trimEnd() : out || '(no profile data provided)';
}
