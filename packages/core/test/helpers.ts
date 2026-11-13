import type { FetchLike } from '../src/model/http.js';
import type { AssistantContent, ModelDone, StopReason } from '../src/model/types.js';

/** A streaming SSE response, cut into small chunks to exercise split lines and split UTF-8. */
export function sseResponse(events: Array<{ event?: string; data: unknown }>, chunkSize = 7): Response {
  const text = events
    .map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch stub that returns the given responses in order and records every request. */
export function mockFetch(...responses: Response[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    if (!next) throw new Error('mockFetch: no response left');
    return next;
  };
  return { fetch, calls };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export function done(content: AssistantContent[], stopReason: StopReason = 'end', extra: Partial<ModelDone> = {}): ModelDone {
  return {
    type: 'done',
    message: { role: 'assistant', content },
    stopReason,
    rawStopReason: null,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...extra,
  };
}
