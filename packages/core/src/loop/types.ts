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

/** What the loop needs from a tool. */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * Runs the tool on the backend. Throwing turns into an error result the model can read.
   * A tool without `execute` runs in the page: the turn stops there and hands the call over
   * (see `TurnEnd.pageCall`).
   */
  execute?(args: unknown, context: ToolContext): Promise<string | UserContent[]>;
  /** A check of the arguments beyond the schema's required keys. Returns what is wrong, if anything. */
  validate?(args: unknown): string | undefined;
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
 * - `page_tool`: the model called a tool that runs in the page (see `pageCall`)
 * - `max_steps`: stopped after `maxSteps` model calls
 * - `max_tokens`: the answer was cut off by the token limit
 * - `refusal`: the provider declined; the partial answer was discarded
 * - `aborted` / `timeout`: cancelled through `signal` / `timeoutMs`
 * - `error`: a model failure (see `error`)
 */
export type TurnEndReason = 'completed' | 'page_tool' | 'max_steps' | 'max_tokens' | 'refusal' | 'aborted' | 'timeout' | 'error';

export interface TurnEnd {
  type: 'turn_end';
  reason: TurnEndReason;
  /** Messages this turn added, in order. Append them to the stored history as they are. */
  messages: Message[];
  /** Summed over every model call in the turn. */
  usage: Usage;
  error?: Error;
  /** With `page_tool`: the call the frontend has to run. Its result comes with the next turn. */
  pageCall?: ToolCallPart;
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
