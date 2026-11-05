import { describe, expect, it } from 'vitest';
import { ModelError } from '../src/model/errors.js';
import { withRetry } from '../src/model/retry.js';
import type { ModelAdapter, ModelEvent } from '../src/model/types.js';
import { collect, done } from './helpers.js';

function flaky(...attempts: Array<() => AsyncGenerator<ModelEvent>>): ModelAdapter & { count: () => number } {
  let calls = 0;
  return {
    provider: 'fake',
    model: 'm',
    count: () => calls,
    stream() {
      const attempt = attempts[calls++];
      if (!attempt) throw new Error('no attempt left');
      return attempt();
    },
  };
}

const retryable = new ModelError('overloaded', { provider: 'fake', retryable: true });

describe('withRetry', () => {
  it('retries retryable errors that happen before any output', async () => {
    const model = flaky(
      async function* () {
        throw retryable;
      },
      async function* () {
        yield { type: 'text', delta: 'ok' };
        yield done([{ type: 'text', text: 'ok' }]);
      },
    );
    const retries: number[] = [];
    const events = await collect(withRetry(model, { baseDelayMs: 1, onRetry: (_e, n) => retries.push(n) }).stream({ messages: [] }));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(retries).toEqual([1]);
  });

  it('does not retry once output has started, or for non-retryable errors', async () => {
    const midStream = flaky(async function* () {
      yield { type: 'text', delta: 'half' };
      throw retryable;
    });
    await expect(collect(withRetry(midStream, { baseDelayMs: 1 }).stream({ messages: [] }))).rejects.toBe(retryable);
    expect(midStream.count()).toBe(1);

    const fatal = new ModelError('bad request', { provider: 'fake', status: 400 });
    const badRequest = flaky(async function* () {
      throw fatal;
    });
    await expect(collect(withRetry(badRequest, { baseDelayMs: 1 }).stream({ messages: [] }))).rejects.toBe(fatal);
    expect(badRequest.count()).toBe(1);
  });

  it('gives up after maxRetries', async () => {
    const failing = async function* (): AsyncGenerator<ModelEvent> {
      throw retryable;
    };
    const model = flaky(failing, failing, failing);
    await expect(collect(withRetry(model, { maxRetries: 2, baseDelayMs: 1 }).stream({ messages: [] }))).rejects.toBe(retryable);
    expect(model.count()).toBe(3);
  });
});
