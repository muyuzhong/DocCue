/**
 * OpenAI Chat Completions adapter (raw fetch + SSE). Also covers OpenAI-compatible servers:
 * Ollama, vLLM, LM Studio, and hosted services that expose `/chat/completions`.
 */
import { ModelError } from './errors.js';
import {
  defaultFetch,
  isPlainObject,
  parseEventData,
  parseToolArgs,
  postForStream,
  sseEvents,
  type FetchLike,
} from './http.js';
import {
  emptyUsage,
  type AssistantContent,
  type Message,
  type ModelAdapter,
  type ModelEvent,
  type StopReason,
  type Usage,
  type UserContent,
} from './types.js';

export interface OpenAIOptions {
  /** Sent as `Authorization: Bearer`. Optional for local servers. */
  apiKey?: string;
  model: string;
  /**
   * Defaults to https://api.openai.com/v1. Local examples: http://localhost:11434/v1 (Ollama),
   * http://localhost:8000/v1 (vLLM), http://localhost:1234/v1 (LM Studio).
   */
  baseURL?: string;
  /** Output cap for one model call. Unset = the server's default. */
  maxTokens?: number;
  /** Field that carries `maxTokens`. Unset = `max_completion_tokens` on api.openai.com, `max_tokens` elsewhere. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Ask for a usage chunk at the end of the stream (`stream_options.include_usage`). Defaults to true. */
  includeUsage?: boolean;
  headers?: Record<string, string>;
  /** Merged into the request body last, e.g. `{ temperature: 0.2 }` or `{ reasoning_effort: 'low' }`. */
  extraBody?: Record<string, unknown>;
  fetch?: FetchLike;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

type WireMessage = Record<string, unknown>;

export function createOpenAI(options: OpenAIOptions): ModelAdapter {
  const baseURL = (options.baseURL ?? OPENAI_BASE_URL).replace(/\/+$/, '');
  const official = baseURL === OPENAI_BASE_URL;
  const maxTokensField = options.maxTokensField ?? (official ? 'max_completion_tokens' : 'max_tokens');
  const fetchImpl = options.fetch ?? defaultFetch();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...options.headers,
  };

  return {
    provider: 'openai',
    model: options.model,
    async *stream(request) {
      const body: Record<string, unknown> = {
        model: options.model,
        stream: true,
        messages: toOpenAIMessages(request.system, request.messages),
      };
      if (options.includeUsage ?? true) body.stream_options = { include_usage: true };
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      }
      if (options.maxTokens !== undefined) body[maxTokensField] = options.maxTokens;
      const stream = await postForStream(
        'openai',
        fetchImpl,
        `${baseURL}/chat/completions`,
        headers,
        { ...body, ...options.extraBody },
        request.signal,
      );
      yield* readStream(stream, request.signal);
    },
  };
}

/** Converts neutral messages to Chat Completions messages. Tool results that contain images
 * are followed by one user message carrying those images (tool messages are text-only). */
export function toOpenAIMessages(system: string | undefined, messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: userContent(message.content) });
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const calls = message.content.filter((part) => part.type === 'tool_call');
      if (!text && calls.length === 0) continue;
      const wire: WireMessage = { role: 'assistant', content: text || null };
      if (calls.length > 0) {
        wire.tool_calls = calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArgs || JSON.stringify(call.args ?? {}) },
        }));
      }
      out.push(wire);
    } else {
      const images: UserContent[] = [];
      for (const result of message.results) {
        let text: string;
        if (typeof result.content === 'string') {
          text = result.content;
        } else {
          text = result.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const attached = result.content.filter((part) => part.type === 'image');
          if (attached.length > 0) {
            images.push(...attached);
            text += `${text ? '\n' : ''}[${attached.length} image(s) attached in the next message]`;
          }
        }
        if (result.isError) text = `Error: ${text}`;
        out.push({ role: 'tool', tool_call_id: result.callId, content: text });
      }
      if (images.length > 0) out.push({ role: 'user', content: userContent(images) });
    }
  }
  return out;
}

function userContent(content: string | readonly UserContent[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') return content;
  // Plain text goes out as a string: some local servers reject content arrays.
  if (content.every((part) => part.type === 'text')) {
    return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  }
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } },
  );
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function readUsage(target: Usage, usage: unknown): void {
  if (!isPlainObject(usage)) return;
  if (typeof usage.prompt_tokens === 'number') target.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') target.outputTokens = usage.completion_tokens;
  const details = usage.prompt_tokens_details;
  if (isPlainObject(details) && typeof details.cached_tokens === 'number') target.cacheReadTokens = details.cached_tokens;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

async function* readStream(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<ModelEvent> {
  let text = '';
  const calls = new Map<number, PendingCall>();
  const usage = emptyUsage();
  let finishReason: string | null = null;
  let sawDone = false;
  let servedBy: string | undefined;

  for await (const sse of sseEvents('openai', body, signal)) {
    const data = sse.data.trim();
    if (!data) continue;
    if (data === '[DONE]') {
      sawDone = true;
      break;
    }
    const chunk = parseEventData('openai', data);
    if (isPlainObject(chunk.error)) {
      const message = typeof chunk.error.message === 'string' ? chunk.error.message : JSON.stringify(chunk.error);
      const code = typeof chunk.error.code === 'string' ? chunk.error.code : undefined;
      throw new ModelError(`openai: ${message}`, { provider: 'openai', ...(code === undefined ? {} : { code }) });
    }
    if (typeof chunk.model === 'string') servedBy = chunk.model;
    readUsage(usage, chunk.usage);
    const choice: unknown = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!isPlainObject(choice)) continue;
    const delta = isPlainObject(choice.delta) ? choice.delta : {};

    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      yield { type: 'text', delta: delta.content };
    }
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning', delta: reasoning };

    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls as unknown[]) {
        if (!isPlainObject(item)) continue;
        const index = typeof item.index === 'number' ? item.index : 0;
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        calls.set(index, call);
        if (typeof item.id === 'string' && item.id) call.id = item.id;
        const fn = isPlainObject(item.function) ? item.function : {};
        // Most servers send the name once; a few repeat it or send it in pieces.
        if (typeof fn.name === 'string' && fn.name && fn.name !== call.name) call.name += fn.name;
        if (typeof fn.arguments === 'string') call.args += fn.arguments;
      }
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }

  if (!sawDone && finishReason === null) {
    throw new ModelError('openai: stream ended before the response finished', { provider: 'openai', retryable: true });
  }

  const content: AssistantContent[] = [];
  if (text) content.push({ type: 'text', text });
  const stamp = Date.now().toString(36);
  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    content.push({
      type: 'tool_call',
      id: call.id || `call_${stamp}_${index}`,
      name: call.name,
      args: parseToolArgs(call.args),
      rawArgs: call.args,
    });
  }
  yield {
    type: 'done',
    message: { role: 'assistant', content },
    stopReason: mapFinishReason(finishReason),
    rawStopReason: finishReason,
    usage,
    ...(servedBy === undefined ? {} : { servedBy }),
  };
}
