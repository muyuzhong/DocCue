import type { BeforeModelCallContext } from '../loop/types.js';
import type { Message } from '../model/types.js';
import type { SessionState } from '../state/types.js';

/** Why a turn starts, as decided by a trigger. */
export interface TurnRequest {
  /** e.g. `user_message`. */
  reason: string;
  /** For turns the user didn't ask for: why the agent speaks up, shown to the model. */
  note?: string;
}

export interface PrepareInput {
  /** The session as it was when the turn started. */
  session: SessionState;
  request: TurnRequest;
  /** Reads the latest state, e.g. to refresh the status bar before a later model call. */
  getSession(): Promise<SessionState>;
}

/** What the loop gets for one turn. */
export interface PreparedTurn {
  /** Keep it the same for the whole conversation. */
  system?: string;
  /** Must start with the session history unchanged: the transcript is append-only. */
  messages: readonly Message[];
  /** Messages to append before each model call (e.g. a status bar refresh). */
  beforeModelCall?: (context: BeforeModelCallContext) => Message[] | void | Promise<Message[] | void>;
}

/** Turns session state into what the model sees. */
export interface ContextBuilder {
  prepare(input: PrepareInput): PreparedTurn | Promise<PreparedTurn>;
}
