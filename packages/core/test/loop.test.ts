import { describe, expect, it } from 'vitest';
import { withModelLog, type ModelCallRecord } from '../src/log/log.js';
import { runTurn, runTurnToEnd } from '../src/loop/run-turn.js';
import type { LoopEvent, Tool, TurnEnd } from '../src/loop/types.js';
import { createAnthropic } from '../src/model/anthropic.js';
import { ModelError } from '../src/model/errors.js';
import type { Message, ToolResult } from '../src/model/types.js';
import { collect, mockFetch, sseResponse } from './helpers.js';
import { realModel, rejectedModel } from './model.js';

const user = (text: string): Message => ({ role: 'user', content: text });
const textOf = (messages: readonly Message[]) =>
  messages.flatMap((message) => (message.role === 'assistant' ? message.content : [])).map((part) => (part.type === 'text' ? part.text : '')).join('');
const results = (events: LoopEvent[]): ToolResult[] => events.flatMap((event) => (event.type === 'tool_result' ? [event.result] : []));
const endOf = (events: LoopEvent[]) => events.at(-1) as TurnEnd;

/** A tool that returns a word only it knows, and counts its calls. */
function secretWord(): Tool & { calls: number } {
  return {
    name: 'get_secret_word',
    description: 'Returns the secret word of the day.',
    parameters: { type: 'object', properties: {} },
    calls: 0,
    async execute() {
      this.calls++;
      return 'pineapple';
    },
  };
}

