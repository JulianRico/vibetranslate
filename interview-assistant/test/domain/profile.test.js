import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyProfile, normalizeProfile, toPromptSummary, PROFILE_LIMITS } from '../../src/domain/profile.js';
import { ValidationError } from '../../src/domain/errors.js';

const sample = () => ({
  name: ' Julian Quintero ', headline: 'Full Stack Lead', summary: '14 years leading teams.',
  skills: ['.NET', 'Azure', '', 'React'],
  experience: [
    { company: 'Acme', role: 'Lead', period: '2022–2024', highlights: ['Led a 6-person team', 'Migrated to Azure', 'third'] },
    { company: '', role: '', highlights: ['ignored: empty role'] },
  ],
  notes: 'Prefers .NET',
});

test('emptyProfile has every field', () => {
  assert.deepEqual(emptyProfile(), { name: '', headline: '', summary: '', skills: [], experience: [], notes: '' });
});

test('normalizeProfile trims, drops blanks and empty roles', () => {
  const p = normalizeProfile(sample());
  assert.equal(p.name, 'Julian Quintero');
  assert.deepEqual(p.skills, ['.NET', 'Azure', 'React']);
  assert.equal(p.experience.length, 1);
});

test('normalizeProfile tolerates garbage input', () => {
  assert.deepEqual(normalizeProfile(null), emptyProfile());
  assert.deepEqual(normalizeProfile('texto'), emptyProfile());
  assert.deepEqual(normalizeProfile({ skills: 'no es lista', experience: 7 }), emptyProfile());
});

test('normalizeProfile rejects oversize values in strict mode', () => {
  assert.throws(() => normalizeProfile({ summary: 'x'.repeat(PROFILE_LIMITS.SUMMARY + 1) }), ValidationError);
  assert.throws(() => normalizeProfile({ skills: Array(PROFILE_LIMITS.SKILLS + 1).fill('x') }), ValidationError);
  assert.throws(() => normalizeProfile({ experience: Array(PROFILE_LIMITS.ROLES + 1).fill({ role: 'x' }) }), ValidationError);
});

test('normalizeProfile clamps instead when asked', () => {
  const p = normalizeProfile({ summary: 'x'.repeat(5000), skills: Array(100).fill('x') }, { clamp: true });
  assert.equal(p.summary.length, PROFILE_LIMITS.SUMMARY);
  assert.equal(p.skills.length, PROFILE_LIMITS.SKILLS);
});

test('toPromptSummary lists headline, skills and the latest roles with two highlights each', () => {
  const s = toPromptSummary(normalizeProfile(sample()));
  assert.match(s, /Name: Julian Quintero/);
  assert.match(s, /Headline: Full Stack Lead/);
  assert.match(s, /Skills: \.NET, Azure, React/);
  assert.match(s, /- Lead at Acme \(2022–2024\): Led a 6-person team; Migrated to Azure/);
  assert.doesNotMatch(s, /third/);
});

test('toPromptSummary keeps only 4 roles and respects maxChars', () => {
  const p = normalizeProfile({ experience: Array.from({ length: 6 }, (_, i) => ({ company: `C${i}`, role: 'R' })) });
  const s = toPromptSummary(p);
  assert.match(s, /C3/);
  assert.doesNotMatch(s, /C4/);
  assert.ok(toPromptSummary(normalizeProfile({ summary: 'y'.repeat(2000) }), 100).length <= 100);
});

test('toPromptSummary says so when the profile is empty', () => {
  assert.equal(toPromptSummary(emptyProfile()), '(no profile data provided)');
});
