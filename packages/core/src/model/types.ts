/**
 * Provider-neutral message and event types shared by every model adapter.
 * The agent loop only speaks these types; each adapter translates them to its wire format.
 */

/** JSON Schema object describing a tool's parameters. */
export type JsonSchema = Record<string, unknown>;

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** e.g. `image/png`, `image/jpeg`. */
  mediaType: string;
  /** Base64 data, without a `data:` prefix. */
  data: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  /** Parsed arguments, or `undefined` when the model's JSON could not be parsed (see `rawArgs`). */
  args: unknown;
  /** Arguments exactly as the model produced them. */
  rawArgs: string;
}

/**
 * A provider-specific block (for example an Anthropic `thinking` block) that has to be sent back
 * unchanged on later requests to the same provider. Other providers skip it.
 */
export interface RawPart {
  type: 'raw';
  provider: string;
  block: unknown;
}

export type UserContent = TextPart | ImagePart;
export type AssistantContent = TextPart | ToolCallPart | RawPart;

export interface UserMessage {
  role: 'user';
  content: string | UserContent[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantContent[];
}

export interface ToolResult {
  callId: string;
  content: string | UserContent[];
  isError?: boolean;
}

/** Results for the tool calls of the assistant message right before it. */
export interface ToolMessage {
  role: 'tool';
  results: ToolResult[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelRequest {
  system?: string;
  messages: readonly Message[];
  tools?: readonly ToolSpec[];
  signal?: AbortSignal;
}

/**
 * - `end`: the model finished its answer
 * - `tool_use`: the model wants tool results before continuing
 * - `max_tokens`: output was cut off by the token limit
 * - `refusal`: the provider declined the request (partial output should be discarded)
 * - `other`: anything else (see `rawStopReason`)
 */
export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` read from the prompt cache. */
  cacheReadTokens: number;
  /** Part of `inputTokens` written to the prompt cache. */
  cacheWriteTokens: number;
}

export interface ModelDone {
  type: 'done';
  message: AssistantMessage;
  stopReason: StopReason;
  rawStopReason: string | null;
  usage: Usage;
  /** The model that actually produced the message (can differ after a server-side fallback). */
  servedBy?: string;
  /** Provider details about the stop, e.g. Anthropic `stop_details` on a refusal. */
  stopDetails?: unknown;
}

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | ModelDone;

/**
 * One model behind one API. `stream` yields text as it arrives and ends with exactly one `done`
 * event. Failures are thrown: `ModelError` for API and network problems, an `AbortError` when
 * `request.signal` aborts.
 */
export interface ModelAdapter {
  readonly provider: string;
  readonly model: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: Usage, more: Usage): void {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadTokens += more.cacheReadTokens;
  total.cacheWriteTokens += more.cacheWriteTokens;
}
