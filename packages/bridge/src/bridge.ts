/**
 * The bridge: drop it into a page and it records what the user does. The record stays in the
 * browser until the user asks something; then it goes up with the screen snapshot and the
 * question.
 *
 * The bridge keeps the conversation (in sessionStorage, one per tab) and sends it in full with
 * every request: the backend keeps nothing between requests. When the answer is a guide, the
 * bridge runs it on the page and sends what the user did as the next request, until the model
 * has nothing more to show. A guide in progress and an answer still owed survive a full page
 * load: the bridge on the new page picks them up.
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
import { whenSettled } from './settle.js';

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
  /**
   * After a guide, the screen is looked at once the page has settled: no request of the page on
   * its way and no DOM change for `quietMs` (default 300), waiting `maxMs` at most (default 4000).
   */
  settle?: { quietMs?: number; maxMs?: number };
  /** Guides in a row for one question. Defaults to 20. */
  maxGuides?: number;
  /** Report failed fetch / XHR requests. Defaults to true. */
  captureNetwork?: boolean;
  /** Actions kept locally while waiting for a question. Defaults to 100. */
  timelineLimit?: number;
  document?: Document;
}

/**
 * What the bridge reports: the answer's stream, the end of a guide it ran, and `state` whenever
 * it starts or stops working on a question (an answer on its way or a guide on screen).
 */
export type BridgeEvent = StreamEvent | ({ type: 'guide_end' } & GuideEnd) | { type: 'state'; busy: boolean };

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
  /** Whether an answer is on its way or a guide is on screen. */
  busy(): boolean;
  /** Actions recorded locally and not sent yet. */
  recorded(): TimelineEntry[];
  /** What the next question would send. */
  perceive(): Perception;
  /** The conversation so far, as sent with every request. */
  conversation(): Item[];
  destroy(): void;
}

/** A guide the model started: its steps, where each one points, and how far the user got. */
interface GuideState {
  callId: string;
  steps: GuideStep[];
  /** Per step: the locator to find its element (again). Elements themselves don't survive a reload. */
  locators: Array<Locator | undefined>;
  completedSteps: number;
  skippedSteps?: number[];
}

