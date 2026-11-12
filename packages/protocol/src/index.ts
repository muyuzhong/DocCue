/**
 * The data the frontend (bridge) and the backend (core) exchange. Types only.
 *
 * The frontend reports structured, language-neutral data: roles and action types are fixed
 * English words, names and texts are kept as they appear on screen. Turning this into text for
 * the model is the backend's job.
 */

export const PROTOCOL_VERSION = 1;

// --- pointing at controls -----------------------------------------------------------------------

/** Where a control sits: a dialog, a table row or list item, or a titled section. */
export interface Region {
  kind: 'dialog' | 'row' | 'section';
  name: string;
}

/** A control described by role and name, the way a screen reader would announce it. */
export interface Locator {
  /** ARIA role: `button`, `textbox`, `link`, `combobox`, ... */
  role: string;
  /** The name shown on screen, as is. Empty when the control has none. */
  name: string;
  /** Regions around the control, outermost first. */
  within?: Region[];
  /** The host's `data-cue-id`, when present. An identity, not a name. */
  id?: string;
}

// --- what the frontend sees ---------------------------------------------------------------------

export interface PageInfo {
  path: string;
  title?: string;
}

export interface ScreenNode {
  /** Number the model uses to point at this node. Controls, headings and groups have one. */
  ref?: number;
  /**
   * Controls use ARIA roles. Others: `heading`, `dialog`, `form`, `group`, `navigation`,
   * `table`, `row`, `tablist`, `menu`, `text`, `alert` (an error message), `status` (a notice).
   */
  role: string;
  /** The name, or the text itself for `text`, `alert` and `status`. */
  name?: string;
  /** Current value of a field, or the chosen option. Never present for passwords. */
  value?: string;
  /** `disabled`, `checked`, `invalid`, `expanded`, `collapsed`, `current`, `password`, `filled`. */
  states?: string[];
  children?: ScreenNode[];
}

/** What is visible right now, as a tree. */
export interface Screen {
  page: PageInfo;
  nodes: ScreenNode[];
  /** Nodes left out because the snapshot hit its size cap. */
  truncated?: number;
}

export type ActionType = 'click' | 'input' | 'select' | 'check' | 'uncheck' | 'submit';

/** Something an action caused, or that happened on its own. */
export type Effect =
  | { type: 'error'; text: string; target?: Locator }
  | { type: 'notice'; text: string }
  | { type: 'dialog'; state: 'opened' | 'closed'; name: string }
  | { type: 'navigate'; page: PageInfo }
  | { type: 'request_failed'; method: string; path: string; status?: number; message?: string }
  | { type: 'script_error'; message: string };

/** One user action with what it caused. Without `action`: something the page did by itself. */
export interface TimelineEntry {
  /** Milliseconds since the epoch. */
  at: number;
  action?: {
    type: ActionType;
    target?: Locator;
    /** Final value of a field or the chosen option. Never present for passwords. */
    value?: string;
  };
  effects?: Effect[];
}

/** What the frontend uploads with a question or a guide result. */
export interface Perception {
  at: number;
  screen: Screen;
  /** Actions since the previous upload, oldest first. */
  actions: TimelineEntry[];
}

// --- guiding ------------------------------------------------------------------------------------

export interface GuideStep {
  /** A `ref` from the latest screen (what the model uses), or a locator (for prewritten tours). */
  target: number | Locator;
  /** Shown in the bubble next to the target. */
  text: string;
  /** What completes the step. `ack`: the user presses "next". Inferred from the role if absent. */
  expect?: 'click' | 'input' | 'select' | 'ack';
}

export interface GuideResult {
  /**
   * - `completed`: every step was done
   * - `deviated`: the user did something else and the current target is gone
   * - `not_found`: a step's target could not be found
   * - `interrupted`: the user asked a new question
   * - `exited`: the user closed the guide
   */
  outcome: 'completed' | 'deviated' | 'not_found' | 'interrupted' | 'exited';
  completedSteps: number;
  /** What the user did during the guide and the screen at its end. */
  perception: Perception;
}

// --- the conversation ---------------------------------------------------------------------------

/**
 * One entry of the conversation, which the frontend keeps and sends in full with every request.
 * `model` entries are opaque to the frontend: it stores them and sends them back unchanged.
 */
export type Item =
  | { type: 'user'; text: string; perception: Perception }
  | { type: 'model'; messages: unknown[] }
  | { type: 'guide_result'; callId: string; result: GuideResult };

/** Body of `POST {base}/turn`. */
export interface TurnRequest {
  v: number;
  conversation: Item[];
  /** The user's language, e.g. `zh-CN`. */
  locale?: string;
  /** Attributes the host app knows about the user, e.g. role or plan. */
  user?: Record<string, unknown>;
}

export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * - `completed`: the model gave its answer
 * - `max_steps`: stopped after too many model calls
 * - `max_tokens`: the answer was cut off by the token limit
 * - `refusal`: the provider declined
 * - `aborted` / `timeout`: the request was cancelled / took too long
 * - `error`: a model failure (see `error`)
 */
export type EndReason = 'completed' | 'max_steps' | 'max_tokens' | 'refusal' | 'aborted' | 'timeout' | 'error';

/** What `POST {base}/turn` streams back, one JSON object per server-sent event. */
export type StreamEvent =
  | { type: 'status'; state: 'thinking' | 'tool'; tool?: string }
  | { type: 'text'; delta: string }
  | { type: 'guide'; callId: string; steps: GuideStep[] }
  /** Always last. `item` is what to append to the conversation. */
  | { type: 'end'; reason: EndReason; item: Item; usage: Usage; error?: { message: string; code?: string } };
