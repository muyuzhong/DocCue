import type { Item, Perception, StreamEvent, TurnRequest } from '@doccue/protocol';
import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/respond.js';
import { createMemoryLog } from '../src/log/log.js';
import type { Tool } from '../src/loop/types.js';
import { parseSSE } from '../src/model/sse.js';
import { parseTurnRequest } from '../src/protocol/parse.js';
import { createHandler } from '../src/server/handler.js';
import { collect } from './helpers.js';
import { realModel, rejectedModel } from './model.js';

const INSTRUCTIONS = '你是「数据平台」的应用内助手。主机地址只填 IP 或域名，不带协议和端口。';

/** The create-datasource page after the user typed a host with a scheme and pressed the test button. */
const wrongHost: Perception = {
  at: 1_700_000_000_000,
  screen: {
    page: { path: '/datasource/new', title: '新建数据源' },
    nodes: [
      { ref: 1, role: 'heading', name: '新建数据源' },
      {
        ref: 2,
        role: 'form',
        name: '连接信息',
        children: [
          { ref: 3, role: 'textbox', name: '主机地址', value: 'http://127.0.0.1:5432', states: ['invalid'] },
          { role: 'alert', name: 'Invalid Host Format' },
          { ref: 4, role: 'textbox', name: '端口', value: '5432' },
          { ref: 5, role: 'button', name: '测试连接' },
          { ref: 6, role: 'button', name: '保存', states: ['disabled'] },
        ],
      },
    ],
  },
  actions: [
    { at: 1_700_000_000_000 - 3000, action: { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: 'http://127.0.0.1:5432' } },
    {
      at: 1_700_000_000_000 - 1000,
      action: { type: 'click', target: { role: 'button', name: '测试连接' } },
      effects: [{ type: 'error', text: 'Invalid Host Format', target: { role: 'textbox', name: '主机地址' } }],
    },
  ],
};

const ask = (text: string, perception: Perception = wrongHost, earlier: Item[] = []): TurnRequest => ({
  v: 1,
  locale: 'zh-CN',
  conversation: [...earlier, { type: 'user', text, perception }],
});

const post = (body: unknown, path = '/doccue/turn') =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function readEvents(response: Response): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const message of parseSSE(response.body!)) events.push(JSON.parse(message.data) as StreamEvent);
  return events;
}

const endOf = (events: StreamEvent[]) => events.at(-1) as Extract<StreamEvent, { type: 'end' }>;
const textOf = (events: StreamEvent[]) => events.map((event) => (event.type === 'text' ? event.delta : '')).join('');

