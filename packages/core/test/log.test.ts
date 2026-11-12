import { describe, expect, it } from 'vitest';
import { toJsonLine, withModelLog, type LogRecord, type ModelCallRecord } from '../src/log/log.js';
import { ModelError } from '../src/model/errors.js';
import { collect, fakeModel, reply } from './helpers.js';

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

describe('toJsonLine', () => {
  it('replaces image data with its size unless asked to keep it', () => {
    const record: LogRecord = {
      kind: 'model_call',
      at: 1,
      provider: 'fake',
      model: 'fake-1',
      durationMs: 5,
      request: { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }] },
    };
    expect(toJsonLine(record)).toContain('"data":"[image: 4 base64 chars]"');
    expect(toJsonLine(record, { keepImages: true })).toContain('"data":"AAAA"');
    expect(JSON.parse(toJsonLine(record))).toMatchObject({ kind: 'model_call', model: 'fake-1' });
  });
});

