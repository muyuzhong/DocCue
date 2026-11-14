/** Reading an answer: the server-sent events `POST {endpoint}/turn` streams back. */
import type { StreamEvent } from '@doccue/protocol';

/**
 * The events of one answer, one JSON object per server-sent event, up to and including `end`.
 * Lines may end in `\n`, `\r\n` or `\r`: proxies rewrite them. Throws when the stream stops before
 * the `end` event, so a cut-off answer is never taken for a finished one.
 */
export async function* readAnswer(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A `\r` at the very end may be the first half of `\r\n`: it waits for the next chunk.
      const keep = !done && buffer.endsWith('\r') ? 1 : 0;
      const lines = buffer.slice(0, buffer.length - keep).split(/\r\n|\r|\n/);
      buffer = lines.pop()! + buffer.slice(buffer.length - keep);
      // At the end of the stream, the last line and the event it belongs to count as finished.
      if (done) lines.push(buffer, '');
      for (const line of lines) {
        if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
        if (line !== '' || data.length === 0) continue;
        const event = JSON.parse(data.join('\n')) as StreamEvent;
        data = [];
        yield event;
        if (event.type === 'end') return;
      }
      if (done) throw new Error('DocCue: the answer was cut off before it ended');
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
