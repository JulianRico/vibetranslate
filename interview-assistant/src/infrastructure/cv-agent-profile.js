/**
 * Maps a CV Agent profile (`data/profile.json` of the parent project) to this app's profile shape.
 * The input is untrusted JSON: every field is optional and the result goes through normalizeProfile().
 */
export function profileFromCvAgent(cv) {
  const basics = cv?.basics ?? {};
  const groups = Array.isArray(cv?.skills) ? cv.skills : [];
  const roles = Array.isArray(cv?.experience) ? cv.experience : [];
  return {
    name: basics.name,
    headline: basics.title,
    summary: cv?.summary,
    skills: groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : [])),
    experience: roles.map((e) => ({
      company: e?.company,
      role: e?.role,
      period: [e?.start, e?.end].filter(Boolean).join(' – '),
      highlights: e?.bullets,
    })),
  };
}
