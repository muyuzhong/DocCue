import { describe, expect, it } from 'vitest';
import { createAnthropic } from '../src/model/anthropic.js';
import { ModelError } from '../src/model/errors.js';
import type { Message, ModelDone } from '../src/model/types.js';
import { collect, mockFetch, sseResponse } from './helpers.js';

const ev = (type: string, data: Record<string, unknown>) => ({ event: type, data: { type, ...data } });

const toolTurnEvents = [
  ev('message_start', {
    message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } },
  }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '你好，' } }),
  { event: 'ping', data: { type: 'ping' } },
  ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '世界' } }),
  ev('content_block_stop', { index: 1 }),
  ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_screen', input: {} } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"ful' } }),
  ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: 'l":true}' } }),
  ev('content_block_stop', { index: 2 }),
  ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
  ev('message_stop', {}),
];

describe('createAnthropic', () => {
  it('streams text and assembles thinking, text and tool calls in order', async () => {
    const { fetch } = mockFetch(sseResponse(toolTurnEvents));
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const events = await collect(model.stream({ messages: [{ role: 'user', content: 'hi' }] }));

    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.delta : ''))).toEqual(['你好，', '世界']);
    const end = events.at(-1) as ModelDone;
    expect(end.type).toBe('done');
    expect(end.stopReason).toBe('tool_use');
    expect(end.servedBy).toBe('claude-opus-5-5');
    expect(end.usage).toEqual({ inputTokens: 17, outputTokens: 42, cacheReadTokens: 5, cacheWriteTokens: 2 });
    expect(end.message.content).toEqual([
      { type: 'raw', provider: 'anthropic', block: { type: 'thinking', thinking: '', signature: 'sig-123' } },
      { type: 'text', text: '你好，世界' },
      { type: 'tool_call', id: 'toolu_1', name: 'get_screen', args: { full: true }, rawArgs: '{"full":true}' },
    ]);
  });

  it('sends the current API version, defaults for the official endpoint, and no sampling params', async () => {
    const { fetch, calls } = mockFetch(sseResponse(toolTurnEvents));
    const model = createAnthropic({ apiKey: 'secret', model: 'claude-opus-5-5', effort: 'low', fetch });
    await collect(
      model.stream({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'get_screen', description: 'Read the screen', parameters: { type: 'object', properties: {} } }],
      }),
    );
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers).toMatchObject({
      'x-api-key': 'secret',
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      stream: true,
      system: 'sys',
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low' },
      tools: [{ name: 'get_screen', description: 'Read the screen', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }],
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(call.body).not.toHaveProperty(key);
  });

  it('leaves optional features off behind a custom base URL', async () => {
    const { fetch, calls } = mockFetch(sseResponse(toolTurnEvents));
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', baseURL: 'https://relay.example.com/', fetch });
    await collect(
      model.stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      }),
    );
    const call = calls[0]!;
    expect(call.url).toBe('https://relay.example.com/v1/messages');
    expect(call.headers).not.toHaveProperty('anthropic-beta');
    for (const key of ['fallbacks', 'cache_control']) expect(call.body).not.toHaveProperty(key);
    expect((call.body.tools as Record<string, unknown>[])[0]).not.toHaveProperty('eager_input_streaming');
  });

  it('replays history: raw blocks unchanged, tool results and follow-up text merged into one user turn', async () => {
    const { fetch, calls } = mockFetch(sseResponse(toolTurnEvents));
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const thinking = { type: 'thinking', thinking: '', signature: 'sig-123' };
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      {
        role: 'assistant',
        content: [
          { type: 'raw', provider: 'anthropic', block: thinking },
          { type: 'raw', provider: 'openai', block: { ignored: true } },
          { type: 'text', text: 'checking' },
          { type: 'tool_call', id: 'toolu_1', name: 'get_screen', args: { full: true }, rawArgs: '{"full":true}' },
        ],
      },
      { role: 'tool', results: [{ callId: 'toolu_1', content: 'boom', isError: true }] },
      { role: 'user', content: 'and now?' },
    ];
    await collect(model.stream({ messages: history }));
    expect(calls[0]!.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: [thinking, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'get_screen', input: { full: true } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
          { type: 'text', text: 'and now?' },
        ],
      },
    ]);
  });

  it('after a mid-stream fallback keeps only text from before the switch', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        ev('message_start', { message: { model: 'claude-opus-5-5', usage: { input_tokens: 3 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: 'a' } }),
        ev('content_block_start', { index: 1, content_block: { type: 'text', text: 'partial ' } }),
        ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_x', name: 'x', input: {} } }),
        ev('content_block_start', { index: 3, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } } }),
        ev('content_block_start', { index: 4, content_block: { type: 'thinking', thinking: '', signature: 'b' } }),
        ev('content_block_start', { index: 5, content_block: { type: 'text', text: 'continued' } }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
        ev('message_stop', {}),
      ]),
    );
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const end = (await collect(model.stream({ messages: [{ role: 'user', content: 'q' }] }))).at(-1) as ModelDone;
    expect(end.message.content).toEqual([
      { type: 'text', text: 'partial ' },
      { type: 'raw', provider: 'anthropic', block: { type: 'thinking', thinking: '', signature: 'b' } },
      { type: 'text', text: 'continued' },
    ]);
  });

  it('reports refusals with their details', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        ev('message_start', { message: { model: 'claude-opus-5-5', usage: { input_tokens: 3 } } }),
        ev('message_delta', { delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } }, usage: { output_tokens: 0 } }),
        ev('message_stop', {}),
      ]),
    );
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const end = (await collect(model.stream({ messages: [{ role: 'user', content: 'q' }] }))).at(-1) as ModelDone;
    expect(end.stopReason).toBe('refusal');
    expect(end.stopDetails).toEqual({ type: 'refusal', category: 'bio' });
    expect(end.message.content).toEqual([]);
  });

  it('turns HTTP errors into ModelError with status, code and retry hint', async () => {
    const response = new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
      status: 529,
      headers: { 'retry-after': '2' },
    });
    const { fetch } = mockFetch(response);
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const error = await collect(model.stream({ messages: [{ role: 'user', content: 'q' }] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ status: 529, code: 'overloaded_error', retryable: true, retryAfterMs: 2000 });
  });

  it('turns stream error events and truncated streams into ModelError', async () => {
    const { fetch } = mockFetch(
      sseResponse([ev('message_start', { message: {} }), ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })]),
      sseResponse([ev('message_start', { message: {} })]),
    );
    const model = createAnthropic({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
    const first = await collect(model.stream({ messages: [{ role: 'user', content: 'q' }] })).catch((e: unknown) => e);
    expect(first).toMatchObject({ name: 'ModelError', code: 'overloaded_error', retryable: true });
    const second = await collect(model.stream({ messages: [{ role: 'user', content: 'q' }] })).catch((e: unknown) => e);
    expect(second).toMatchObject({ name: 'ModelError', retryable: true });
  });
});
