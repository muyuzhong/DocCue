/**
 * Session state: what the agent knows about one conversation. It changes only through
 * `StateEvent`s (see reducer.ts); every other layer reads it.
 */
import type { Message, UserContent } from '../model/types.js';

/** One user action as reported by the bridge, e.g. a click and what it caused. */
export interface TimelineEntry {
  /** Milliseconds since the epoch. */
  at: number;
  /** What happened: `click`, `input`, `navigate`, `submit`, `dialog`, `error`, ... */
  kind: string;
  /** The control, named for humans, e.g. `按钮「测试连接」`. */
  target?: string;
  /** Final value for inputs and selections. */
  value?: string;
  /** What the action caused, e.g. `出现报错「Invalid Host Format」`. */
  result?: string;
  /** The page it happened on. */
  page?: string;
  /** Number of identical consecutive actions folded into this entry. */
  repeat?: number;
}

export interface PageInfo {
  path: string;
  title?: string;
}

export interface ActiveError {
  text: string;
  /** The control it belongs to, if known. */
  target?: string;
  source?: 'page' | 'js' | 'network';
}

export interface ScreenSnapshot {
  /** The compact screen tree, as text. */
  text: string;
  at: number;
}

export interface ActiveTour {
  id: string;
  step: number;
  total?: number;
}

export interface PerceptionState {
  /** Most recent user actions, oldest first, capped (see `ReducerOptions.timelineLimit`). */
  timeline: TimelineEntry[];
  page?: PageInfo;
  screen?: ScreenSnapshot;
  /** Errors currently visible. */
  errors: ActiveError[];
}

export interface UserState {
  /** Attributes the host app passed in, e.g. role or plan. */
  attributes: Record<string, unknown>;
  completedTours: string[];
  activeTour?: ActiveTour;
}

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  /**
   * The conversation exactly as sent to the model, oldest first. Append-only: editing an earlier
   * message breaks prompt caching and replayed thinking blocks.
   */
  history: Message[];
  perception: PerceptionState;
  user: UserState;
}

/** The user asked something. */
export interface UserMessageEvent {
  type: 'user_message';
  content: string | UserContent[];
}

/** New perception data. Timeline entries are appended; the other fields replace what was there. */
export interface PerceptionEvent {
  type: 'perception';
  timeline?: TimelineEntry[];
  page?: PageInfo;
  /** The current screen tree, as text. */
  screen?: string;
  errors?: ActiveError[];
}

/** Host-provided user details. Attributes are merged, completed tours added; `activeTour: null` clears it. */
export interface UserInfoEvent {
  type: 'user_info';
  attributes?: Record<string, unknown>;
  completedTours?: string[];
  activeTour?: ActiveTour | null;
}

/** Messages a finished turn added. Internal: produced by the scheduler. */
export interface TurnMessagesEvent {
  type: 'turn_messages';
  messages: Message[];
}

export type StateEvent = UserMessageEvent | PerceptionEvent | UserInfoEvent | TurnMessagesEvent;
