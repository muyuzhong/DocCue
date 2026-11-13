/**
 * The bridge: drop it into a page and it records what the user does. The record stays in the
 * browser until the user asks something; then it goes up with the screen snapshot and the
 * question.
 *
 * The bridge keeps the conversation (in sessionStorage, one per tab) and sends it in full with
 * every request: the backend keeps nothing between requests. When the answer is a guide, the
 * bridge runs it on the page and sends what the user did as the next request, until the model
 * has nothing more to show.
 */
import {
  PROTOCOL_VERSION,
  type GuideStep,
  type Item,
  type Locator,
  type Perception,
  type StreamEvent,
  type TimelineEntry,
  type TurnRequest,
} from '@doccue/protocol';
import { isVisible } from './dom.js';
import { DEFAULT_ERROR_SELECTORS } from './errors.js';
import { runGuide, type GuideEnd, type RunningGuide } from './guide.js';
import { describeElement, findByLocator } from './locate.js';
import { messagesFor } from './messages.js';
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
  /** How long a guide waits for the element of a step before giving up. Defaults to 3000 ms. */
  targetWaitMs?: number;
  /** Guides in a row for one question. Defaults to 20. */
  maxGuides?: number;
  /** Report failed fetch / XHR requests. Defaults to true. */
  captureNetwork?: boolean;
  /** Actions kept locally while waiting for a question. Defaults to 100. */
  timelineLimit?: number;
  document?: Document;
}

/** What the bridge reports: the answer's stream, plus the end of a guide it ran. */
export type BridgeEvent = StreamEvent | ({ type: 'guide_end' } & GuideEnd);

type Listener<T extends BridgeEvent['type']> = (event: Extract<BridgeEvent, { type: T }>) => void;

