import type {
  JsonSchema,
  Message,
  ModelAdapter,
  StopReason,
  ToolCallPart,
  ToolResult,
  Usage,
  UserContent,
} from '../model/types.js';

export interface ToolContext {
  callId: string;
  /** Aborts when the turn is cancelled or times out. */
  signal: AbortSignal;
}

/**
 * What the loop needs from a tool. The tools layer implements this; the loop only calls it.
 * Throwing from `execute` turns into an error result the model can read.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: unknown, context: ToolContext): Promise<string | UserContent[]>;
}

export interface BeforeModelCallContext {
  step: number;
  /** Everything the next model call will see, oldest first. */
  transcript: readonly Message[];
}

export interface TurnOptions {
  model: ModelAdapter;
  /** Fixed for the whole conversation: changing it between calls breaks caching and thinking replay. */
  system?: string;
  /** The conversation so far, ending with the new user input. Not modified. */
  messages: readonly Message[];
  tools?: readonly Tool[];
  /** Model calls allowed in this turn. Defaults to 10. */
  maxSteps?: number;
  /** Time limit for the whole turn. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Runs before every model call. Messages it returns are appended to the transcript, never
   * inserted earlier: this is where a status bar refresh or a message the user sent mid-turn goes.
   */
  beforeModelCall?: (context: BeforeModelCallContext) => Message[] | void | Promise<Message[] | void>;
}

/**
 * - `completed`: the model gave its answer
 * - `max_steps`: stopped after `maxSteps` model calls
 * - `max_tokens`: the answer was cut off by the token limit
 * - `refusal`: the provider declined; the partial answer was discarded
 * - `aborted` / `timeout`: cancelled through `signal` / `timeoutMs`
 * - `error`: a model failure (see `error`)
 */
export type TurnEndReason = 'completed' | 'max_steps' | 'max_tokens' | 'refusal' | 'aborted' | 'timeout' | 'error';

export interface TurnEnd {
  type: 'turn_end';
  reason: TurnEndReason;
  /** Messages this turn added, in order. Append them to the stored history as they are. */
  messages: Message[];
  /** Summed over every model call in the turn. */
  usage: Usage;
  error?: Error;
  /** Provider details on a refusal. */
  stopDetails?: unknown;
}

export type LoopEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCallPart }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'step_end'; step: number; stopReason: StopReason; usage: Usage; servedBy?: string }
  | TurnEnd;
