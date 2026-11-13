import type { Item, StreamEvent, TurnRequest } from '@doccue/protocol';
import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/respond.js';
import { createMemoryLog } from '../src/log/log.js';
import { parseSSE } from '../src/model/sse.js';
import { parseTurnRequest } from '../src/protocol/parse.js';
import { createHandler } from '../src/server/handler.js';
import { collect, done, fakeModel, reply, toolCall } from './helpers.js';

const request = (text = '为什么连不上？'): TurnRequest => ({
  v: 1,
  locale: 'zh-CN',
  conversation: [
    {
      type: 'user',
      text,
      perception: { at: 1000, screen: { page: { path: '/datasource/new' }, nodes: [{ ref: 1, role: 'button', name: '测试连接' }] }, actions: [] },
    },
  ],
});

const post = (body: unknown, path = '/doccue/turn') =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function readEvents(response: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const message of parseSSE(response.body!)) events.push(JSON.parse(message.data) as StreamEvent);
  return events;
}

describe('respond', () => {
  it('renders the conversation, streams the answer and returns the messages to keep', async () => {
    const model = fakeModel(() => reply('去掉 http://'));
    const events = await collect(respond(request(), { model, instructions: '你是助手。' }));

    expect(model.requests[0]!.system).toMatch(/^你是助手。/);
    expect(model.requests[0]!.messages).toEqual([
      { role: 'user', content: '<context locale="zh-CN">\nscreen:\npage /datasource/new\n[1] button "测试连接"\n</context>\n为什么连不上？' },
    ]);
    expect(events[0]).toEqual({ type: 'status', state: 'thinking' });
    expect(events.filter((event) => event.type === 'text').map((event) => event.delta).join('')).toBe('去掉 http://');
    expect(events.at(-1)).toMatchObject({
      type: 'end',
      reason: 'completed',
      item: { type: 'model', messages: [{ role: 'assistant', content: [{ type: 'text', text: '去掉 http://' }] }] },
    });
  });

  it('continues a conversation from the items it returned earlier', async () => {
    const first = await collect(respond(request(), { model: fakeModel(() => reply('去掉 http://')) }));
    const item = (first.at(-1) as Extract<StreamEvent, { type: 'end' }>).item;
    const model = fakeModel(() => reply('端口不对'));
    await collect(respond({ ...request(), conversation: [...request().conversation, item, ...request('还是不行').conversation] }, { model }));
    expect(model.requests[0]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('runs backend tools within the request and logs every step', async () => {
    const { logger, records } = createMemoryLog();
    const model = fakeModel(
      () => [done([toolCall('c1', 'lookup', {})], 'tool_use')],
      () => reply('好了'),
    );
    const events = await collect(
      respond(request(), { model, logger, tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' }, execute: async () => 'found' }] }),
    );
    expect(events).toContainEqual({ type: 'status', state: 'tool', tool: 'lookup' });
    const end = events.at(-1) as Extract<StreamEvent, { type: 'end' }>;
    expect((end.item as { messages: Array<{ role: string }> }).messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(records.map((record) => record.kind)).toEqual(['request', 'model_call', 'model_call', 'end']);
    const calls = records.filter((record) => record.kind === 'model_call');
    expect(calls.map((call) => call.step)).toEqual([1, 2]);
    // The logged request is exactly what the model received.
    expect(calls[1]!.request.messages).toEqual(model.requests[1]!.messages);
  });

  it('hands a guide to the frontend and continues from its result', async () => {
    const steps = [{ target: 1, text: '点这里重新测试' }];
    const model = fakeModel(
      // [7] is not on the screen: the model is told and tries again.
      () => [done([toolCall('g0', 'guide', { steps: [{ target: 7, text: '点这里' }] })], 'tool_use')],
      () => reply('我指给你看。', [toolCall('g1', 'guide', { steps })], 'tool_use'),
    );
    const events = await collect(respond(request(), { model }));
    expect(model.requests[0]!.tools?.map((tool) => tool.name)).toEqual(['guide']);
    expect(events.filter((event) => event.type === 'status' && event.state === 'tool')).toEqual([]);
    expect(events.slice(-2)).toMatchObject([
      { type: 'guide', callId: 'g1', steps },
      { type: 'end', reason: 'guide' },
    ]);
    const item = (events.at(-1) as Extract<StreamEvent, { type: 'end' }>).item;
    expect(JSON.stringify(item)).toContain('there is no element [7] on the latest screen');

    // Next request: the conversation plus the guide's result, which the model reads as the tool result.
    const perception = (request().conversation[0] as Extract<Item, { type: 'user' }>).perception;
    const next = fakeModel(() => reply('已经连上了。'));
    const result = { type: 'guide_result' as const, callId: 'g1', result: { outcome: 'completed' as const, completedSteps: 1, perception } };
    const after = await collect(respond({ ...request(), conversation: [...request().conversation, item, result] }, { model: next }));
    expect(next.requests[0]!.messages.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'g1', content: expect.stringMatching(/^outcome: completed/) }] });
    expect(after.at(-1)).toMatchObject({ type: 'end', reason: 'completed' });
  });

  it('reports a model failure in the end event', async () => {
    const model = fakeModel(() => {
      throw new Error('boom');
    });
    expect((await collect(respond(request(), { model }))).at(-1)).toMatchObject({ type: 'end', reason: 'error', error: { message: 'boom' } });
  });
});

describe('createHandler', () => {
  it('answers POST {base}/turn with a stream of events', async () => {
    const handler = createHandler({ model: fakeModel(() => reply('你好')), basePath: '/doccue/' });
    const response = await handler(post(request()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readEvents(response);
    expect(events.map((event) => event.type)).toEqual(['status', 'text', 'text', 'end']);
  });

  it('rejects other paths, methods and malformed bodies', async () => {
    const handler = createHandler({ model: fakeModel(), basePath: '/doccue' });
    expect((await handler(post(request(), '/doccue/other'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/doccue/turn'))).status).toBe(405);
    const bad = await handler(post({ v: 1, conversation: [{ type: 'user', text: 1 }] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors).toContain('conversation[0].text: expected a string');
  });
});

describe('parseTurnRequest', () => {
  it('accepts a well-formed request and names what is wrong otherwise', () => {
    expect(parseTurnRequest(request())).toEqual({ ok: true, value: request() });
    expect(parseTurnRequest({ v: 2, conversation: [] })).toEqual({ ok: false, errors: ['v: expected 1', 'conversation: expected a non-empty array'] });
    expect(parseTurnRequest({ v: 1, conversation: [{ type: 'model', messages: [] }] })).toEqual({
      ok: false,
      errors: ['conversation: the last item must be a question or a guide result'],
    });
  });
});
