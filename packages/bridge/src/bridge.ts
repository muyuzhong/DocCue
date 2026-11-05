/**
 * The bridge: drop it into a page and it records what the user does. Following the design, the
 * record stays in the browser until the user asks something; then it goes up in one request
 * together with the screen tree, the visible errors and the question.
 */
import type { ActiveError, AgentOutput, InputEvent, PageInfo, TimelineEntry } from '@doccue/core';
import { createClient, type Client } from './client.js';
import { DEFAULT_ERROR_SELECTORS, collectErrors } from './errors.js';
import { createRecorder } from './recorder.js';
import { buildScreen } from './screen.js';

export interface BridgeUser {
  attributes?: Record<string, unknown>;
  completedTours?: string[];
}

export interface BridgeOptions {
  /** Where the DocCue handler is mounted, e.g. `/doccue`. */
  endpoint: string;
  /** Defaults to one ID per browser tab (kept in sessionStorage). */
  sessionId?: string;
  /** Sent with the next question. */
  user?: BridgeUser;
  /** Extra selectors for error messages, e.g. your UI library's (common ones are built in). */
  errorSelectors?: string[];
  /** Screen tree size cap in characters. Defaults to 8000. */
  screenMaxChars?: number;
  /** How long after an action its effects count as its result. Defaults to 1000 ms. */
  resultWindowMs?: number;
  /** Report failed fetch / XHR requests. Defaults to true. */
  captureNetwork?: boolean;
  /** Actions kept locally while waiting for a question. Defaults to 100. */
  timelineLimit?: number;
  document?: Document;
}

export interface PerceptionSnapshot {
  page: PageInfo;
  timeline: TimelineEntry[];
  screen: string;
  errors: ActiveError[];
}

export interface Bridge {
  readonly sessionId: string;
  /** Sends the question along with everything recorded since the last one. */
  ask(question: string): Promise<void>;
  /** Stops the answer in progress. */
  cancel(): Promise<void>;
  setUser(user: BridgeUser): void;
  onOutput(listener: (output: AgentOutput) => void): () => void;
  /** What the next question would send (for debugging). */
  snapshot(): PerceptionSnapshot;
  destroy(): void;
}

function newSessionId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sessionStore(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // Blocked by privacy settings.
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  const document = options.document ?? globalThis.document;
  const storage = sessionStore();
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const errorSelectors = [...DEFAULT_ERROR_SELECTORS, ...(options.errorSelectors ?? [])];
  const timelineLimit = options.timelineLimit ?? 100;

  const sessionId = options.sessionId ?? storage?.getItem('doccue:session') ?? newSessionId();
  storage?.setItem('doccue:session', sessionId);
  const unsentKey = `doccue:unsent:${sessionId}`;

  // Actions not sent yet; kept in sessionStorage so a page reload doesn't lose them.
  let unsent: TimelineEntry[] = [];
  try {
    unsent = JSON.parse(storage?.getItem(unsentKey) ?? '[]') as TimelineEntry[];
  } catch {
    unsent = [];
  }
  const save = () => {
    try {
      storage?.setItem(unsentKey, JSON.stringify(unsent));
    } catch {
      // Storage full or blocked: keep them in memory only.
    }
  };

  let user = options.user;
  const client: Client = createClient({ endpoint, sessionId });
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
      save();
    },
    onPage: () => {},
  });

  const snapshot = (): PerceptionSnapshot => ({
    page: recorder.page(),
    timeline: [...unsent],
    screen: buildScreen(document, { errorSelectors, maxChars: options.screenMaxChars ?? 8000 }),
    errors: collectErrors(document, errorSelectors),
  });

  return {
    sessionId,
    async ask(question) {
      recorder.flush();
      const { page, timeline, screen, errors } = snapshot();
      const events: InputEvent[] = [];
      if (user) events.push({ type: 'user_info', ...user });
      events.push({ type: 'perception', page, screen, errors, ...(timeline.length > 0 ? { timeline } : {}) });
      events.push({ type: 'user_message', content: question });
      await client.post(events);
      // Sent: drop what went up (actions recorded while posting stay for next time).
      unsent = unsent.slice(timeline.length);
      save();
      user = undefined;
    },
    cancel: () => client.post([{ type: 'cancel' }]),
    setUser(next) {
      user = next;
    },
    onOutput: (listener) => client.subscribe(listener),
    snapshot,
    destroy() {
      recorder.stop();
      client.close();
    },
  };
}
