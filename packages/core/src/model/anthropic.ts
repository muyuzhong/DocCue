/**
 * Anthropic Messages API adapter (raw fetch + SSE, no SDK).
 *
 * Notes on the current API that this file follows:
 * - `anthropic-version: 2026-10-21`. That version rejects `temperature` / `top_p` / `top_k`, so
 *   the adapter never sends them.
 * - Thinking blocks (and any other block type we don't interpret) are kept as `raw` parts and
 *   sent back unchanged, in their original order. Current models bind them to the conversation,
 *   so callers must keep history append-only.
 * - With server-side fallback, a mid-stream switch is marked by a `fallback` block; before the
 *   last one only `text` blocks are echoed back.
 */
import { ModelError } from './errors.js';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  defaultFetch,
  isPlainObject,
  parseEventData,
  parseToolArgs,
  streamSSE,
  type FetchLike,
} from './http.js';
import type { SSEMessage } from './sse.js';
import type {
  AssistantContent,
  AssistantMessage,
  Message,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  StopReason,
  ToolSpec,
  UserContent,
} from './types.js';

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicOptions {
  /** Sent as `x-api-key`. */
  apiKey: string;
  /** Model ID, e.g. `claude-opus-5-5`. */
  model: string;
  /** Defaults to https://api.anthropic.com. Set it for a proxy or gateway. */
  baseURL?: string;
  /** `anthropic-version` header. Defaults to `2026-10-21`. */
  version?: string;
  /** Output cap for one model call, thinking included. Defaults to 64000. */
  maxTokens?: number;
  /** `output_config.effort`. Unset means the model's default (`medium` on claude-opus-5-5). */
  effort?: AnthropicEffort;
  /** Sent unchanged as the `thinking` field, e.g. `{ type: 'adaptive', display: 'summarized' }`. */
  thinking?: Record<string, unknown>;
  /** Extra `anthropic-beta` values. */
  betas?: string[];
  /**
   * Server-side refusal fallback (`fallbacks: "default"`): a request a safety classifier declines
   * is re-run on the model Anthropic recommends. Unset = on for claude-fable-5-1, claude-opus-5-5,
   * claude-opus-5 and claude-sonnet-5-5 on the official endpoint, off otherwise.
   */
  fallbacks?: 'default' | false;
  /** Automatic prompt caching (top-level `cache_control`). Unset = on for the official endpoint. */
  promptCache?: boolean;
  /** `eager_input_streaming` on tool definitions. Unset = on for the official endpoint. */
  eagerToolInput?: boolean;
  headers?: Record<string, string>;
  /** Merged into the request body last (overrides anything above). */
  extraBody?: Record<string, unknown>;
  /** Give up when no bytes arrive for this long (pings count). Defaults to 60 s; 0 disables. */
  idleTimeoutMs?: number;
  fetch?: FetchLike;
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const RETRYABLE_STREAM_ERRORS = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);

type Block = { type: string; [key: string]: unknown };
type WireMessage = { role: 'user' | 'assistant'; content: Block[] };

export function createAnthropic(options: AnthropicOptions): ModelAdapter {
  const baseURL = (options.baseURL ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const official = baseURL === ANTHROPIC_BASE_URL;
  const fallbacks = options.fallbacks ?? (official && FALLBACK_MODELS.has(options.model) ? 'default' : false);
  const promptCache = options.promptCache ?? official;
  const eagerToolInput = options.eagerToolInput ?? official;
  const fetchImpl = options.fetch ?? defaultFetch();

  const betas = new Set(options.betas ?? []);
  if (fallbacks) betas.add(FALLBACK_BETA);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': options.apiKey,
    'anthropic-version': options.version ?? ANTHROPIC_API_VERSION,
    ...(betas.size > 0 ? { 'anthropic-beta': [...betas].join(',') } : {}),
    ...options.headers,
  };

  function buildBody(request: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 64000,
      stream: true,
      messages: toAnthropicMessages(request.messages),
    };
    if (request.system) body.system = request.system;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => toAnthropicTool(tool, eagerToolInput));
    }
    if (options.thinking) body.thinking = options.thinking;
    if (options.effort) body.output_config = { effort: options.effort };
    if (fallbacks) body.fallbacks = fallbacks;
    if (promptCache) body.cache_control = { type: 'ephemeral' };
    return { ...body, ...options.extraBody };
  }

  return {
    provider: 'anthropic',
    model: options.model,
    async *stream(request) {
      yield* readStream(
        streamSSE({
          provider: 'anthropic',
          fetchImpl,
          url: `${baseURL}/v1/messages`,
          headers,
          body: buildBody(request),
          signal: request.signal,
          idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        }),
      );
    },
  };
}

function toAnthropicTool(tool: ToolSpec, eager: boolean): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(eager ? { eager_input_streaming: true } : {}),
  };
}

/** Converts neutral messages to Anthropic's shape: tool results become user turns, and
 * consecutive turns of the same role are merged (tool results first, then any text). */
