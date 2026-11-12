/**
 * Answers one request: renders the conversation the frontend sent, runs the loop, and yields
 * what to stream back. Nothing is kept between requests; the frontend holds the conversation and
 * sends it in full every time.
 */
import type { StreamEvent, TurnRequest } from '@doccue/protocol';
import { describeError, safeLog, withModelLog, type Logger } from '../log/log.js';
import { runTurn } from '../loop/run-turn.js';
import type { Tool } from '../loop/types.js';
import { ModelError } from '../model/errors.js';
import type { ModelAdapter } from '../model/types.js';
import { buildSystemPrompt, renderConversation } from '../render/render.js';

export interface AgentOptions {
  model: ModelAdapter;
  /** The product-specific part of the system prompt: what the app is, tone, rules. */
  instructions?: string;
  /** Tools that run on the backend. */
  tools?: readonly Tool[];
  /** Model calls per request. Defaults to 10. */
  maxSteps?: number;
  /** Time limit per request. */
  timeoutMs?: number;
  /** Records each request, every model call with exactly what was sent, and how it ended. */
  logger?: Logger;
}

export async function* respond(request: TurnRequest, options: AgentOptions, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
  const { logger } = options;
  const requestId = crypto.randomUUID();
  safeLog(logger, { kind: 'request', at: Date.now(), requestId, request });

  let step = 0;
  const model = logger ? withModelLog(options.model, (record) => logger({ ...record, requestId, step: ++step })) : options.model;

  const events = runTurn({
    model,
    system: buildSystemPrompt(options.instructions),
    messages: renderConversation(request),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(signal ? { signal } : {}),
  });

  for await (const event of events) {
    switch (event.type) {
      case 'step_start':
        yield { type: 'status', state: 'thinking' };
        break;
      case 'text':
        yield { type: 'text', delta: event.delta };
        break;
      case 'tool_call':
        yield { type: 'status', state: 'tool', tool: event.call.name };
        break;
      case 'turn_end': {
        const error = event.error
          ? { message: event.error.message, ...(event.error instanceof ModelError && event.error.code ? { code: event.error.code } : {}) }
          : undefined;
        safeLog(logger, {
          kind: 'end',
          at: Date.now(),
          requestId,
          reason: event.reason,
          usage: event.usage,
          ...(event.error ? { error: describeError(event.error) } : {}),
        });
        yield { type: 'end', reason: event.reason, item: { type: 'model', messages: event.messages }, usage: event.usage, ...(error ? { error } : {}) };
        return;
      }
      default:
        break;
    }
  }
}
