import { describe, expect, it } from 'vitest';
import { streamSSE, type FetchLike } from '../src/model/http.js';
import { ModelError } from '../src/model/errors.js';
import type { SSEMessage } from '../src/model/sse.js';

/** A response whose body sends each chunk after the given delay (ms since the previous one). */
function timedResponse(chunks: Array<[delayMs: number, text: string]>, close = true): Response {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let at = 0;
      for (const [delay, text] of chunks) {
        at += delay;
        timers.push(setTimeout(() => controller.enqueue(encoder.encode(text)), at));
      }
      if (close) timers.push(setTimeout(() => controller.close(), at + 1));
    },
    cancel() {
      timers.forEach(clearTimeout);
    },
  });
  return new Response(body, { status: 200 });
}

const request = (fetchImpl: FetchLike, idleTimeoutMs: number, signal?: AbortSignal) =>
  streamSSE({ provider: 'test', fetchImpl, url: 'http://x', headers: {}, body: {}, signal, idleTimeoutMs });

async function collect(stream: AsyncIterable<SSEMessage>): Promise<SSEMessage[]> {
  const out: SSEMessage[] = [];
  for await (const message of stream) out.push(message);
  return out;
}

describe('streamSSE idle timeout', () => {
  it('times out when the server never answers', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const started = Date.now();
    const error = await collect(request(hanging, 30)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('times out when the stream stalls midway, after what already arrived', async () => {
    const fetchImpl: FetchLike = async () => timedResponse([[0, 'data: 1\n\n']], false);
    const received: string[] = [];
    const error = await (async () => {
      for await (const message of request(fetchImpl, 30)) received.push(message.data);
    })().catch((e: unknown) => e);
    expect(received).toEqual(['1']);
    expect(error).toMatchObject({ name: 'ModelError', code: 'timeout' });
  });

  it('keep-alive comments count as activity', async () => {
    const pings: Array<[number, string]> = Array.from({ length: 8 }, () => [10, ': ping\n\n']);
    const fetchImpl: FetchLike = async () => timedResponse([...pings, [10, 'data: done\n\n']]);
    expect(await collect(request(fetchImpl, 30))).toEqual([{ event: 'message', data: 'done' }]);
  });

  it('does not count time the caller spends holding a message', async () => {
    const fetchImpl: FetchLike = async () => timedResponse([[0, 'data: 1\n\ndata: 2\n\n']]);
    const received: string[] = [];
    for await (const message of request(fetchImpl, 20)) {
      received.push(message.data);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received).toEqual(['1', '2']);
  });

  it('reports a cancel as an abort, not a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = async () => timedResponse([[0, 'data: 1\n\n']], false);
    const error = await (async () => {
      for await (const _ of request(fetchImpl, 1000, controller.signal)) controller.abort();
    })().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});