export function toAnthropicMessages(messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        push('user', userBlocks(message.content));
        break;
      case 'tool':
        push(
          'user',
          message.results.map((result) => ({
            type: 'tool_result',
            tool_use_id: result.callId,
            content: typeof result.content === 'string' ? result.content : userBlocks(result.content),
            ...(result.isError ? { is_error: true } : {}),
          })),
        );
        break;
      case 'assistant':
        push('assistant', assistantBlocks(message.content));
        break;
    }
  }
  return out;
}

function userBlocks(content: string | readonly UserContent[]): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks: Block[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } });
    }
  }
  return blocks;
}

function assistantBlocks(content: readonly AssistantContent[]): Block[] {
  const blocks: Block[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'tool_call') {
      blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: isPlainObject(part.args) ? part.args : {} });
    } else if (part.provider === 'anthropic') {
      blocks.push(part.block as Block);
    }
  }
  return blocks;
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function readUsage(target: RawUsage, usage: unknown): void {
  if (!isPlainObject(usage)) return;
  if (typeof usage.input_tokens === 'number') target.input = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') target.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') target.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') target.cacheWrite = usage.cache_creation_input_tokens;
}

async function* readStream(messages: AsyncIterable<SSEMessage>): AsyncGenerator<ModelEvent> {
  const blocks: (Block | undefined)[] = [];
  const toolJson = new Map<number, string>();
  const usage: RawUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let stopReason: string | null = null;
  let stopDetails: unknown;
  let servedBy: string | undefined;
  let finished = false;

  for await (const sse of messages) {
    if (!sse.data) continue;
    const event = parseEventData('anthropic', sse.data);
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start': {
        const message = isPlainObject(event.message) ? event.message : {};
        if (typeof message.model === 'string') servedBy = message.model;
        readUsage(usage, message.usage);
        break;
      }
      case 'content_block_start': {
        if (index < 0 || !isPlainObject(event.content_block)) break;
        const block = { ...event.content_block } as Block;
        blocks[index] = block;
        if (block.type === 'tool_use') toolJson.set(index, '');
        break;
      }
      case 'content_block_delta': {
        const block = blocks[index];
        const delta = isPlainObject(event.delta) ? event.delta : {};
        if (!block) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = String(block.text ?? '') + delta.text;
          if (delta.text) yield { type: 'text', delta: delta.text };
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          block.thinking = String(block.thinking ?? '') + delta.thinking;
          if (delta.thinking) yield { type: 'reasoning', delta: delta.thinking };
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          block.signature = String(block.signature ?? '') + delta.signature;
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          toolJson.set(index, (toolJson.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'citations_delta') {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
        }
        break;
      }
      case 'message_delta': {
        const delta = isPlainObject(event.delta) ? event.delta : {};
        if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
        stopDetails = delta.stop_details ?? event.stop_details ?? stopDetails;
        readUsage(usage, event.usage);
        break;
      }
      case 'message_stop':
        finished = true;
        break;
      case 'error': {
        const error = isPlainObject(event.error) ? event.error : {};
        const type = typeof error.type === 'string' ? error.type : 'error';
        const message = typeof error.message === 'string' ? error.message : 'stream error';
        throw new ModelError(`anthropic: ${type}: ${message}`, {
          provider: 'anthropic',
          code: type,
          retryable: RETRYABLE_STREAM_ERRORS.has(type),
        });
      }
      default:
        // `ping`, `content_block_stop` and event types added later need no handling.
        break;
    }
  }

  if (!finished) {
    throw new ModelError('anthropic: stream ended before message_stop', { provider: 'anthropic', retryable: true });
  }
  yield {
    type: 'done',
    message: assemble(blocks, toolJson),
    stopReason: mapStopReason(stopReason),
    rawStopReason: stopReason,
    usage: {
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    },
    ...(servedBy === undefined ? {} : { servedBy }),
    ...(stopDetails === undefined || stopDetails === null ? {} : { stopDetails }),
  };
}

function assemble(blocks: readonly (Block | undefined)[], toolJson: ReadonlyMap<number, string>): AssistantMessage {
  let boundary = -1;
  blocks.forEach((block, index) => {
    if (block?.type === 'fallback') boundary = index;
  });
  const content: AssistantContent[] = [];
  blocks.forEach((block, index) => {
    if (!block || block.type === 'fallback') return;
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (text) content.push({ type: 'text', text });
      return;
    }
    // Before a mid-stream fallback switch, only the declined attempt's text carries over.
    if (index < boundary) return;
    if (block.type === 'tool_use') {
      const rawArgs = toolJson.get(index) || JSON.stringify(block.input ?? {});
      content.push({
        type: 'tool_call',
        id: String(block.id),
        name: String(block.name),
        args: parseToolArgs(rawArgs),
        rawArgs,
      });
      return;
    }
    content.push({ type: 'raw', provider: 'anthropic', block });
  });
  return { role: 'assistant', content };
}
