import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBackchannel } from '../../public/domain/backchannel.js';

test('listening noises on their own are backchannel', () => {
  for (const text of ['Okay.', 'ok', 'Right.', 'Great!', 'Sure, sure.', 'Uh-huh.', 'Mm-hmm', 'Mhm.', 'I see.', 'Got it.',
    'Alright, great.', 'All right.', 'Thanks.', 'Thank you.', 'Interesting.', 'Perfect!', 'Okay, okay, okay.', 'GOT IT', 'Yeah… right', 'Um, okay.']) {
    assert.equal(isBackchannel(text), true, text);
  }
});

test('a real question or statement is never backchannel, even if it starts with one', () => {
  for (const text of ['Why?', 'How so?', 'Okay, why?', 'Great, tell me about Azure.', 'Right, and what about testing?',
    'Thanks, now tell me about yourself.', 'Can you elaborate?', 'Sure, go ahead and describe the architecture.', 'Why not?', 'Tell me more']) {
    assert.equal(isBackchannel(text), false, text);
  }
});

test('empty or symbol-only text is not treated as backchannel (it is not speech we understand)', () => {
  assert.equal(isBackchannel(''), false);
  assert.equal(isBackchannel('   '), false);
  assert.equal(isBackchannel('...'), false);
  assert.equal(isBackchannel(undefined), false);
});