describe('runTurn with the real model', () => {
  it('answers in one step when no tool is needed', async () => {
    const events = await collect(runTurn({ model: realModel(), system: 'Reply with one word.', messages: [user('What colour is a clear daytime sky?')] }));
    expect(events.filter((event) => event.type === 'step_start')).toHaveLength(1);
    const end = endOf(events);
    expect(end.reason).toBe('completed');
    expect(end.messages.map((message) => message.role)).toEqual(['assistant']);
    expect(textOf(end.messages)).toMatch(/blue/i);
    expect(end.usage.inputTokens).toBeGreaterThan(0);
  });

  it('runs the tools the model asks for and answers with their results', async () => {
    const tool = secretWord();
    const { text, end } = await runTurnToEnd({ model: realModel(), messages: [user('Use get_secret_word and tell me the word it returns.')], tools: [tool] });
    expect(tool.calls).toBeGreaterThanOrEqual(1);
    expect(end.reason).toBe('completed');
    expect(end.messages.map((message) => message.role).slice(0, 2)).toEqual(['assistant', 'tool']);
    expect(text).toMatch(/pineapple/i);
  });

  /** Looks up orders whose IDs are six digits; the database behind it is offline. */
  const lookupOrder = (): Tool => ({
    name: 'lookup_order',
    description: 'Looks up an order by its ID.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
    validate: (args) => (/^\d{6}$/.test(String((args as { order_id?: unknown }).order_id)) ? undefined : 'order_id: must be six digits, zero-padded, like 000123'),
    async execute() {
      throw new Error('the order database is offline');
    },
  });

  // What the model does after a rejection (retry, or ask the user) is its own call: the loop's
  // part is to send the rejection back as a result and let the model go on.
  it('sends rejected arguments back as a result the model can read', async () => {
    const events = await collect(runTurn({ model: realModel(), messages: [user('Look up my order 42 with lookup_order.')], tools: [lookupOrder()] }));
    const contents = results(events).map((result) => [result.isError, result.content]);
    expect(contents[0]).toEqual([true, 'Invalid arguments for lookup_order: order_id: must be six digits, zero-padded, like 000123']);
    expect(events.filter((event) => event.type === 'step_start').length).toBeGreaterThanOrEqual(2);
    expect(endOf(events).reason).toBe('completed');
  });

  it('sends a tool failure back as a result the model can read', async () => {
    const events = await collect(runTurn({ model: realModel(), messages: [user('Look up order 000042 with lookup_order and tell me what happened.')], tools: [lookupOrder()] }));
    expect(results(events).map((result) => [result.isError, result.content])).toContainEqual([true, 'Tool error: the order database is offline']);
    expect(endOf(events).reason).toBe('completed');
    expect(textOf(endOf(events).messages)).toMatch(/offline|unavailable|down/i);
  });

  it('stops after maxSteps', async () => {
    const tool = secretWord();
    const { end } = await runTurnToEnd({ model: realModel(), messages: [user('Use get_secret_word and tell me the word.')], tools: [tool], maxSteps: 1 });
    expect(end.reason).toBe('max_steps');
    expect(tool.calls).toBe(1);
    expect(end.messages.map((message) => message.role)).toEqual(['assistant', 'tool']);
  });

  it('stops at the token limit', async () => {
    const { end } = await runTurnToEnd({ model: realModel({ DOCCUE_MAX_TOKENS: '40' }), messages: [user('Write a 500-word essay on the history of bridges.')] });
    expect(end.reason).toBe('max_tokens');
    expect(end.messages.flatMap((message) => (message.role === 'assistant' ? message.content : [])).some((part) => part.type === 'tool_call')).toBe(false);
  });

  it('when aborted mid-stream keeps the text the user already saw', async () => {
    const controller = new AbortController();
    let seen = '';
    let end: TurnEnd | undefined;
    for await (const event of runTurn({ model: realModel(), messages: [user('Count from 1 to 300, one number per line.')], signal: controller.signal })) {
      if (event.type === 'text') {
        seen += event.delta;
        if (seen.length > 20) controller.abort();
      }
      if (event.type === 'turn_end') end = event;
    }
    expect(end?.reason).toBe('aborted');
    expect(textOf(end!.messages)).toBe(seen);
  });

  it('closes the model request when the caller stops reading', async () => {
    const records: ModelCallRecord[] = [];
    const model = withModelLog(realModel(), (record) => records.push(record));
    for await (const event of runTurn({ model, messages: [user('Count from 1 to 300, one number per line.')] })) {
      if (event.type === 'text') break;
    }
    for (let waited = 0; records.length === 0 && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records[0]?.error?.name).toBe('Stopped');
  });

  it('ends with timeout when the turn takes too long', async () => {
    const { end } = await runTurnToEnd({ model: realModel(), messages: [user('Write a long story.')], timeoutMs: 100 });
    expect(end.reason).toBe('timeout');
  });

  it('when cancelled while a tool runs, every tool call still gets a result', async () => {
    const controller = new AbortController();
    const slow: Tool = {
      name: 'fetch_report',
      description: 'Fetches the monthly report.',
      parameters: { type: 'object', properties: {} },
      execute: (_args, context) => {
        setTimeout(() => controller.abort(), 50);
        return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    };
    const { end } = await runTurnToEnd({ model: realModel(), messages: [user('Fetch the monthly report with fetch_report.')], tools: [slow], signal: controller.signal });
    expect(end.reason).toBe('aborted');
    const [call, answered] = end.messages.slice(-2);
    const calls = call?.role === 'assistant' ? call.content.filter((part) => part.type === 'tool_call') : [];
    expect(calls.length).toBeGreaterThan(0);
    expect(answered).toEqual({
      role: 'tool',
      results: calls.map((part) => ({ callId: (part as { id: string }).id, content: 'Cancelled: the turn was stopped while this tool was running.', isError: true })),
    });
  });

  it('appends what beforeModelCall returns before each model call', async () => {
    const steps: number[] = [];
    const { text, end } = await runTurnToEnd({
      model: realModel(),
      messages: [user('What is my favourite flower? Reply with just the word.')],
      beforeModelCall: ({ step }) => {
        steps.push(step);
        // Words of the user's own: models disregard text that says it comes from somewhere else
        // ("Note from the app: ...") and answer that they were not told.
        return step === 1 ? [user('It is the tulip.')] : [];
      },
    });
    expect(steps).toEqual([1]);
    expect(end.messages[0]).toEqual(user('It is the tulip.'));
    expect(text).toMatch(/tulip/i);
  });

  it('ends with reason error when the provider rejects the request', async () => {
    const { end } = await runTurnToEnd({ model: rejectedModel(), messages: [user('hi')] });
    expect(end.reason).toBe('error');
    expect(end.error).toBeInstanceOf(ModelError);
    expect((end.error as ModelError).retryable).toBe(false);
  });

  it('stops at a tool that runs in the page and hands the call over', async () => {
    const highlight: Tool = {
      name: 'highlight',
      description: "Highlights an element of the user's screen by its number.",
      parameters: { type: 'object', properties: { target: { type: 'integer' } }, required: ['target'] },
    };
    const { end } = await runTurnToEnd({
      model: realModel(),
      system: "You can point at things on the user's screen with the highlight tool.",
      messages: [user('Show me the Save button. It is element 7 on my screen.')],
      tools: [highlight],
    });
    expect(end.reason).toBe('page_tool');
    expect(end.pageCall).toMatchObject({ name: 'highlight', args: { target: 7 } });
    // The call handed over has no result yet: the frontend supplies it with the next request.
    expect(end.messages.at(-1)?.role).toBe('assistant');
  });
});

// What a real model can't be made to do on demand: recorded raw API responses, read by the real adapter.
describe('runTurn on recorded API responses', () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ event: type, data: { type, ...data } });
  const start = ev('message_start', { message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 } } });

  it('on refusal discards the partial answer', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        start,
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Sure, here is' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'refusal', stop_details: { type: 'refusal' } }, usage: { output_tokens: 3 } }),
        ev('message_stop', {}),
      ]),
    );
    const { end } = await runTurnToEnd({ model: createAnthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }), messages: [user('q')] });
    expect(end.reason).toBe('refusal');
    expect(end.stopDetails).toEqual({ type: 'refusal' });
    expect(end.messages).toEqual([]);
  });

  const tool = (index: number, id: string, name: string, json: string) => [
    ev('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
    ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json } }),
    ev('content_block_stop', { index }),
  ];

  it('when stopped while a backend tool runs, also answers the page call made alongside it', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        start,
        ...tool(0, 'toolu_1', 'highlight', '{"target": 7}'),
        ...tool(1, 'toolu_2', 'fetch_report', '{}'),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
        ev('message_stop', {}),
      ]),
    );
    const highlight: Tool = { name: 'highlight', description: 'Highlights an element.', parameters: { type: 'object', properties: {} } };
    const slow: Tool = {
      name: 'fetch_report',
      description: 'Fetches the monthly report.',
      parameters: { type: 'object', properties: {} },
      execute: () => new Promise(() => {}),
    };
    const { end } = await runTurnToEnd({
      model: createAnthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }),
      messages: [user('q')],
      tools: [highlight, slow],
      timeoutMs: 100,
    });
    expect(end.reason).toBe('timeout');
    expect(end.pageCall).toBeUndefined();
    // Every call has its result, so the stored history stays valid for the next request.
    expect(end.messages.at(-1)).toEqual({
      role: 'tool',
      results: [
        { callId: 'toolu_1', content: 'Cancelled: the turn was stopped before this tool ran.', isError: true },
        { callId: 'toolu_2', content: 'Cancelled: the turn was stopped while this tool was running.', isError: true },
      ],
    });
  });

  it('answers calls to unknown tools and calls with broken JSON with an error result', async () => {
    const { fetch, calls } = mockFetch(
      sseResponse([
        start,
        ...tool(0, 'toolu_1', 'drop_tables', '{}'),
        ...tool(1, 'toolu_2', 'get_secret_word', '{"day": '),
        ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
        ev('message_stop', {}),
      ]),
      sseResponse([
        start,
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        ev('message_stop', {}),
      ]),
    );
    const tool_ = secretWord();
    const events = await collect(runTurn({ model: createAnthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }), messages: [user('q')], tools: [tool_] }));
    expect(tool_.calls).toBe(0);
    expect(results(events)).toEqual([
      { callId: 'toolu_1', content: 'Unknown tool "drop_tables".', isError: true },
      { callId: 'toolu_2', content: expect.stringMatching(/^INVALID_JSON/), isError: true },
    ]);
    // Both results went back to the model in the next request.
    expect(JSON.stringify(calls[1]!.body.messages)).toContain('Unknown tool');
    expect(endOf(events).reason).toBe('completed');
  });
});
