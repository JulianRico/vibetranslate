import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPrepared, deriveTriggers, normalize, MIN_SCORE, MIN_MARGIN } from '../../public/domain/prepared-matcher.js';
import { seedPrepared } from '../../src/domain/default-prepared.js';

const bank = seedPrepared('2026-10-05T10:00:00.000Z');
const idFor = (text) => findPrepared(text, bank)?.id ?? null;

/** What interviewers really say, one or two ways per starter question. */
const CASES = {
  'tell-me-about-yourself': ['Tell me about yourself.', 'Can you walk me through your background?', 'Please introduce yourself.'],
  'why-this-job': ['Why do you want this job?', 'Why are you interested in this role?'],
  'leaving-current-job': ['Why are you leaving your current job?', 'Why did you leave your last company?'],
  strengths: ['What are your strengths?', 'What would you say is your greatest strength?'],
  'biggest-weakness': ['What is your biggest weakness?', 'Tell me about your weaknesses.', "What's your weakness?"],
  'project-you-led': ['Tell me about a project you led.', 'Can you tell me about a project that you are proud of?'],
  'how-you-lead': ['How do you lead a team?', "What's your leadership style?"],
  'team-conflict': ['How do you handle conflict in a team?', 'How do you deal with conflict with colleagues?'],
  'tight-deadlines': ['How do you handle tight deadlines?', 'How do you work under pressure?'],
  'dotnet-experience': ['What is your experience with .NET?', 'Do you have experience in C#?', 'Tell me about your .NET experience.'],
  'azure-cloud-experience': ["What's your experience with Azure?", 'Tell me about your cloud experience.'],
  'scalable-architecture': ['How would you design a scalable architecture?', 'Walk me through a system design for a chat app.'],
  'code-quality': ['How do you ensure code quality?', 'How do you write unit tests?'],
  'stay-up-to-date': ['How do you stay up to date with new technologies?', 'How do you keep up with technology?'],
  'ai-tools-copilot': ['Do you use Copilot?', 'How do you use AI tools in your work?'],
  mentoring: ['How do you mentor junior developers?', 'How do you grow your team?'],
  'technical-debt': ['How do you manage technical debt?', 'What do you do about legacy code?'],
  'a-mistake': ['Tell me about a mistake you made.', 'Tell me about something that went wrong.'],
  'five-years': ['Where do you see yourself in five years?', 'What are your career goals?'],
  'salary-expectations': ['What are your salary expectations?', 'What salary are you looking for?'],
  'questions-for-us': ['Do you have any questions for us?', 'Any questions for me?'],
  'why-hire-you': ['Why should we hire you?', 'What makes you different from other candidates?'],
  'what-motivates-you': ['What motivates you?', 'What drives you to do your best work?'],
  'next-role': ['What are you looking for in your next role?', 'What are you looking for in a new position?'],
  'about-our-company': ['What do you know about our company?', 'What do you know about us?'],
  'greatest-achievement': ['What is your greatest achievement?', 'What are you most proud of?'],
  'feedback-and-criticism': ['How do you handle feedback?', 'How do you take criticism?'],
  'prioritize-work': ['How do you prioritize your work?', 'How do you handle too many tasks?'],
  'ideal-work-environment': ['Describe your ideal work environment.', 'What is your work style?'],
  'clients-and-stakeholders': ['How do you work with stakeholders?', 'How do you communicate with clients?'],
  'disagree-with-manager': ['Tell me about a time you disagreed with your manager.', 'What do you do if you disagree with your manager?'],
};

test('every starter question is recognized from realistic phrasings', () => {
  assert.equal(Object.keys(CASES).length, 31, 'every question of the bank has cases');
  for (const [expected, phrasings] of Object.entries(CASES)) {
    for (const text of phrasings) assert.equal(idFor(text), expected, text);
  }
});

test('the bank has no question without a case here (so a new starter question must come with its phrasings)', () => {
  assert.deepEqual(bank.map((b) => b.id).sort(), Object.keys(CASES).sort());
});

