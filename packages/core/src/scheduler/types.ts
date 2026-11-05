import type { ContextBuilder, TurnRequest } from '../context/types.js';
import type { Logger } from '../log/log.js';
import type { Tool, TurnEndReason } from '../loop/types.js';
import type { ModelAdapter, Usage } from '../model/types.js';
import type { ReducerOptions } from '../state/reducer.js';
import type { SessionStore } from '../state/store.js';
import type { PerceptionEvent, SessionState, UserInfoEvent, UserMessageEvent } from '../state/types.js';

/** Stops the running turn of the session. */
export interface CancelEvent {
  type: 'cancel';
}

/** Everything that can come into a session. */
export type InputEvent = UserMessageEvent | PerceptionEvent | UserInfoEvent | CancelEvent;

/**
 * Decides whether an event starts a turn. Checked after the event was applied, and only while no
 * turn is running (a running turn is never interrupted by a trigger).
 */
export interface Trigger {
  name: string;
  check(event: InputEvent, session: SessionState): TurnRequest | undefined;
}

/** Everything that comes out of a session. */
export type AgentOutput =
  | { type: 'turn_start'; turnId: string; reason: string }
  | { type: 'status'; turnId: string; state: 'thinking' | 'tool'; tool?: string }
  | { type: 'text'; turnId: string; delta: string }
  | { type: 'reasoning'; turnId: string; delta: string }
  | { type: 'turn_end'; turnId: string; reason: TurnEndReason; usage: Usage; error?: { message: string; code?: string } }
  /** Something went wrong outside a turn, e.g. the store failed while applying an event. */
  | { type: 'error'; message: string };

export type OutputListener = (output: AgentOutput) => void;

export interface SchedulerOptions {
  model: ModelAdapter;
  context: ContextBuilder;
  /** Defaults to an in-memory store. */
  store?: SessionStore;
  /** Defaults to `[answerQuestions]`. */
  triggers?: readonly Trigger[];
  tools?: readonly Tool[];
  /** Model calls per turn. Defaults to 10. */
  maxSteps?: number;
  /** Time limit per turn. */
  turnTimeoutMs?: number;
  reducer?: ReducerOptions;
  /** Sees every session's output. */
  onOutput?: (sessionId: string, output: AgentOutput) => void;
  /** Records events, turns and every model call with exactly what was sent (see log/). */
  logger?: Logger;
}

export interface Scheduler {
  /**
   * Queues an event for a session (created on first use). Resolves once the event has been
   * applied, not when a turn it starts has finished.
   */
  push(sessionId: string, event: InputEvent): Promise<void>;
  /** Listens to one session's output. Returns the unsubscribe function. */
  subscribe(sessionId: string, listener: OutputListener): () => void;
  /** Resolves when the session has no queued events and no running turn. */
  idle(sessionId: string): Promise<void>;
  getSession(sessionId: string): Promise<SessionState | undefined>;
}
