import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION, nextState, isActive } from '../../public/domain/session-state.js';
import { createTurnBuffer, SILENCE_MS } from '../../public/domain/turn-buffer.js';
import { createFakeScheduler } from '../support/fakes-client.js';

test('session: the happy path idle → starting → listening ⇄ speaking → idle', () => {
  let s = SESSION.IDLE;
  for (const [event, expected] of [['start', 'starting'], ['ready', 'listening'], ['pause', 'speaking'], ['resume', 'listening'], ['stop', 'idle']]) {
    s = nextState(s, event);
    assert.equal(s, expected, event);
  }
});

test('session: failures lead to error, from where you can start again', () => {
  assert.equal(nextState('starting', 'fail'), 'error');
  assert.equal(nextState('listening', 'fail'), 'error');
  assert.equal(nextState('speaking', 'fail'), 'error');
  assert.equal(nextState('error', 'start'), 'starting');
  assert.equal(nextState('starting', 'stop'), 'idle');
});

test('session: events that make no sense leave the state alone', () => {
  assert.equal(nextState('idle', 'pause'), 'idle');
  assert.equal(nextState('idle', 'ready'), 'idle');
  assert.equal(nextState('listening', 'start'), 'listening');
  assert.equal(nextState('listening', 'nonsense'), 'listening');
  assert.equal(nextState('bogus', 'start'), 'bogus');
});

test('session: isActive is true while the microphone is in use', () => {
  assert.deepEqual(['idle', 'starting', 'listening', 'speaking', 'error'].map(isActive), [false, true, true, true, false]);
});

function setup() {
  const scheduler = createFakeScheduler();
  const closed = [];
  const buffer = createTurnBuffer({ scheduler, onTurnClosed: (t) => closed.push(t) });
  return { scheduler, closed, buffer };
}

test('a turn closes after 1.5 s of silence with all its finals', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.addFinal('Tell me about a time');
  scheduler.advance(1000);
  buffer.addFinal('you led a team.');
  scheduler.advance(SILENCE_MS - 1);
  assert.equal(closed.length, 0, 'the second final restarted the countdown');
  scheduler.advance(1);
  assert.deepEqual(closed, [{ id: 't1', finals: ['Tell me about a time', 'you led a team.'], text: 'Tell me about a time you led a team.' }]);
  assert.equal(buffer.hasOpenTurn(), false);
});

test('partial results keep the turn open while the interviewer is still talking', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.addFinal('First part.');
  scheduler.advance(1400);
  buffer.addPartial('and then');
  scheduler.advance(1400);
  assert.equal(closed.length, 0);
  scheduler.advance(100);
  assert.equal(closed.length, 1);
});

test('a partial with no open turn does nothing', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.addPartial('hello');
  scheduler.advance(10_000);
  assert.deepEqual(closed, []);
  assert.equal(scheduler.pending(), 0);
});

test('consecutive turns get increasing ids', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.addFinal('One.');
  scheduler.advance(SILENCE_MS);
  buffer.addFinal('Two.');
  scheduler.advance(SILENCE_MS);
  assert.deepEqual(closed.map((t) => [t.id, t.text]), [['t1', 'One.'], ['t2', 'Two.']]);
});

test('pause stops the countdown but keeps the finals; flush closes the turn on demand', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.addFinal('Why this company?');
  buffer.pause();
  scheduler.advance(10_000);
  assert.equal(closed.length, 0);
  assert.equal(buffer.hasOpenTurn(), true);
  buffer.flush();
  assert.deepEqual(closed.map((t) => t.text), ['Why this company?']);
});

test('flush with nothing open emits nothing, blank finals are ignored, reset forgets the turn', () => {
  const { scheduler, closed, buffer } = setup();
  buffer.flush();
  buffer.addFinal('   ');
  buffer.addFinal(undefined);
  assert.equal(buffer.hasOpenTurn(), false);
  buffer.addFinal('Something');
  buffer.reset();
  scheduler.advance(10_000);
  assert.deepEqual(closed, []);
  assert.equal(scheduler.pending(), 0);
});
