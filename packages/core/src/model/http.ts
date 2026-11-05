import { abortError, isAbortError } from '../util/abort.js';
import { ModelError, errorFromResponse, networkError } from './errors.js';
import { parseSSE, type SSEMessage } from './sse.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/** POSTs a JSON body and returns the streaming response body, or throws a `ModelError`. */
export async function postForStream(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (isAbortError(error)) throw error;
    throw networkError(provider, error);
  }
  if (!response.ok) throw await errorFromResponse(provider, response);
  if (!response.body) {
    throw new ModelError(`${provider}: response has no body`, { provider, retryable: true });
  }
  return response.body;
}

/** SSE messages from a response body; a dropped connection becomes a retryable `ModelError`. */
export async function* sseEvents(
  provider: string,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<SSEMessage> {
  try {
    yield* parseSSE(body);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (isAbortError(error) || error instanceof ModelError) throw error;
    throw networkError(provider, error);
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
