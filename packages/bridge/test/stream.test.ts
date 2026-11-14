import type { StreamEvent } from '@doccue/protocol';
import { describe, expect, it } from 'vitest';
import { readAnswer } from '../src/stream.js';

const END: StreamEvent = { type: 'end', reason: 'completed', item: { type: 'model', messages: [] }, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };

/** A response body that arrives in the given pieces. */
function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>): Promise<{ events: StreamEvent[]; error?: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of readAnswer(stream)) events.push(event);
    return { events };
  } catch (error) {
    return { events, error };
  }
}

describe('readAnswer', () => {
  it('reads events with any line ending, split anywhere, up to the end event', async () => {
    const text = `data: ${JSON.stringify({ type: 'text', delta: '你好' })}`;
    const end = `data: ${JSON.stringify(END)}`;
    // `\r\n\r\n` from a proxy, with one `\r\n` cut in half between chunks, then plain `\n\n`.
    const { events, error } = await read(body(`${text}\r\n\r`, `\n: comment\r\n\r\n${end.slice(0, 9)}`, `${end.slice(9)}\n\n`));
    expect(error).toBeUndefined();
    expect(events).toEqual([{ type: 'text', delta: '你好' }, END]);
  });

  it('fails when the stream stops before the end event, after passing on what came', async () => {
    const { events, error } = await read(body(`data: ${JSON.stringify({ type: 'text', delta: '一半' })}\n\n`));
    expect(events).toEqual([{ type: 'text', delta: '一半' }]);
    expect(error).toEqual(new Error('DocCue: the answer was cut off before it ended'));
  });
});
