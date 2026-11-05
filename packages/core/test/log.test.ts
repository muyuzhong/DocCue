import { describe, expect, it } from 'vitest';
import { statusContext } from '../src/context/status-context.js';
import { createMemoryLog, toJsonLine, withModelLog, type LogRecord, type ModelCallRecord } from '../src/log/log.js';
import { ModelError } from '../src/model/errors.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import { collect, done, fakeModel, reply, toolCall } from './helpers.js';

describe('withModelLog', () => {
  it('records the request, the result and timings', async () => {
    let t = 1000;
    const now = () => (t += 10);
    const records: ModelCallRecord[] = [];
    const model = withModelLog(fakeModel(() => reply('hi')), (r) => records.push(r), now);
    await collect(model.stream({ system: 'sys', messages: [{ role: 'user', content: 'q' }] }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'model_call',
      provider: 'fake',
      model: 'fake-1',
      request: { system: 'sys', messages: [{ role: 'user', content: 'q' }] },
      firstOutputMs: 10,
      result: { stopReason: 'end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    });
    expect(records[0]!.durationMs).toBeGreaterThan(0);
  });

  it('records failures and calls cut short, and survives a broken logger', async () => {
    const records: ModelCallRecord[] = [];
    const failing = withModelLog(
      fakeModel(() => {
        throw new ModelError('overloaded', { provider: 'fake', status: 529, code: 'overloaded_error', retryable: true });
      }),
      (r) => records.push(r),
    );
    await expect(collect(failing.stream({ messages: [] }))).rejects.toThrow('overloaded');
    expect(records[0]!.error).toEqual({ name: 'ModelError', message: 'overloaded', code: 'overloaded_error', status: 529, retryable: true });

    const cut = withModelLog(fakeModel(() => reply('long answer')), (r) => records.push(r));
    for await (const _ of cut.stream({ messages: [] })) break;
    expect(records[1]!.error).toMatchObject({ name: 'Stopped' });

    const broken = withModelLog(fakeModel(() => reply('ok')), () => {
      throw new Error('disk full');
    });
    expect((await collect(broken.stream({ messages: [] }))).at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('scheduler logging', () => {
  it('records events, turns and each model call with session, turn and step', async () => {
    const { logger, records } = createMemoryLog();
    const model = fakeModel(
      () => [done([toolCall('c1', 'noop', {})], 'tool_use')],
      () => reply('好了'),
    );
    const scheduler = createScheduler({
      model,
      context: statusContext(),
      logger,
      tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object' }, execute: async () => 'ok' }],
    });
    await scheduler.push('s', { type: 'perception', page: { path: '/x' } });
    await scheduler.push('s', { type: 'user_message', content: '试试' });
    await scheduler.idle('s');

    expect(records.map((r) => r.kind)).toEqual(['event', 'event', 'turn_start', 'model_call', 'model_call', 'turn_end']);
    const calls = records.filter((r): r is Extract<LogRecord, { kind: 'model_call' }> => r.kind === 'model_call');
    const turnId = (records[2] as Extract<LogRecord, { kind: 'turn_start' }>).turnId;
    expect(calls.map((c) => [c.sessionId, c.turnId, c.step])).toEqual([
      ['s', turnId, 1],
      ['s', turnId, 2],
    ]);
    // The logged request is exactly what the model received.
    expect(calls[1]!.request.messages).toEqual(model.requests[1]!.messages);
    expect(records.at(-1)).toMatchObject({ kind: 'turn_end', sessionId: 's', turnId, reason: 'completed' });
  });
});

describe('toJsonLine', () => {
  it('replaces image data with its size unless asked to keep it', () => {
    const record: LogRecord = {
      kind: 'event',
      at: 1,
      sessionId: 's',
      event: { type: 'user_message', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
    };
    expect(toJsonLine(record)).toContain('"data":"[image: 4 base64 chars]"');
    expect(toJsonLine(record, { keepImages: true })).toContain('"data":"AAAA"');
    expect(JSON.parse(toJsonLine(record))).toMatchObject({ kind: 'event', sessionId: 's' });
  });
});

