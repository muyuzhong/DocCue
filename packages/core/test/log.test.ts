import { describe, expect, it } from 'vitest';
import { toJsonLine, withModelLog, type LogRecord, type ModelCallRecord } from '../src/log/log.js';
import { ModelError } from '../src/model/errors.js';
import { collect } from './helpers.js';
import { describeWithModel, realModel, rejectedModel } from './model.js';

const ask = (text: string) => ({ system: 'Answer in one word.', messages: [{ role: 'user' as const, content: text }] });

describeWithModel('withModelLog with the real model', () => {
  it('records exactly what was sent, what came back and how long it took', async () => {
    const records: ModelCallRecord[] = [];
    const model = withModelLog(realModel(), (record) => records.push(record));
    await collect(model.stream(ask('Capital of France?')));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'model_call',
      provider: model.provider,
      model: model.model,
      request: ask('Capital of France?'),
      result: { stopReason: 'end', message: { role: 'assistant' } },
    });
    expect(JSON.stringify(records[0]!.result!.message)).toMatch(/Paris/i);
    expect(records[0]!.firstOutputMs).toBeGreaterThan(0);
    expect(records[0]!.durationMs).toBeGreaterThanOrEqual(records[0]!.firstOutputMs!);
  });

  it('records failures and calls cut short, and survives a broken logger', async () => {
    const records: ModelCallRecord[] = [];
    const failing = withModelLog(rejectedModel(), (record) => records.push(record));
    await expect(collect(failing.stream(ask('hi')))).rejects.toBeInstanceOf(ModelError);
    expect(records[0]!.error).toMatchObject({ name: 'ModelError', retryable: false });

    const cut = withModelLog(realModel(), (record) => records.push(record));
    for await (const _ of cut.stream(ask('Count from 1 to 300, one number per line.'))) break;
    expect(records[1]!.error).toMatchObject({ name: 'Stopped' });

    const broken = withModelLog(realModel(), () => {
      throw new Error('disk full');
    });
    expect((await collect(broken.stream(ask('Capital of Italy?')))).at(-1)).toMatchObject({ type: 'done' });
  });
});

describe('toJsonLine', () => {
  it('replaces image data with its size unless asked to keep it', () => {
    const record: LogRecord = {
      kind: 'model_call',
      at: 1,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      durationMs: 5,
      request: { messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }] },
    };
    expect(toJsonLine(record)).toContain('"data":"[image: 4 base64 chars]"');
    expect(toJsonLine(record, { keepImages: true })).toContain('"data":"AAAA"');
    expect(JSON.parse(toJsonLine(record))).toMatchObject({ kind: 'model_call', model: 'claude-haiku-5-5' });
  });
});
