import { abortError, isAbortError, raceAbort } from '../util/abort.js';
import { ModelError, errorFromResponse, networkError } from './errors.js';
import { parseSSE, type SSEMessage } from './sse.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/** Default for `idleTimeoutMs`: how long a request may go without receiving a single byte. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface StreamRequest {
  provider: string;
  fetchImpl: FetchLike;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
  /** Abort when no bytes arrive for this long (keep-alive pings count). 0 disables. */
  idleTimeoutMs: number;
}

/**
 * POSTs a JSON body and yields the SSE messages of the response. Failures become `ModelError`s:
 * HTTP errors, dropped connections, and silence longer than `idleTimeoutMs` (retryable, code
 * `timeout`). An abort through `signal` is rethrown as an abort error.
 */
export async function* streamSSE(request: StreamRequest): AsyncGenerator<SSEMessage> {
  const { provider, signal, idleTimeoutMs } = request;
  if (signal?.aborted) throw abortError(signal);
  const controller = new AbortController();
  // Set once the body is flowing. Erroring it ourselves stops the read even when a custom
  // `fetch` ignores the abort signal.
  let bodyController: TransformStreamDefaultController<Uint8Array> | undefined;
  const stop = (reason?: unknown) => {
    controller.abort(reason);
    bodyController?.error(controller.signal.reason);
  };
  const onAbort = () => stop(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  // While the caller holds a message we're not waiting on the network, so the clock stops.
  let paused = false;
  const arm = () => {
    if (idleTimeoutMs <= 0 || paused) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, idleTimeoutMs);
  };
  const translate = (error: unknown): unknown => {
    if (timedOut) {
      return new ModelError(`${provider}: no response for ${Math.round(idleTimeoutMs / 1000)}s`, {
        provider,
        code: 'timeout',
        retryable: true,
      });
    }
    if (signal?.aborted) return abortError(signal);
    if (isAbortError(error) || error instanceof ModelError) return error;
    return networkError(provider, error);
  };

  try {
    arm();
    let response: Response;
    try {
      const pending = request.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      // Race against our own signal too, in case a custom `fetch` ignores it.
      response = await raceAbort(pending, controller.signal);
      if (!response.ok) throw await raceAbort(errorFromResponse(provider, response), controller.signal);
    } catch (error) {
      throw translate(error);
    }
    if (!response.body) throw new ModelError(`${provider}: response has no body`, { provider, retryable: true });

    arm();
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        start(output) {
          bodyController = output;
        },
        transform(chunk, output) {
          arm();
          output.enqueue(chunk);
        },
      }),
    );
    try {
      for await (const message of parseSSE(body)) {
        paused = true;
        clearTimeout(timer);
        yield message;
        paused = false;
        arm();
      }
    } catch (error) {
      throw translate(error);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function parseEventData(provider: string, data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  } catch {
    // Fall through to the error below.
  }
  throw new ModelError(`${provider}: invalid JSON in stream: ${data.slice(0, 200)}`, { provider });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses tool-call arguments; returns `undefined` for invalid JSON. Empty input means `{}`. */
export function parseToolArgs(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
