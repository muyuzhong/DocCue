export interface SSEMessage {
  /** The `event:` field, or `message` when absent. */
  event: string;
  /** All `data:` lines of the event, joined with `\n`. */
  data: string;
}

/**
 * Parses a Server-Sent Events byte stream. Handles `\n`, `\r\n` and `\r` line endings, events
 * split across chunks, multi-line data and `:` comments. Stopping early cancels the stream.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let finished = false;

  function* takeLines(final: boolean): Generator<string> {
    while (true) {
      const index = buffer.search(/[\r\n]/);
      if (index === -1) return;
      // A trailing `\r` may be the first half of `\r\n`: wait for the next chunk.
      if (buffer[index] === '\r' && index === buffer.length - 1 && !final) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1));
      yield line;
    }
  }

  function processLine(line: string): SSEMessage | undefined {
    if (line === '') {
      if (data.length === 0) {
        event = '';
        return undefined;
      }
      const message = { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return message;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    return undefined;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) {
        const message = processLine(line);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    for (const line of takeLines(true)) {
      const message = processLine(line);
      if (message) yield message;
    }
    if (buffer) {
      const message = processLine(buffer);
      buffer = '';
      if (message) yield message;
    }
    // Be lenient with a stream that ends without the final blank line.
    const last = processLine('');
    finished = true;
    if (last) yield last;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
