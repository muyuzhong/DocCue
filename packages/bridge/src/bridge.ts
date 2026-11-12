/**
 * The bridge: drop it into a page and it records what the user does. The record stays in the
 * browser until the user asks something; then it goes up with the screen snapshot and the
 * question.
 *
 * The bridge also keeps the conversation (in sessionStorage, one per tab) and sends it in full
 * with every request: the backend keeps nothing between requests.
 */
import { PROTOCOL_VERSION, type Item, type Perception, type StreamEvent, type TimelineEntry, type TurnRequest } from '@doccue/protocol';
import { DEFAULT_ERROR_SELECTORS } from './errors.js';
import { createRecorder } from './recorder.js';
import { buildScreen } from './screen.js';

export interface BridgeOptions {
  /** Where the DocCue handler is mounted, e.g. `/doccue`. */
  endpoint: string;
  /** The user's language, e.g. `zh-CN`. Defaults to the page's `lang`, then the browser's. */
  locale?: string;
  /** What the host app knows about the user, e.g. role or plan. */
  user?: Record<string, unknown>;
  /** Extra selectors for error messages, e.g. your UI library's (common ones are built in). */
  errorSelectors?: string[];
  /** Size cap of the screen snapshot, in nodes. Defaults to 300. */
  maxNodes?: number;
  /** How long after an action its effects count as caused by it. Defaults to 1000 ms. */
  resultWindowMs?: number;
  /** Report failed fetch / XHR requests. Defaults to true. */
  captureNetwork?: boolean;
  /** Actions kept locally while waiting for a question. Defaults to 100. */
  timelineLimit?: number;
  document?: Document;
}

type Listener<T extends StreamEvent['type']> = (event: Extract<StreamEvent, { type: T }>) => void;

export interface Bridge {
  /** Sends the question with everything recorded since the last one. Resolves when the answer ends. */
  ask(question: string): Promise<void>;
  /** Stops the answer in progress. */
  stop(): void;
  /** Starts a new conversation. */
  reset(): void;
  /** Listens to one kind of event of the answer. Returns the unsubscribe function. */
  on<T extends StreamEvent['type']>(type: T, listener: Listener<T>): () => void;
  /** Actions recorded locally and not sent yet. */
  recorded(): TimelineEntry[];
  /** What the next question would send. */
  perceive(): Perception;
  /** The conversation so far, as sent with every request. */
  conversation(): Item[];
  destroy(): void;
}

const CONVERSATION_KEY = 'doccue:conversation';
const UNSENT_KEY = 'doccue:unsent';

function sessionStore(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // Blocked by privacy settings.
  }
}

/** Reads the server-sent events of a response body, one JSON object per event. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';
    for (const message of messages) {
      const data = message
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield JSON.parse(data) as StreamEvent;
    }
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  const document = options.document ?? globalThis.document;
  const storage = sessionStore();
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const errorSelectors = [...DEFAULT_ERROR_SELECTORS, ...(options.errorSelectors ?? [])];
  const timelineLimit = options.timelineLimit ?? 100;
  const locale = options.locale ?? (document.documentElement.lang || globalThis.navigator?.language);

  const load = <T>(key: string): T[] => {
    try {
      return JSON.parse(storage?.getItem(key) ?? '[]') as T[];
    } catch {
      return [];
    }
  };
  const save = (key: string, value: unknown) => {
    try {
      storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: keep it in memory only.
    }
  };

  // Both survive a page reload.
  let items = load<Item>(CONVERSATION_KEY);
  let unsent = load<TimelineEntry>(UNSENT_KEY);
  let running: AbortController | undefined;
  const listeners = new Map<string, Set<(event: StreamEvent) => void>>();

  const recorder = createRecorder({
    document,
    errorSelectors,
    resultWindowMs: options.resultWindowMs ?? 1000,
    captureNetwork: options.captureNetwork ?? true,
    skipUrl: (url) => {
      try {
        return new URL(url, document.location?.href).pathname.startsWith(new URL(endpoint, document.location?.href).pathname);
      } catch {
        return false;
      }
    },
    onEntry: (entry) => {
      unsent = [...unsent, entry].slice(-timelineLimit);
      save(UNSENT_KEY, unsent);
    },
  });

  const perceive = (): Perception => ({
    at: Date.now(),
    screen: buildScreen(document, { errorSelectors, ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }) }).screen,
    actions: [...unsent],
  });

  const emit = (event: StreamEvent) => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
  };

  return {
    async ask(question) {
      // A new question replaces the answer in progress.
      running?.abort();
      const controller = (running = new AbortController());
      recorder.flush();
      items.push({ type: 'user', text: question, perception: perceive() });
      unsent = [];
      save(CONVERSATION_KEY, items);
      save(UNSENT_KEY, unsent);

      const request: TurnRequest = {
        v: PROTOCOL_VERSION,
        conversation: items,
        ...(locale ? { locale } : {}),
        ...(options.user ? { user: options.user } : {}),
      };
      try {
        const response = await fetch(`${endpoint}/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as { errors?: string[] };
          throw new Error(`DocCue ${response.status}: ${(body.errors ?? []).join('; ') || response.statusText}`);
        }
        for await (const event of readEvents(response.body)) {
          if (event.type === 'end' && event.item.type === 'model' && event.item.messages.length > 0) {
            items.push(event.item);
            save(CONVERSATION_KEY, items);
          }
          emit(event);
        }
      } catch (error) {
        // Stopped on purpose: nothing to report.
        if (!controller.signal.aborted) throw error;
      } finally {
        if (running === controller) running = undefined;
      }
    },
    stop() {
      running?.abort();
    },
    reset() {
      running?.abort();
      items = [];
      save(CONVERSATION_KEY, items);
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(listener as (event: StreamEvent) => void);
      return () => set.delete(listener as (event: StreamEvent) => void);
    },
    recorded: () => [...unsent],
    perceive,
    conversation: () => [...items],
    destroy() {
      running?.abort();
      recorder.stop();
      listeners.clear();
    },
  };
}