test('speech-to-text noise around the question does not matter', () => {
  assert.equal(idFor('okay so um tell me about yourself please'), 'tell-me-about-yourself');
  assert.equal(idFor('TELL ME ABOUT YOURSELF'), 'tell-me-about-yourself');
  assert.equal(idFor('Great. What are your strengths, and what are your weaknesses?'), null, 'two different questions in one turn are ambiguous');
});

test('the best question wins when the turn also contains a weaker hint', () => {
  assert.equal(idFor('Tell me about yourself and why you want this job'), 'tell-me-about-yourself');
});

test('things that are not prepared questions do not match (so the AI answers them)', () => {
  for (const text of ['Can you elaborate on that?', 'Interesting.', 'What did you do at your last company?', 'How would you build a payment gateway?',
    'Okay, thanks.', '', '   ', 'azure']) {
    assert.equal(idFor(text), null, text);
  }
});

test('a single weak hint is not enough (score below the minimum)', () => {
  assert.equal(MIN_SCORE, 2);
  assert.equal(idFor('We use conflict resolution tools'), null);
  assert.equal(idFor('deadlines'), null);
});

test('a tie or a close call is "not sure": no match', () => {
  assert.equal(MIN_MARGIN, 2);
  const item = (id, triggers) => ({ id, status: 'edited', answer: { en: 'x', es: 'y' }, triggers });
  const turn = 'I like the red apple';
  assert.equal(findPrepared(turn, [item('a', ['red apple']), item('c', ['red apple'])]), null, 'tie');
  assert.equal(findPrepared(turn, [item('a', ['red apple']), item('f', ['apple'])]), null, 'ahead by only one point: close call');
  assert.equal(findPrepared(turn, [item('a', ['red apple']), item('d', ['red apple', 'i like'])])?.id, 'd', 'ahead by two points: clear lead');
  assert.equal(findPrepared(turn, [item('a', ['red apple'])])?.id, 'a', 'no rival: a strong hint is enough');
});

test('questions without an answer take no part', () => {
  const empty = { ...bank.find((b) => b.id === 'strengths'), answer: null, status: 'empty' };
  assert.equal(findPrepared('What are your strengths?', [empty]), null);
  const generated = { ...empty, answer: { en: 'x', es: 'y' }, status: 'generated' };
  assert.equal(findPrepared('What are your strengths?', [generated])?.id, 'strengths');
});

test('normalize: case, punctuation, plurals and the .NET / C# / CI/CD spellings', () => {
  assert.deepEqual(normalize('Strengths, weakness & TESTS!'), ['strength', 'weakness', 'test']);
  assert.deepEqual(normalize('ASP.NET and .NET with C# and CI/CD'), ['aspdotnet', 'and', 'dotnet', 'with', 'csharp', 'and', 'cicd']);
  assert.deepEqual(normalize(undefined), []);
});

test('deriveTriggers proposes the content words of a new question', () => {
  assert.deepEqual(deriveTriggers('How do you handle conflicts at work?'), ['handle', 'conflicts', 'work']);
  assert.deepEqual(deriveTriggers('Tell me about Kubernetes and Kubernetes'), ['kubernetes']);
  assert.deepEqual(deriveTriggers('How do you use AI?'), ['use', 'ai']);
  assert.deepEqual(deriveTriggers('Why?'), []);
  assert.equal(deriveTriggers('alpha bravo charlie delta echo foxtrot golf hotel india juliet').length, 8);
});

test('"Why do you want…" about leaving, changing or remote work is not the "why this job" question', () => {
  assert.equal(idFor('Why do you want to leave your current job?'), 'leaving-current-job');
  for (const text of ['Why do you want to change jobs?', 'Why do you want to work remotely?']) {
    assert.notEqual(idFor(text), 'why-this-job', text);
  }
  assert.equal(idFor('Why do you want this job?'), 'why-this-job');
});

test('two different questions in one turn are ambiguous even when one of them has overlapping triggers', () => {
  for (const text of [
    'What are your career goals and what motivates you?',
    'How do you handle feedback from your team, and how do you lead a team?',
    "What do you know about the company's mission? And why do you want this job?",
  ]) {
    assert.equal(idFor(text), null, text);
  }
});
