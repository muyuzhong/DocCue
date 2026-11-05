import type { Trigger } from './types.js';

/** A user message starts a turn that answers it. */
export const answerQuestions: Trigger = {
  name: 'answer_questions',
  check: (event) => (event.type === 'user_message' ? { reason: 'user_message' } : undefined),
};
