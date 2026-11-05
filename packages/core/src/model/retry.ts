import { sleep } from '../util/abort.js';
import { ModelError } from './errors.js';
import type { ModelAdapter } from './types.js';

export interface RetryOptions {
  /** Retries after the first attempt. Defaults to 2. */
  maxRetries?: number;
  /** First backoff delay; doubles each retry (with jitter). Defaults to 500 ms. */
  baseDelayMs?: number;
  /** Cap for one delay. Defaults to 8000 ms. */
  maxDelayMs?: number;
  onRetry?: (error: ModelError, attempt: number, delayMs: number) => void;
}

/**
 * Wraps an adapter so retryable failures (429, 5xx, overloaded, dropped connections) are retried
 * with backoff. Only failures that happen before the first event are retried: once text has
 * reached the caller, a retry would repeat it.
 */
export function withRetry(model: ModelAdapter, options: RetryOptions = {}): ModelAdapter {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;

  return {
    provider: model.provider,
    model: model.model,
    async *stream(request) {
      for (let attempt = 0; ; attempt++) {
        let started = false;
        try {
          for await (const event of model.stream(request)) {
            started = true;
            yield event;
          }
          return;
        } catch (error) {
          if (started || !(error instanceof ModelError) || !error.retryable || attempt >= maxRetries) throw error;
          const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.5 + Math.random() / 2);
          const delayMs = Math.min(maxDelayMs, error.retryAfterMs ?? backoff);
          options.onRetry?.(error, attempt + 1, delayMs);
          await sleep(delayMs, request.signal);
        }
      }
    },
  };
}
