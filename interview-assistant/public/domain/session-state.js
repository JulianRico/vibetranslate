/** Session states and their transitions. Unknown events leave the state unchanged. */
export const SESSION = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  LISTENING: 'listening',
  SPEAKING: 'speaking', // Julian is talking: everything the microphone hears is ignored
  ERROR: 'error',
});

const TRANSITIONS = {
  idle: { start: 'starting' },
  starting: { ready: 'listening', fail: 'error', stop: 'idle' },
  listening: { pause: 'speaking', stop: 'idle', fail: 'error' },
  speaking: { resume: 'listening', stop: 'idle', fail: 'error' },
  error: { start: 'starting', stop: 'idle' },
};

export function nextState(current, event) {
  return TRANSITIONS[current]?.[event] ?? current;
}

/** True while the microphone is (or is about to be) in use. */
export const isActive = (state) => state === SESSION.STARTING || state === SESSION.LISTENING || state === SESSION.SPEAKING;
