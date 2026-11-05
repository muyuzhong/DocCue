import { describe, expect, it } from 'vitest';
import { ModelError } from '../src/model/errors.js';
import { createOpenAI } from '../src/model/openai.js';
import type { Message, ModelDone } from '../src/model/types.js';
import { collect, mockFetch, sseResponse } from './helpers.js';

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  data: { id: 'c1', model: 'gpt-test', choices: [{ index: 0, delta, finish_reason }] },
});

describe('createOpenAI', () => {
  it('streams text and assembles tool calls from argument fragments', async () => {
    const { fetch } = mockFetch(
      sseResponse([
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_time', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"tz":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }),
        chunk({}, 'tool_calls'),
        { data: { id: 'c1', choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4 } } } },
        { data: '[DONE]' },
      ]),
    );
    const model = createOpenAI({ apiKey: 'k', model: 'gpt-test', fetch });
    const events = await collect(model.stream({ messages: [{ role: 'user', content: 'time?' }] }));
    expect(events.filter((e) => e.type === 'text').length).toBe(2);
    const end = events.at(-1) as ModelDone;
    expect(end.stopReason).toBe('tool_use');
    expect(end.usage).toEqual({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 0 });
    expect(end.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_call', id: 'call_a', name: 'get_time', args: { tz: 'UTC' }, rawArgs: '{"tz":"UTC"}' },
    ]);
  });

  it('builds the request: system first, tool calls, tool results, images after tool messages', async () => {
    const { fetch, calls } = mockFetch(sseResponse([chunk({ content: 'ok' }, 'stop'), { data: '[DONE]' }]));
    const model = createOpenAI({ apiKey: 'k', model: 'gpt-test', maxTokens: 100, fetch });
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      {
        role: 'assistant',
        content: [
          { type: 'raw', provider: 'anthropic', block: { type: 'thinking' } },
          { type: 'text', text: 'looking' },
          { type: 'tool_call', id: 'call_1', name: 'shot', args: {}, rawArgs: '{}' },
        ],
      },
      {
        role: 'tool',
        results: [{ callId: 'call_1', content: [{ type: 'text', text: 'see image' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }],
      },
    ];
    await collect(
      model.stream({
        system: 'sys',
        messages: history,
        tools: [{ name: 'shot', description: 'Screenshot', parameters: { type: 'object' } }],
      }),
    );
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(call.body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 100,
      tools: [{ type: 'function', function: { name: 'shot', description: 'Screenshot', parameters: { type: 'object' } } }],
    });
    expect(call.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'looking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shot', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'see image\n[1 image(s) attached in the next message]' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
  });

  it('works with a local server: no auth header, max_tokens field', async () => {
    const { fetch, calls } = mockFetch(sseResponse([chunk({ content: 'hi' }, 'stop')]));
    const model = createOpenAI({ model: 'qwen3', baseURL: 'http://localhost:11434/v1/', maxTokens: 50, fetch });
    const end = (await collect(model.stream({ messages: [{ role: 'user', content: 'hi' }] }))).at(-1) as ModelDone;
    expect(end.stopReason).toBe('end');
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
    expect(calls[0]!.body).toMatchObject({ max_tokens: 50 });
  });

  it('marks invalid tool JSON with args undefined', async () => {
    const { fetch } = mockFetch(
      sseResponse([chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] }, 'tool_calls'), { data: '[DONE]' }]),
    );
    const model = createOpenAI({ model: 'm', baseURL: 'http://local/v1', fetch });
    const end = (await collect(model.stream({ messages: [{ role: 'user', content: 'x' }] }))).at(-1) as ModelDone;
    expect(end.message.content[0]).toMatchObject({ type: 'tool_call', args: undefined, rawArgs: '{"a":' });
  });

  it('raises ModelError for HTTP errors, error chunks and truncated streams', async () => {
    const { fetch } = mockFetch(
      new Response(JSON.stringify({ error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }), { status: 429 }),
      sseResponse([{ data: { error: { message: 'bad things', code: 'server_error' } } }]),
      sseResponse([chunk({ content: 'half' })]),
    );
    const model = createOpenAI({ model: 'm', fetch });
    const request = { messages: [{ role: 'user' as const, content: 'x' }] };
    const http = await collect(model.stream(request)).catch((e: unknown) => e);
    expect(http).toBeInstanceOf(ModelError);
    expect(http).toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryable: true });
    expect(await collect(model.stream(request)).catch((e: unknown) => e)).toMatchObject({ code: 'server_error', retryable: false });
    expect(await collect(model.stream(request)).catch((e: unknown) => e)).toMatchObject({ retryable: true });
  });
});