const CONVERSATION_KEY = 'doccue:conversation';
const UNSENT_KEY = 'doccue:unsent';
/** The guide on screen (a `GuideState`), until its result is in the conversation. */
const GUIDE_KEY = 'doccue:guide';
/** Set while a question is being worked on, so a new page knows an answer is still owed. */
const ACTIVE_KEY = 'doccue:active';

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
  const settle = { quietMs: options.settle?.quietMs ?? 300, maxMs: options.settle?.maxMs ?? 4000 };

  const load = <T>(key: string, fallback: T): T => {
    try {
      const raw = storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key: string, value: unknown) => {
    if (destroyed) return;
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
  const interrupted = load<GuideState | undefined>(GUIDE_KEY, undefined);
  /** The guide on screen (`run` is set), or one a page load interrupted that is about to be resumed. */
  let guide: { state: GuideState; run?: RunningGuide } | undefined = interrupted ? { state: interrupted } : undefined;
  /** After `destroy`, nothing more is written: what is in storage is for the next page. */
  let destroyed = false;

  let running: AbortController | undefined;
  /** The elements behind the numbers of the screen sent last. */
  let elements = new Map<number, Element>();
  const listeners = new Map<string, Set<(event: BridgeEvent) => void>>();

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
    onAction: (element) => guide?.run?.action(element),
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

  const progressOf = (state: GuideState): Omit<GuideEnd, 'outcome'> => ({
    completedSteps: state.completedSteps,
    ...(state.skippedSteps && state.skippedSteps.length > 0 ? { skippedSteps: state.skippedSteps } : {}),
  });

  /** Writes the result of the guide into the conversation; the guide is over. */
  const pushResult = (callId: string, end: GuideEnd) => {
    guide = undefined;
    save(GUIDE_KEY, undefined);
    push({ type: 'guide_result', callId, result: { ...end, perception: takePerception() } });
    emit({ type: 'guide_end', ...end });
  };

  /** Ends the guide, on screen or waiting to be resumed, with the given outcome. */
  const closeGuide = (outcome: 'interrupted' | 'exited') => {
    if (!guide) return;
    const { state, run } = guide;
    pushResult(state.callId, { outcome, ...(run ? run.stop() : progressOf(state)) });
  };

  /** One request: sends the conversation, reports the answer, keeps what the model added. */
  async function send(signal: AbortSignal): Promise<GuideState | undefined> {
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
    let started: GuideState | undefined;
    for await (const event of readEvents(response.body)) {
      if (event.type === 'guide') {
        // Numbers become locators now, while the elements they stand for are known.
        const locators = event.steps.map((step) => {
          if (typeof step.target !== 'number') return step.target;
          const element = elements.get(step.target);
          return element && describeElement(element);
        });
        started = { callId: event.callId, steps: event.steps, locators, completedSteps: 0 };
      }
      if (event.type === 'end') {
        if (event.item.type === 'model' && event.item.messages.length > 0) push(event.item);
        if (event.reason !== 'guide') started = undefined;
      }
      emit(event);
    }
    return started;
  }

  /** Shows a guide and waits for its end. Returns whether the model should hear about it right away. */
  async function showGuide(state: GuideState): Promise<boolean> {
    // The elements the numbers stood for, as long as they are still on the page.
    const known = state.steps.map((step) => (typeof step.target === 'number' ? elements.get(step.target) : undefined));
    const shown: NonNullable<typeof guide> = (guide = { state });
    save(GUIDE_KEY, state);

    let end: GuideEnd | undefined = { outcome: 'completed', ...progressOf(state) };
    // Otherwise the page was reloaded right after the last step: nothing left to show.
    if (state.completedSteps < state.steps.length) {
      const run = runGuide({
        document,
        steps: state.steps,
        messages: messagesFor(locale),
        waitMs: options.targetWaitMs ?? 3000,
        start: progressOf(state),
        onProgress: (progress) => {
          state.completedSteps = progress.completedSteps;
          if (progress.skippedSteps) state.skippedSteps = progress.skippedSteps;
          if (guide === shown) save(GUIDE_KEY, state);
        },
        find: (index) => {
          const element = known[index];
          if (element?.isConnected && isVisible(element)) return element;
          const locator = state.locators[index];
          const found = locator && findByLocator(document, locator);
          if (found) known[index] = found;
          return found;
        },
      });
      shown.run = run;
      end = await run.done;
    }
    // Stopped from outside (a new question, stop, reset): whoever did it wrote the result.
    if (!end || guide !== shown) return false;
    // Look at the screen once the last action has had its effect.
    if (end.outcome !== 'exited') await whenSettled(document, recorder.busy, settle);
    if (guide !== shown || destroyed) return false;
    pushResult(state.callId, end);
    return end.outcome !== 'exited';
  }

  /**
   * Works on a question until the model answers without a guide: requests and guides in turn.
   * With `resume`, it starts from a guide a page load interrupted.
   */
  async function exchange(controller: AbortController, resume?: GuideState): Promise<void> {
    save(ACTIVE_KEY, true);
    emit({ type: 'state', busy: true });
    try {
      let next = resume;
      for (let guides = 0; ; guides++) {
        if (!next) {
          next = await send(controller.signal);
          if (!next) return;
          if (guides >= (options.maxGuides ?? 20)) {
            pushResult(next.callId, { outcome: 'exited', completedSteps: 0 });
            return;
          }
        }
        const state = next;
        next = undefined;
        if (!(await showGuide(state)) || controller.signal.aborted) return;
      }
    } catch (error) {
      // Stopped on purpose: nothing to report.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (running === controller) finished();
    }
  }

  /** The question is done with: answered, stopped or failed. */
  function finished(): void {
    running = undefined;
    save(ACTIVE_KEY, undefined);
    emit({ type: 'state', busy: false });
  }

  // A full page load in the middle of things: continue the guide, or get the answer still owed.
  const owed = load<boolean>(ACTIVE_KEY, false) && items.length > 0 && items[items.length - 1]!.type !== 'model';
  if (guide || owed) {
    const controller = (running = new AbortController());
    const resume = () => {
      if (running !== controller || controller.signal.aborted) return;
      void exchange(controller, guide?.state).catch(() => {});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume, { once: true });
    else setTimeout(resume, 0);
  } else {
    save(ACTIVE_KEY, undefined);
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
      if (running) finished();
    },
    reset() {
      running?.abort();
      guide?.run?.stop();
      guide = undefined;
      items = [];
      save(CONVERSATION_KEY, items);
      save(GUIDE_KEY, undefined);
      if (running) finished();
    },
    on(type, listener) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      set.add(listener as (event: BridgeEvent) => void);
      return () => set.delete(listener as (event: BridgeEvent) => void);
    },
    busy: () => running !== undefined,
    recorded: () => [...unsent],
    perceive: () => ({ at: Date.now(), screen: snapshot().screen, actions: [...unsent] }),
    conversation: () => [...items],
    destroy() {
      // Like the page going away: what is in storage stays for the next page.
      recorder.stop();
      destroyed = true;
      listeners.clear();
      running?.abort();
      guide?.run?.stop();
    },
  };
}
