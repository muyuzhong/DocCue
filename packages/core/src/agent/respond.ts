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
import { emptyUsage, type ModelAdapter } from '../model/types.js';
import { docsPrompt, docsTools, type DocsProvider } from '../docs/docs.js';
import { buildSystemPrompt, renderConversation } from '../render/render.js';
import { GUIDE_TOOL, guideTool, latestQuestion, latestScreen, readSteps } from './guide.js';

export interface AgentOptions {
  model: ModelAdapter;
  /** The product-specific part of the system prompt: what the app is, tone, rules. */
  instructions?: string;
  /** The product documentation: `markdownDocs(dir)` from `@doccue/core/node`, `createDocs(files)`, or your own search. */
  docs?: DocsProvider;
  /** Extra tools that run on the backend. The `guide` tool is always there. */
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

  try {
    const events = runTurn({
      model,
      system: buildSystemPrompt(options.instructions, options.docs ? [docsPrompt(options.docs)] : []),
      messages: renderConversation(request),
      tools: [...(options.docs ? docsTools(options.docs) : []), ...(options.tools ?? []), guideTool(latestScreen(request.conversation), { question: latestQuestion(request.conversation), locale: request.locale })],
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
          if (event.call.name !== GUIDE_TOOL) yield { type: 'status', state: 'tool', tool: event.call.name };
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
          const item = { type: 'model' as const, messages: event.messages };
          if (event.reason === 'page_tool') {
            // The frontend runs the guide and sends its result with the next request.
            // The loop only hands over calls that passed validation, so the steps are readable.
            const call = event.pageCall!;
            const read = readSteps(call.args);
            yield { type: 'guide', callId: call.id, steps: 'steps' in read ? read.steps : [] };
            yield { type: 'end', reason: 'guide', item, usage: event.usage };
          } else {
            yield { type: 'end', reason: event.reason, item, usage: event.usage, ...(error ? { error } : {}) };
          }
          return;
        }
        default:
          break;
      }
    }
  } catch (error) {
    // A bug or a misbehaving hook (docs, tools): the stream still ends properly. The details go
    // to the log, not to the browser.
    safeLog(logger, { kind: 'end', at: Date.now(), requestId, reason: 'error', usage: emptyUsage(), error: describeError(error) });
    yield failedEnd();
  }
}

/** The end event for a request that failed unexpectedly. Nothing is added to the conversation. */
export function failedEnd(): Extract<StreamEvent, { type: 'end' }> {
  return { type: 'end', reason: 'error', item: { type: 'model', messages: [] }, usage: emptyUsage(), error: { message: 'internal error' } };
}
