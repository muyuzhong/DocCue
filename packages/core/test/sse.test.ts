import { describe, expect, it } from 'vitest';
import { parseSSE } from '../src/model/sse.js';
import { collect } from './helpers.js';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSSE', () => {
  it('parses events, names, comments and multi-line data', async () => {
    const events = await collect(parseSSE(streamOf(': ping\n\nevent: a\ndata: 1\ndata: 2\n\ndata: {"x":1}\n\n')));
    expect(events).toEqual([
      { event: 'a', data: '1\n2' },
      { event: 'message', data: '{"x":1}' },
    ]);
  });

  it('handles CRLF split across chunks and a missing final blank line', async () => {
    const events = await collect(parseSSE(streamOf('data: one\r', '\n\r\ndata: tw', 'o')));
    expect(events).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
  });

  it('decodes UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await collect(parseSSE(body))).toEqual([{ event: 'message', data: '你好' }]);
  });

  it('cancels the underlying stream when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\n\ndata: 2\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of parseSSE(body)) {
      expect(event.data).toBe('1');
      break;
    }
    expect(cancelled).toBe(true);
  });
});
