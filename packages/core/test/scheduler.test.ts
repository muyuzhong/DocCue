import { describe, expect, it } from 'vitest';
import { plainContext } from '../src/context/plain.js';
import type { Tool } from '../src/loop/types.js';
import { ModelError } from '../src/model/errors.js';
import type { ModelAdapter, ModelEvent } from '../src/model/types.js';
import { answerQuestions } from '../src/scheduler/triggers.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import type { AgentOutput, Scheduler, Trigger } from '../src/scheduler/types.js';
import type { SessionStore } from '../src/state/store.js';
import { done, fakeModel, reply, toolCall } from './helpers.js';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function record(scheduler: Scheduler, sessionId: string): AgentOutput[] {
  const outputs: AgentOutput[] = [];
  scheduler.subscribe(sessionId, (output) => outputs.push(output));
  return outputs;
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const waitForAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason));
  });

describe('createScheduler', () => {
  it('answers a user message and keeps the history', async () => {
    const model = fakeModel(() => reply('你好'));
    const scheduler = createScheduler({ model, context: plainContext('sys') });
    const outputs = record(scheduler, 's1');
    await scheduler.push('s1', { type: 'user_message', content: '在吗' });
    await scheduler.idle('s1');

    expect(outputs.map((o) => o.type)).toEqual(['turn_start', 'status', 'text', 'text', 'turn_end']);
    expect(outputs[0]).toMatchObject({ type: 'turn_start', reason: 'user_message' });
    expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed', usage: { inputTokens: 10 } });
    expect(model.requests[0]).toMatchObject({ system: 'sys', messages: [{ role: 'user', content: '在吗' }] });
    expect((await scheduler.getSession('s1'))!.history).toEqual([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
    ]);
  });

  it('applies perception and user info without starting a turn', async () => {
    const model = fakeModel();
    const scheduler = createScheduler({ model, context: plainContext() });
    const outputs = record(scheduler, 's');
    await scheduler.push('s', {
      type: 'perception',
      page: { path: '/datasource/new', title: '新建数据源' },
      timeline: [{ at: 1, kind: 'click', target: '按钮「测试连接」', result: '出现报错「Invalid Host Format」' }],
      errors: [{ text: 'Invalid Host Format', target: '输入框「主机地址」' }],
    });
    await scheduler.push('s', { type: 'user_info', attributes: { role: '新手' }, completedTours: ['app_welcome'] });
    await scheduler.push('s', { type: 'cancel' });
    await scheduler.idle('s');

    expect(outputs).toEqual([]);
    expect(model.requests).toEqual([]);
    const session = (await scheduler.getSession('s'))!;
    expect(session.perception.page).toEqual({ path: '/datasource/new', title: '新建数据源' });
    expect(session.perception.timeline).toHaveLength(1);
    expect(session.user).toMatchObject({ attributes: { role: '新手' }, completedTours: ['app_welcome'] });
  });

  it('hands a question asked mid-turn to the running turn before its next model call', async () => {
    const toolGate = gate();
    const slow: Tool = {
      name: 'slow',
      description: 'slow',
      parameters: { type: 'object' },
      execute: async () => {
        await toolGate.promise;
        return 'done';
      },
    };
    const model = fakeModel(() => [done([toolCall('c1', 'slow', {})], 'tool_use')], () => reply('两个都答了'));
    const scheduler = createScheduler({ model, context: plainContext(), tools: [slow] });
    const outputs = record(scheduler, 's');

    await scheduler.push('s', { type: 'user_message', content: '第一个问题' });
    await waitFor(() => outputs.some((o) => o.type === 'status' && o.state === 'tool'));
    await scheduler.push('s', { type: 'user_message', content: '第二个问题' });
    toolGate.open();
    await scheduler.idle('s');

    expect(outputs.filter((o) => o.type === 'turn_start')).toHaveLength(1);
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: '第二个问题' });
    const history = (await scheduler.getSession('s'))!.history;
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    // History matches what the model saw, in order.
    expect(history.slice(0, 4)).toEqual(model.requests[1]!.messages);
  });

  it('answers a question asked during the final answer in the next turn', async () => {
    const answerGate = gate();
    const model = fakeModel(
      async function* (): AsyncGenerator<ModelEvent> {
        yield { type: 'text', delta: '答一' };
        await answerGate.promise;
        yield done([{ type: 'text', text: '答一' }]);
      },
      () => reply('答二'),
    );
    const scheduler = createScheduler({ model, context: plainContext() });
    const outputs = record(scheduler, 's');

    await scheduler.push('s', { type: 'user_message', content: '问一' });
    await waitFor(() => outputs.some((o) => o.type === 'text'));
    await scheduler.push('s', { type: 'user_message', content: '问二' });
    answerGate.open();
    await scheduler.idle('s');

    expect(outputs.filter((o) => o.type === 'turn_start' || o.type === 'turn_end').map((o) => o.type)).toEqual([
      'turn_start',
      'turn_end',
      'turn_start',
      'turn_end',
    ]);
    const history = (await scheduler.getSession('s'))!.history;
    expect(history).toEqual([
      { role: 'user', content: '问一' },
      { role: 'assistant', content: [{ type: 'text', text: '答一' }] },
      { role: 'user', content: '问二' },
      { role: 'assistant', content: [{ type: 'text', text: '答二' }] },
    ]);
    expect(model.requests[1]!.messages).toEqual(history.slice(0, 3));
  });

  it('cancel stops the running turn and keeps the text already shown', async () => {
    const model = fakeModel(async function* (request): AsyncGenerator<ModelEvent> {
      yield { type: 'text', delta: '说到一半' };
      await waitForAbort(request.signal!);
    });
    const scheduler = createScheduler({ model, context: plainContext() });
    const outputs = record(scheduler, 's');

    await scheduler.push('s', { type: 'user_message', content: '讲个长故事' });
    await waitFor(() => outputs.some((o) => o.type === 'text'));
    await scheduler.push('s', { type: 'cancel' });
    await scheduler.idle('s');

    expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'aborted' });
    expect((await scheduler.getSession('s'))!.history).toEqual([
      { role: 'user', content: '讲个长故事' },
      { role: 'assistant', content: [{ type: 'text', text: '说到一半' }] },
    ]);
  });

  it('runs different sessions at the same time, each with its own history', async () => {
    const echo: ModelAdapter = {
      provider: 'fake',
      model: 'echo',
      async *stream(request) {
        const last = request.messages.at(-1);
        const text = `echo:${last?.role === 'user' && typeof last.content === 'string' ? last.content : '?'}`;
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text', delta: text };
        yield done([{ type: 'text', text }]);
      },
    };
    const order: string[] = [];
    const scheduler = createScheduler({
      model: echo,
      context: plainContext(),
      onOutput: (id, output) => {
        if (output.type === 'turn_start' || output.type === 'turn_end') order.push(`${id}:${output.type}`);
      },
    });
    await Promise.all([scheduler.push('a', { type: 'user_message', content: 'A' }), scheduler.push('b', { type: 'user_message', content: 'B' })]);
    await Promise.all([scheduler.idle('a'), scheduler.idle('b')]);

    expect(order.slice(0, 2).sort()).toEqual(['a:turn_start', 'b:turn_start']);
    expect((await scheduler.getSession('a'))!.history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'echo:A' }] });
    expect((await scheduler.getSession('b'))!.history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'echo:B' }] });
  });

  it('reports a failed turn and keeps working', async () => {
    const model = fakeModel(
      () => {
        throw new ModelError('overloaded', { provider: 'fake', code: 'overloaded_error', retryable: true });
      },
      () => reply('好了'),
    );
    const scheduler = createScheduler({ model, context: plainContext() });
    const outputs = record(scheduler, 's');

    await scheduler.push('s', { type: 'user_message', content: '一' });
    await scheduler.idle('s');
    expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'error', error: { message: 'overloaded', code: 'overloaded_error' } });

    await scheduler.push('s', { type: 'user_message', content: '二' });
    await scheduler.idle('s');
    expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed' });
    expect((await scheduler.getSession('s'))!.history.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('reports a context failure as a failed turn', async () => {
    const scheduler = createScheduler({
      model: fakeModel(),
      context: {
        prepare: () => {
          throw new Error('no docs');
        },
      },
    });
    const outputs = record(scheduler, 's');
    await scheduler.push('s', { type: 'user_message', content: 'q' });
    await scheduler.idle('s');
    expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'error', error: { message: 'no docs' } });
  });

  it('custom triggers can start a turn from other events, but never during a running turn', async () => {
    const answerGate = gate();
    const onError: Trigger = {
      name: 'offer_help_on_error',
      check: (event, session) => (event.type === 'perception' && session.perception.errors.length > 0 ? { reason: 'offer_help' } : undefined),
    };
    const model = fakeModel(
      async function* (): AsyncGenerator<ModelEvent> {
        await answerGate.promise;
        yield* reply('地址格式不对');
      },
      () => reply('unused'),
    );
    const scheduler = createScheduler({ model, context: plainContext(), triggers: [answerQuestions, onError] });
    const outputs = record(scheduler, 's');

    await scheduler.push('s', { type: 'perception', errors: [{ text: 'Invalid Host Format' }] });
    await scheduler.push('s', { type: 'perception', errors: [{ text: 'Still invalid' }] });
    answerGate.open();
    await scheduler.idle('s');

    expect(outputs.filter((o) => o.type === 'turn_start')).toEqual([expect.objectContaining({ reason: 'offer_help' })]);
    expect((await scheduler.getSession('s'))!.perception.errors).toEqual([{ text: 'Still invalid' }]);
  });

  it('survives broken listeners and reports store failures', async () => {
    const failingStore: SessionStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error('disk full');
      },
      delete: async () => {},
    };
    const scheduler = createScheduler({ model: fakeModel(), context: plainContext(), store: failingStore });
    scheduler.subscribe('s', () => {
      throw new Error('listener bug');
    });
    const outputs = record(scheduler, 's');
    const unsubscribed: AgentOutput[] = [];
    scheduler.subscribe('s', (o) => unsubscribed.push(o))();

    await expect(scheduler.push('s', { type: 'user_message', content: 'q' })).rejects.toThrow('disk full');
    expect(outputs).toEqual([{ type: 'error', message: 'disk full' }]);
    expect(unsubscribed).toEqual([]);
    await scheduler.idle('unknown-session');
  });
});
