import { LIMITS } from '../../domain/context-item.js';
import { select, describeSelection } from '../../domain/context-budget.js';
import { buildSystemPrompt } from '../../domain/coach-prompt.js';
import { ValidationError } from '../../domain/errors.js';

/** System prompt for a given budget; the browser's Gemini Nano provider uses it so the prompt is built in one place. */
export function createBuildCoachSystemPrompt({ profileRepo, contextRepo }) {
  return async function buildCoachSystemPrompt({ maxChars = 3000, mode = 'cloud' } = {}) {
    if (mode !== 'cloud' && mode !== 'nano') throw new ValidationError('mode debe ser cloud o nano');
    if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > LIMITS.MAX_ACTIVE_CHARS) {
      throw new ValidationError(`maxChars debe ser un entero entre 500 y ${LIMITS.MAX_ACTIVE_CHARS}`);
    }
    const [profile, items] = await Promise.all([profileRepo.load(), contextRepo.list()]);
    const selection = select(items, maxChars);
    return {
      systemPrompt: buildSystemPrompt({ profile, included: selection.included, mode }),
      ...describeSelection(selection),
    };
  };
}
