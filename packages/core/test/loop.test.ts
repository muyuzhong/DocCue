import { describe, expect, it } from 'vitest';
import { runTurn, runTurnToEnd } from '../src/loop/run-turn.js';
import type { Tool } from '../src/loop/types.js';
import { ModelError } from '../src/model/errors.js';
import type { Message, ModelEvent } from '../src/model/types.js';
import { collect, done, fakeModel, reply, toolCall } from './helpers.js';

const user = (text: string): Message => ({ role: 'user', content: text });

function tool(name: string, execute: Tool['execute'], required: string[] = []): Tool {
  return { name, description: name, parameters: { type: 'object', properties: {}, required }, execute };
}

describe('runTurn', () => {
  it('answers in one step when the model calls no tools', async () => {
    const model = fakeModel(() => reply('hi'));
    const events = await collect(runTurn({ model, system: 'sys', messages: [user('hello')] }));
    expect(events.map((e) => e.type)).toEqual(['step_start', 'text', 'text', 'step_end', 'turn_end']);
    const end = events.at(-1);
    expect(end).toMatchObject({ type: 'turn_end', reason: 'completed', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] });
    expect(model.requests[0]).toMatchObject({ system: 'sys', messages: [user('hello')] });
    expect(model.requests[0]).not.toHaveProperty('tools');
  });

  it('runs tools, sends results back and continues until the answer', async () => {
    const seen: unknown[] = [];
    const getTime = tool('get_time', async (args) => {
      seen.push(args);
      return '12:00';
    });
    const model = fakeModel(
      () => reply('checking', [toolCall('c1', 'get_time', { tz: 'UTC' })], 'tool_use'),
      () => reply('It is 12:00'),
    );
    const { text, end } = await runTurnToEnd({ model, messages: [user('time?')], tools: [getTime] });

    expect(seen).toEqual([{ tz: 'UTC' }]);
    expect(text).toBe('checkingIt is 12:00');
    expect(end.reason).toBe('completed');
    expect(end.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(end.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(end.messages[1]).toEqual({ role: 'tool', results: [{ callId: 'c1', content: '12:00' }] });
    expect(model.requests[0]!.tools).toEqual([{ name: 'get_time', description: 'get_time', parameters: getTime.parameters }]);
    // The second call sees the whole transcript, append-only.
    expect(model.requests[1]!.messages).toEqual([user('time?'), ...end.messages.slice(0, 2)]);
  });

  it('runs parallel calls and reports unknown tools, bad JSON, bad args and tool errors as results', async () => {
    const model = fakeModel(
      () => [
        done(
          [
            toolCall('a', 'slow', {}),
            toolCall('b', 'missing', {}),
            toolCall('c', 'slow', undefined),
            toolCall('d', 'needs_id', {}),
            toolCall('e', 'broken', {}),
          ],
          'tool_use',
        ),
      ],
      () => reply('done'),
    );
    const tools = [
      tool('slow', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'slow ok';
      }),
      tool('needs_id', async () => 'never', ['id']),
      tool('broken', async () => {
        throw new Error('disk full');
      }),
    ];
    const { end } = await runTurnToEnd({ model, messages: [user('go')], tools });
    const results = (end.messages[1] as Extract<Message, { role: 'tool' }>).results;
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(results[0]).toEqual({ callId: 'a', content: 'slow ok' });
    expect(results[1]).toMatchObject({ isError: true, content: 'Unknown tool "missing".' });
    expect(results[2]).toMatchObject({ isError: true, content: expect.stringContaining('INVALID_JSON') });
    expect(results[3]).toMatchObject({ isError: true, content: 'Invalid arguments for needs_id: missing id' });
    expect(results[4]).toMatchObject({ isError: true, content: 'Tool error: disk full' });
    expect(end.reason).toBe('completed');
  });

  it('stops at maxSteps', async () => {
    const loopForever = () => [done([toolCall(`c${Math.random()}`, 'noop', {})], 'tool_use')];
    const model = fakeModel(loopForever, loopForever, loopForever);
    const { end } = await runTurnToEnd({ model, messages: [user('go')], tools: [tool('noop', async () => 'ok')], maxSteps: 2 });
    expect(end.reason).toBe('max_steps');
    expect(model.requests.length).toBe(2);
    expect(end.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
  });

  it('on max_tokens keeps the text, drops cut-off tool calls and runs nothing', async () => {
    let ran = false;
    const model = fakeModel(() => reply('long answer', [toolCall('c1', 'noop', {})], 'max_tokens'));
    const { end } = await runTurnToEnd({
      model,
      messages: [user('go')],
      tools: [
        tool('noop', async () => {
          ran = true;
          return 'ok';
        }),
      ],
    });
    expect(ran).toBe(false);
    expect(end.reason).toBe('max_tokens');
    expect(end.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'long answer' }] }]);
  });

  it('on refusal discards the partial answer', async () => {
    const model = fakeModel(() => [
      { type: 'text', delta: 'part' },
      done([{ type: 'text', text: 'part' }], 'refusal', { stopDetails: { category: 'cyber' } }),
    ]);
    const { end } = await runTurnToEnd({ model, messages: [user('q')] });
    expect(end).toMatchObject({ reason: 'refusal', messages: [], stopDetails: { category: 'cyber' } });
  });

  it('when aborted mid-stream keeps the text the user already saw', async () => {
    const controller = new AbortController();
    const model = fakeModel(async function* (request): AsyncGenerator<ModelEvent> {
      yield { type: 'text', delta: '部分回答' };
      await new Promise((_, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason)));
    });
    const events = [];
    for await (const event of runTurn({ model, messages: [user('q')], signal: controller.signal })) {
      events.push(event);
      if (event.type === 'text') controller.abort();
    }
    expect(events.at(-1)).toMatchObject({
      type: 'turn_end',
      reason: 'aborted',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '部分回答' }] }],
    });
  });

  it('leaves no unhandled rejection when the stream fails after cancelling', async () => {
    const controller = new AbortController();
    const model = fakeModel(async function* (request): AsyncGenerator<ModelEvent> {
      yield { type: 'text', delta: 'x' };
      await new Promise((r) => setTimeout(r, 5));
      throw request.signal!.reason;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      for await (const event of runTurn({ model, messages: [user('q')], signal: controller.signal })) {
        if (event.type === 'text') controller.abort();
      }
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('closes the model stream when the caller stops reading', async () => {
    let closed = false;
    const model = fakeModel(async function* (): AsyncGenerator<ModelEvent> {
      try {
        yield { type: 'text', delta: 'a' };
        yield { type: 'text', delta: 'b' };
      } finally {
        closed = true;
      }
    });
    for await (const event of runTurn({ model, messages: [user('q')] })) {
      if (event.type === 'text') break;
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toBe(true);
  });

  it('on timeout during a tool still answers every tool call', async () => {
    const model = fakeModel(() => [done([toolCall('c1', 'hang', {})], 'tool_use')]);
    const hang = tool('hang', () => new Promise<string>(() => {}));
    const { end } = await runTurnToEnd({ model, messages: [user('q')], tools: [hang], timeoutMs: 20 });
    expect(end.reason).toBe('timeout');
    expect(end.messages[1]).toMatchObject({ role: 'tool', results: [{ callId: 'c1', isError: true, content: expect.stringContaining('Cancelled') }] });
  });

  it('appends what beforeModelCall returns before each model call', async () => {
    const model = fakeModel(
      () => [done([toolCall('c1', 'noop', {})], 'tool_use')],
      () => reply('ok'),
    );
    const { end } = await runTurnToEnd({
      model,
      messages: [user('q')],
      tools: [tool('noop', async () => 'done')],
      beforeModelCall: ({ step, transcript }) => [user(`[status step ${step}, ${transcript.length} messages]`)],
    });
    expect(model.requests[0]!.messages.at(-1)).toEqual(user('[status step 1, 1 messages]'));
    expect(model.requests[1]!.messages.at(-1)).toEqual(user('[status step 2, 4 messages]'));
    expect(end.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
  });

  it('ends with reason error when the model fails', async () => {
    const failure = new ModelError('overloaded', { provider: 'fake', retryable: true });
    const model = fakeModel(() => {
      throw failure;
    });
    const { end } = await runTurnToEnd({ model, messages: [user('q')] });
    expect(end).toMatchObject({ reason: 'error', error: failure, messages: [] });
  });
});
