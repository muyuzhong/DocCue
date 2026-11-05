/**
 * The agent loop: call the model, run the tools it asks for, feed the results back, and repeat
 * until it answers. One call to `runTurn` handles one user input.
 *
 * The transcript is append-only. Nothing already sent to the model is edited or removed, which
 * keeps prompt caches warm and keeps replayed thinking blocks valid.
 */
import { addUsage, emptyUsage, type Message, type ModelDone, type ToolCallPart, type ToolResult } from '../model/types.js';
import { isAbortError, raceAbort } from '../util/abort.js';
import type { LoopEvent, Tool, TurnEnd, TurnEndReason, TurnOptions } from './types.js';

export async function* runTurn(options: TurnOptions): AsyncGenerator<LoopEvent, void, undefined> {
  const maxSteps = options.maxSteps ?? 10;
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const specs = options.tools?.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const transcript: Message[] = [...options.messages];
  const added: Message[] = [];
  const usage = emptyUsage();
  const append = (message: Message) => {
    transcript.push(message);
    added.push(message);
  };

  const controller = new AbortController();
  const signal = controller.signal;
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  const end = (reason: TurnEndReason, extra: Partial<TurnEnd> = {}): TurnEnd => ({
    type: 'turn_end',
    reason,
    messages: added,
    usage,
    ...extra,
  });
  const cancelled = () => end(timedOut ? 'timeout' : 'aborted');

  try {
    for (let step = 1; ; step++) {
      if (signal.aborted) {
        yield cancelled();
        return;
      }
      if (options.beforeModelCall) {
        try {
          const extra = await options.beforeModelCall({ step, transcript });
          for (const message of extra ?? []) append(message);
        } catch (error) {
          yield end('error', { error: error instanceof Error ? error : new Error(String(error)) });
          return;
        }
      }

      yield { type: 'step_start', step };
      let partialText = '';
      let done: ModelDone | undefined;
      const iterator = options.model
        .stream({
          messages: [...transcript],
          signal,
          ...(options.system ? { system: options.system } : {}),
          ...(specs && specs.length > 0 ? { tools: specs } : {}),
        })
        [Symbol.asyncIterator]();
      let streamFinished = false;
      try {
        while (true) {
          // Race each read against the signal so cancelling works even if an adapter ignores it.
          const next = await raceAbort(iterator.next(), signal);
          if (next.done) {
            streamFinished = true;
            break;
          }
          const event = next.value;
          if (event.type === 'text') {
            partialText += event.delta;
            yield event;
          } else if (event.type === 'reasoning') {
            yield event;
          } else {
            done = event;
          }
        }
      } catch (error) {
        streamFinished = true;
        void closeQuietly(iterator);
        if (signal.aborted || isAbortError(error)) {
          // Keep what the user already saw; tool calls in flight are dropped.
          if (partialText) append({ role: 'assistant', content: [{ type: 'text', text: partialText }] });
          yield cancelled();
          return;
        }
        yield end('error', { error: error instanceof Error ? error : new Error(String(error)) });
        return;
      } finally {
        // The caller stopped reading mid-stream: close the model stream so the request is cancelled.
        if (!streamFinished) void closeQuietly(iterator);
      }
      if (!done) {
        yield end('error', { error: new Error(`${options.model.provider}: stream ended without a result`) });
        return;
      }

      addUsage(usage, done.usage);
      yield {
        type: 'step_end',
        step,
        stopReason: done.stopReason,
        usage: done.usage,
        ...(done.servedBy === undefined ? {} : { servedBy: done.servedBy }),
      };

      if (done.stopReason === 'refusal') {
        yield end('refusal', done.stopDetails === undefined ? {} : { stopDetails: done.stopDetails });
        return;
      }
      if (done.stopReason === 'max_tokens') {
        // Tool calls cut off mid-way can't run, and an unanswered call would break the next request.
        const content = done.message.content.filter((part) => part.type !== 'tool_call');
        if (content.some((part) => part.type === 'text')) append({ role: 'assistant', content });
        yield end('max_tokens');
        return;
      }

      const calls = done.message.content.filter((part): part is ToolCallPart => part.type === 'tool_call');
      if (done.message.content.some((part) => part.type !== 'raw')) append(done.message);
      if (calls.length === 0) {
        yield end('completed');
        return;
      }

      for (const call of calls) yield { type: 'tool_call', call };
      const results = await runTools(calls, tools, signal);
      append({ role: 'tool', results });
      for (const result of results) yield { type: 'tool_result', result };

      if (signal.aborted) {
        yield cancelled();
        return;
      }
      if (step >= maxSteps) {
        yield end('max_steps');
        return;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Runs a turn to the end and returns the full text along with the final event. */
export async function runTurnToEnd(options: TurnOptions): Promise<{ text: string; end: TurnEnd }> {
  let text = '';
  for await (const event of runTurn(options)) {
    if (event.type === 'text') text += event.delta;
    if (event.type === 'turn_end') return { text, end: event };
  }
  throw new Error('runTurn finished without a turn_end event');
}

function closeQuietly(iterator: AsyncIterator<unknown>): Promise<void> {
  return Promise.resolve()
    .then(() => iterator.return?.())
    .then(
      () => undefined,
      () => undefined,
    );
}

/** Runs one step's tool calls in parallel. Every call gets exactly one result, in call order. */
async function runTools(calls: readonly ToolCallPart[], tools: ReadonlyMap<string, Tool>, signal: AbortSignal): Promise<ToolResult[]> {
  return Promise.all(
    calls.map(async (call): Promise<ToolResult> => {
      const fail = (content: string): ToolResult => ({ callId: call.id, content, isError: true });
      if (signal.aborted) return fail('Cancelled: the turn was stopped before this tool ran.');
      const tool = tools.get(call.name);
      if (!tool) return fail(`Unknown tool "${call.name}".`);
      if (call.args === undefined) {
        return fail(`INVALID_JSON: the arguments for ${call.name} are not valid JSON. Call the tool again with valid JSON.`);
      }
      const problem = checkArgs(tool, call.args);
      if (problem) return fail(`Invalid arguments for ${call.name}: ${problem}`);
      try {
        const content = await raceAbort(tool.execute(call.args, { callId: call.id, signal }), signal);
        return { callId: call.id, content };
      } catch (error) {
        if (signal.aborted) return fail('Cancelled: the turn was stopped while this tool was running.');
        return fail(`Tool error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

/** A light check against the tool's schema: object shape and required keys. Tools validate the rest. */
function checkArgs(tool: Tool, args: unknown): string | undefined {
  if (tool.parameters.type !== 'object') return undefined;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'expected a JSON object';
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
  const missing = required.filter((key): key is string => typeof key === 'string' && !(key in args));
  return missing.length > 0 ? `missing ${missing.join(', ')}` : undefined;
}