describe('respond with the real model', () => {
  it('answers from what the user did and saw, and returns the messages to keep', async () => {
    const { logger, records } = createMemoryLog();
    const events = await collect(respond(ask('主机地址这一栏有什么要求？只用文字回答，不要在页面上指。'), { model: realModel(), instructions: INSTRUCTIONS, logger }));

    // The model got the developer's instructions and the rendered context.
    const call = records.find((record) => record.kind === 'model_call')!;
    expect(call.request.system).toMatch(/^你是「数据平台」的应用内助手。/);
    expect(call.request.messages[0]).toEqual({ role: 'user', content: expect.stringContaining('click button "测试连接" -> error "Invalid Host Format" on textbox "主机地址"') });

    expect(events[0]).toEqual({ type: 'status', state: 'thinking' });
    const end = endOf(events);
    expect(end).toMatchObject({ type: 'end', reason: 'completed', item: { type: 'model' } });
    expect(textOf(events)).toMatch(/http|协议/);
    expect(records.map((record) => record.kind)).toEqual(['request', 'model_call', 'end']);
  });

  it('continues a conversation from the items it returned earlier', async () => {
    const opening = ask('我的数据源准备叫 orders-db，记住这个名字就行，回答“好”。');
    const first = await collect(respond(opening, { model: realModel(), instructions: INSTRUCTIONS }));
    const earlier = [...opening.conversation, endOf(first).item];
    const second = await collect(respond(ask('我刚才说数据源叫什么名字？只回答名字。', wrongHost, earlier), { model: realModel(), instructions: INSTRUCTIONS }));
    expect(endOf(second).reason).toBe('completed');
    expect(textOf(second)).toMatch(/orders-db/);
  });

  it('runs backend tools within the request and logs every model call', async () => {
    const { logger, records } = createMemoryLog();
    const ports: Tool = {
      name: 'default_port',
      description: 'Returns the default port of a database type.',
      parameters: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      execute: async () => '6543',
    };
    const events = await collect(
      respond(ask('用 default_port 工具查一下 PostgreSQL 的默认端口，只回答数字。'), { model: realModel(), instructions: INSTRUCTIONS, tools: [ports], logger }),
    );
    expect(events).toContainEqual({ type: 'status', state: 'tool', tool: 'default_port' });
    expect(textOf(events)).toMatch(/6543/);
    const calls = records.filter((record) => record.kind === 'model_call');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map((call) => call.step)).toEqual(calls.map((_, index) => index + 1));
    expect(new Set(records.map((record) => record.requestId)).size).toBe(1);
  });

  it('guides on the page, then reads the guide result and confirms', async () => {
    const events = await collect(respond(ask('为什么连不上？'), { model: realModel(), instructions: INSTRUCTIONS }));
    const guide = events.find((event): event is Extract<StreamEvent, { type: 'guide' }> => event.type === 'guide');
    expect(guide?.steps[0]?.target).toBe(3); // the host field
    expect(endOf(events).reason).toBe('guide');
    // The guide is the frontend's job: no tool status for it.
    expect(events.filter((event) => event.type === 'status' && event.state === 'tool')).toEqual([]);

    // The user fixed the host and tested again: connected.
    const fixed: Perception = {
      at: wrongHost.at + 20_000,
      screen: {
        page: wrongHost.screen.page,
        nodes: [
          { ref: 1, role: 'heading', name: '新建数据源' },
          {
            ref: 2,
            role: 'form',
            name: '连接信息',
            children: [
              { ref: 3, role: 'textbox', name: '主机地址', value: '127.0.0.1' },
              { ref: 4, role: 'textbox', name: '端口', value: '5432' },
              { ref: 5, role: 'button', name: '测试连接' },
              { ref: 6, role: 'button', name: '保存' },
            ],
          },
          { role: 'status', name: '连接成功：PostgreSQL 16.2' },
        ],
      },
      actions: [
        { at: wrongHost.at + 10_000, action: { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: '127.0.0.1' } },
        { at: wrongHost.at + 15_000, action: { type: 'click', target: { role: 'button', name: '测试连接' } }, effects: [{ type: 'notice', text: '连接成功：PostgreSQL 16.2' }] },
      ],
    };
    const result: Item = { type: 'guide_result', callId: guide!.callId, result: { outcome: 'completed', completedSteps: guide!.steps.length, perception: fixed } };
    const after = await collect(respond({ ...ask('为什么连不上？'), conversation: [...ask('为什么连不上？').conversation, endOf(events).item, result] }, { model: realModel(), instructions: INSTRUCTIONS }));
    expect(endOf(after).reason).toBe('completed');
    expect(textOf(after)).toMatch(/成功|连上|连通/);
  });

  it('reports a model failure in the end event', async () => {
    const events = await collect(respond(ask('你好'), { model: rejectedModel() }));
    expect(endOf(events)).toMatchObject({ type: 'end', reason: 'error', error: { message: expect.any(String) } });
  });
});

describe('createHandler', () => {
  it('answers POST {base}/turn with the answer as server-sent events', async () => {
    const handler = createHandler({ model: realModel(), instructions: INSTRUCTIONS, basePath: '/doccue/' });
    const response = await handler(post(ask('只回答一个字：好')));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = await readEvents(response);
    expect(events[0]).toEqual({ type: 'status', state: 'thinking' });
    expect(events.some((event) => event.type === 'text')).toBe(true);
    expect(endOf(events)).toMatchObject({ type: 'end', reason: 'completed' });
  });

  it('stops the model when the client goes away', async () => {
    const { logger, records } = createMemoryLog();
    const handler = createHandler({ model: realModel(), basePath: '/doccue', logger });
    const controller = new AbortController();
    const response = await handler(new Request('http://localhost/doccue/turn', { method: 'POST', body: JSON.stringify(ask('从 1 数到 300，每行一个数。')), signal: controller.signal }));
    const reader = response.body!.getReader();
    for (let text = ''; !text.includes('"text"'); ) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await reader.cancel();
    for (let waited = 0; !records.some((record) => record.kind === 'model_call') && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records.find((record) => record.kind === 'model_call')?.error?.name).toMatch(/Stopped|AbortError/);
  });

  it('rejects other paths, methods and malformed bodies without calling the model', async () => {
    const { logger, records } = createMemoryLog();
    const handler = createHandler({ model: rejectedModel(), basePath: '/doccue', logger });
    expect((await handler(post(ask('hi'), '/doccue/other'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/doccue/turn'))).status).toBe(405);
    const bad = await handler(post({ v: 1, conversation: [{ type: 'user', text: 1 }] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors).toContain('conversation[0].text: expected a string');
    expect(records).toEqual([]);
  });
});

describe('parseTurnRequest', () => {
  it('accepts a well-formed request and names what is wrong otherwise', () => {
    expect(parseTurnRequest(ask('hi'))).toEqual({ ok: true, value: ask('hi') });
    expect(parseTurnRequest({ v: 2, conversation: [] })).toEqual({ ok: false, errors: ['v: expected 1', 'conversation: expected a non-empty array'] });
    expect(parseTurnRequest({ v: 1, conversation: [{ type: 'model', messages: [] }] })).toEqual({
      ok: false,
      errors: ['conversation: the last item must be a question or a guide result'],
    });
  });
});
