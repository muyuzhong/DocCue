/** Talks to the DocCue handler: posts events and listens to the session's output stream. */
import type { AgentOutput, InputEvent } from '@doccue/core';

export interface Client {
  post(events: InputEvent[]): Promise<void>;
  subscribe(listener: (output: AgentOutput) => void): () => void;
  close(): void;
}

export interface ClientOptions {
  endpoint: string;
  sessionId: string;
  /** How long `post` waits for the output stream to connect first. Defaults to 3 s. */
  connectTimeoutMs?: number;
}

export function createClient(options: ClientOptions): Client {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const listeners = new Set<(output: AgentOutput) => void>();
  const source = new EventSource(`${endpoint}/stream?sessionId=${encodeURIComponent(options.sessionId)}`);
  // Post only once the stream is open, so the start of the answer isn't missed.
  let markOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => (markOpen = resolve));
  source.onopen = () => markOpen();
  source.onmessage = (message: MessageEvent<string>) => {
    let output: AgentOutput;
    try {
      output = JSON.parse(message.data) as AgentOutput;
    } catch {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(output);
      } catch {
        // A broken listener must not stop the others.
      }
    }
  };

  return {
    async post(events) {
      await Promise.race([opened, new Promise((resolve) => setTimeout(resolve, options.connectTimeoutMs ?? 3000))]);
      const response = await fetch(`${endpoint}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: options.sessionId, events }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { errors?: string[] };
        throw new Error(`DocCue ${response.status}: ${(body.errors ?? []).join('; ') || response.statusText}`);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      source.close();
      listeners.clear();
    },
  };
}