export interface Bridge {
  /**
   * Sends the question with everything recorded since the last one. Resolves when the exchange
   * is over: the answer ended, including any guides it led to.
   */
  ask(question: string): Promise<void>;
  /** Stops the answer in progress and closes the guide on screen. */
  stop(): void;
  /** Starts a new conversation. */
  reset(): void;
  /** Listens to one kind of event. Returns the unsubscribe function. */
  on<T extends BridgeEvent['type']>(type: T, listener: Listener<T>): () => void;
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
/** Call ID of a guide that has no result in the conversation yet. */
const GUIDE_KEY = 'doccue:guide';

function sessionStore(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined; // Blocked by privacy settings.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const resultWindowMs = options.resultWindowMs ?? 1000;
  const locale = options.locale ?? (document.documentElement.lang || globalThis.navigator?.language);

  const load = <T>(key: string, fallback: T): T => {
    try {
      const raw = storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key: string, value: unknown) => {
    try {
      if (value === undefined) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: keep it in memory only.
    }
  };

  // These survive a page reload.
  let items = load<Item[]>(CONVERSATION_KEY, []);
  let unsent = load<TimelineEntry[]>(UNSENT_KEY, []);
  /** A guide that was on screen when the page was reloaded: it still needs a result. */
  let orphan = load<string | undefined>(GUIDE_KEY, undefined);

  let running: AbortController | undefined;
  let guide: { callId: string; run: RunningGuide } | undefined;
  /** The elements behind the numbers of the screen sent last. */
  let elements = new Map<number, Element>();
  const listeners = new Map<string, Set<(event: BridgeEvent) => void>>();

  const recorder = createRecorder({
    document,
    errorSelectors,
    resultWindowMs,
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
    onAction: (element) => guide?.run.action(element),
  });

  const emit = (event: BridgeEvent) => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
  };

  const snapshot = () => buildScreen(document, { errorSelectors, ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }) });

  /** The perception to send now: takes the unsent actions and remembers the screen's elements. */
  const takePerception = (): Perception => {
    recorder.flush();
    const { screen, elements: found } = snapshot();
    elements = found;
    const perception = { at: Date.now(), screen, actions: unsent };
    unsent = [];
    save(UNSENT_KEY, unsent);
    return perception;
  };

  const push = (item: Item) => {
    items.push(item);
    save(CONVERSATION_KEY, items);
  };

  /** Writes the result of a guide into the conversation. */
  const pushResult = (callId: string, end: GuideEnd) => {
    push({ type: 'guide_result', callId, result: { ...end, perception: takePerception() } });
    save(GUIDE_KEY, undefined);
    emit({ type: 'guide_end', ...end });
  };

  /** Ends the guide on screen (or the one a reload left behind) with the given outcome. */
  const closeGuide = (outcome: 'interrupted' | 'exited') => {
    if (guide) {
      const { callId, run } = guide;
      guide = undefined;
      pushResult(callId, { outcome, ...run.stop() });
    } else if (orphan) {
      pushResult(orphan, { outcome: 'exited', completedSteps: 0 });
    }
    orphan = undefined;
  };

  /** One request: sends the conversation, reports the answer, keeps what the model added. */
  async function send(signal: AbortSignal): Promise<{ callId: string; steps: GuideStep[] } | undefined> {
    const request: TurnRequest = {
      v: PROTOCOL_VERSION,
      conversation: items,
      ...(locale ? { locale } : {}),
      ...(options.user ? { user: options.user } : {}),
    };
    const response = await fetch(`${endpoint}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { errors?: string[] };
      throw new Error(`DocCue ${response.status}: ${(body.errors ?? []).join('; ') || response.statusText}`);
    }
    let started: { callId: string; steps: GuideStep[] } | undefined;
    for await (const event of readEvents(response.body)) {
      if (event.type === 'guide') started = { callId: event.callId, steps: event.steps };
      if (event.type === 'end') {
        if (event.item.type === 'model' && event.item.messages.length > 0) push(event.item);
        if (event.reason !== 'guide') started = undefined;
      }
      emit(event);
    }
    return started;
  }

  /** Shows a guide and waits for its end. Returns whether the model should hear about it right away. */
  async function showGuide({ callId, steps }: { callId: string; steps: GuideStep[] }): Promise<boolean> {
    // Numbers become elements now, with a locator to find them again after a re-render.
    const targets = steps.map((step): { element?: Element; locator?: Locator } => {
      if (typeof step.target !== 'number') return { locator: step.target };
      const element = elements.get(step.target);
      const locator = element && describeElement(element);
      return { ...(element ? { element } : {}), ...(locator ? { locator } : {}) };
    });
    const run = runGuide({
      document,
      steps,
      messages: messagesFor(locale),
      waitMs: options.targetWaitMs ?? 3000,
      find: (index) => {
        const target = targets[index]!;
        if (target.element?.isConnected && isVisible(target.element)) return target.element;
        const found = target.locator && findByLocator(document, target.locator);
        if (found) target.element = found;
        return found;
      },
    });
    guide = { callId, run };
    save(GUIDE_KEY, callId);

    const end = await run.done;
    // Stopped from outside (a new question, stop, reset): whoever did it wrote the result.
    if (!end || guide?.run !== run) return false;
    // Let the last action's effects arrive before looking at the screen.
    if (end.outcome === 'completed') await sleep(resultWindowMs);
    if (guide?.run !== run) return false;
    guide = undefined;
    pushResult(callId, end);
    return end.outcome !== 'exited';
  }

  /** Requests and guides in turn, until the model answers without a guide. */
  async function exchange(controller: AbortController): Promise<void> {
    try {
      for (let guides = 0; ; guides++) {
        const started = await send(controller.signal);
        if (!started || guides >= (options.maxGuides ?? 20)) {
          if (started) pushResult(started.callId, { outcome: 'exited', completedSteps: 0 });
          return;
        }
        if (!(await showGuide(started)) || controller.signal.aborted) return;
      }
    } catch (error) {
      // Stopped on purpose: nothing to report.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (running === controller) running = undefined;
    }
  }

  return {
    async ask(question) {
      // A new question replaces the answer in progress and interrupts the guide on screen.
      running?.abort();
      closeGuide('interrupted');
      const controller = (running = new AbortController());
      push({ type: 'user', text: question, perception: takePerception() });
      await exchange(controller);
    },
    stop() {
      running?.abort();
      closeGuide('exited');
    },
    reset() {
      running?.abort();
      guide?.run.stop();
      guide = undefined;
      orphan = undefined;
      items = [];
      save(CONVERSATION_KEY, items);
      save(GUIDE_KEY, undefined);
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(listener as (event: BridgeEvent) => void);
      return () => set.delete(listener as (event: BridgeEvent) => void);
    },
    recorded: () => [...unsent],
    perceive: () => ({ at: Date.now(), screen: snapshot().screen, actions: [...unsent] }),
    conversation: () => [...items],
    destroy() {
      running?.abort();
      guide?.run.stop();
      recorder.stop();
      listeners.clear();
    },
  };
}
