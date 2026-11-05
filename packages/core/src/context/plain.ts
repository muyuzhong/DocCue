import type { ContextBuilder } from './types.js';

/**
 * Placeholder until the real context layer: the system prompt plus the conversation history,
 * with no status bar or perception data.
 */
export function plainContext(system?: string): ContextBuilder {
  return {
    prepare: ({ session }) => ({ ...(system ? { system } : {}), messages: session.history }),
  };
}
