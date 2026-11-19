import type { Item, Perception, ScreenNode, StreamEvent, TurnRequest } from '@doccue/protocol';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/respond.js';
import type { DocsProvider } from '../src/docs/docs.js';
import { createMemoryLog } from '../src/log/log.js';
import type { Tool } from '../src/loop/types.js';
import { createAnthropic } from '../src/model/anthropic.js';
import { parseSSE } from '../src/model/sse.js';
import type { ModelAdapter } from '../src/model/types.js';
import { parseTurnRequest } from '../src/protocol/parse.js';
import { createHandler } from '../src/server/handler.js';
import { toNodeHandler } from '../src/server/node.js';
import { collect, mockFetch, sseResponse } from './helpers.js';
import { describeWithModel, realModel, rejectedModel } from './model.js';

/** A model for tests where the handler must turn the request away before calling the model. */
const unusedModel: ModelAdapter = {
  provider: 'unused',
  model: 'unused',
  async *stream() {
    throw new Error('model should not be called');
  },
};

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

describeWithModel('respond with the real model', () => {
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

describeWithModel('createHandler', () => {
  it('answers POST {base}/turn with the answer as server-sent events', async () => {
    const handler = createHandler({ model: realModel(), instructions: INSTRUCTIONS, basePath: '/doccue/' });
    // A page with nothing wrong on it: an error on screen invites a guide instead of words.
    const calm: Perception = { at: Date.now(), screen: { page: { path: '/dashboard', title: '仪表盘' }, nodes: [{ ref: 1, role: 'heading', name: '仪表盘' }] }, actions: [] };
    const response = await handler(post(ask('只回答一个字：好', calm)));
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
});

describe('createHandler (without a model)', () => {
  it('rejects other paths, methods and malformed bodies without calling the model', async () => {
    const { logger, records } = createMemoryLog();
    const handler = createHandler({ model: unusedModel, basePath: '/doccue', logger });
    expect((await handler(post(ask('hi'), '/doccue/other'))).status).toBe(404);
    expect((await handler(new Request('http://localhost/doccue/turn'))).status).toBe(405);
    const bad = await handler(post({ v: 1, conversation: [{ type: 'user', text: 1 }] }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors).toContain('conversation[0].text: expected a string');
    expect(records).toEqual([]);
  });
});

describe('limits', () => {
  it('turns away bodies and requests over the limits, saying which, without calling the model', async () => {
    const { logger, records } = createMemoryLog();
    const handler = createHandler({
      model: unusedModel,
      basePath: '/doccue',
      logger,
      maxBodyBytes: 20_000,
      limits: { maxItems: 3, maxQuestionChars: 20, maxScreenNodes: 5, maxActions: 1 },
    });
    const errorsOf = async (response: Response) => ((await response.json()) as { errors: string[] }).errors;
    const empty: Perception = { at: 1, screen: { page: { path: '/' }, nodes: [] }, actions: [] };

    const huge = await handler(post(ask('x'.repeat(30_000), empty)));
    expect(huge.status).toBe(413);
    expect(await errorsOf(huge)).toEqual(['body: larger than 20000 bytes']);

    const long = await handler(post(ask('这个问题写得非常非常非常非常非常非常非常长', empty)));
    expect(await errorsOf(long)).toEqual(['conversation[0].text: longer than 20 characters']);

    const many = await handler(post({ ...ask('hi'), conversation: Array.from({ length: 5 }, () => ask('hi', empty).conversation[0]) }));
    expect(await errorsOf(many)).toEqual(['conversation: more than 3 items']);

    // wrongHost has 7 screen nodes and 2 actions.
    const busy = await handler(post(ask('hi')));
    expect(busy.status).toBe(400);
    expect(await errorsOf(busy)).toEqual(['conversation[0].perception.actions: more than 1 actions']);
    const crowded = await handler(post(ask('hi', { ...wrongHost, actions: [] })));
    expect(await errorsOf(crowded)).toEqual(['conversation[0].perception.screen.nodes: more than 5 nodes']);

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

  it('checks the stored model messages, the screen, the actions and guide results all the way down', () => {
    const screen = { page: { path: '/' }, nodes: [{ role: 'form', children: [{ role: 'button', name: 7 }] }] };
    const perception = { at: 1, screen, actions: [{ at: 1, action: { type: 'tap' }, effects: [{ type: 'oops' }] }] };
    const result = parseTurnRequest({
      v: 1,
      locale: 'zh-CN"><x',
      conversation: [
        { type: 'model', messages: [{ role: 'assistant', content: 'bad' }, { role: 'tool', results: [{ callId: 'c1', content: 3 }] }, null] },
        { type: 'user', text: 'hi', perception },
        { type: 'guide_result', callId: 'c1', result: { outcome: 'done', completedSteps: 1, perception: { ...perception, actions: [] } } },
      ],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        'locale: expected a language tag such as "zh-CN"',
        'conversation[0].messages[0].content: expected an array',
        'conversation[0].messages[1].results[0].content: expected a string or an array',
        'conversation[0].messages[2]: expected an object',
        'conversation[1].perception.actions[0].action.type: expected one of "click", "input", "select", "check", "uncheck", "submit"',
        'conversation[1].perception.actions[0].effects[0].type: expected one of "error", "notice", "dialog", "navigate", "request_failed", "script_error"',
        'conversation[1].perception.screen.nodes[0].children[0].name: expected a string',
        'conversation[2].result.outcome: expected one of "completed", "deviated", "not_found", "interrupted", "exited"',
        'conversation[2].result.perception.screen.nodes[0].children[0].name: expected a string',
      ],
    });
  });

  it('refuses screens nested deeper than any page', () => {
    let node: ScreenNode = { role: 'button' };
    for (let i = 0; i < 10_000; i++) node = { role: 'group', children: [node] };
    const result = parseTurnRequest(ask('hi', { at: 1, actions: [], screen: { page: { path: '/' }, nodes: [node] } }));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors[0]).toMatch(/nested more than 64 levels deep$/);
  });
});

describe('createHandler when things go wrong', () => {
  it('still ends the stream with an end event when something throws, and logs what it was', async () => {
    const { logger, records } = createMemoryLog();
    const docs: DocsProvider = {
      toc: () => {
        throw new Error('docs index missing');
      },
      search: async () => [],
      read: async () => undefined,
    };
    const handler = createHandler({ model: unusedModel, docs, basePath: '/doccue', logger });
    const events = await readEvents(await handler(post(ask('hi'))));
    expect(events).toEqual([{ type: 'end', reason: 'error', item: { type: 'model', messages: [] }, usage: expect.any(Object), error: { message: 'internal error' } }]);
    expect(records.at(-1)).toMatchObject({ kind: 'end', reason: 'error', error: { message: 'docs index missing' } });
  });

  it('replaces the user the browser sent with the one from the session', async () => {
    const { logger, records } = createMemoryLog();
    const { fetch } = mockFetch(new Response('unauthorized', { status: 401 }));
    const model = createAnthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch });
    const handler = createHandler({ model, basePath: '/doccue', logger, user: () => ({ role: 'viewer' }) });
    await readEvents(await handler(post({ ...ask('hi'), user: { role: 'admin' } })));
    const request = records.find((record) => record.kind === 'request');
    expect(request).toMatchObject({ request: { user: { role: 'viewer' } } });
  });
});

describe('toNodeHandler', () => {
  it('answers a request it cannot read with 400 instead of rejecting', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    const server = createServer((req, res) => void toNodeHandler(createHandler({ model: unusedModel, basePath: '/doccue' }))(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
      socket.write('POST /doccue/turn HTTP/1.1\r\nHost: bad host\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
      const reply = await new Promise<string>((resolve) => {
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('close', () => resolve(data));
      });
      expect(reply).toMatch(/^HTTP\/1\.1 400 /);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reads req.body when earlier middleware (like express.json) already consumed the stream', async () => {
    const ev = (type: string, data: Record<string, unknown>) => ({ event: type, data: { type, ...data } });
    const okAnswer = () =>
      sseResponse([
        ev('message_start', { message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        ev('message_stop', {}),
      ]);
    const { fetch } = mockFetch(okAnswer(), okAnswer(), okAnswer());
    const handler = toNodeHandler(createHandler({ model: createAnthropic({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }), basePath: '/doccue', maxBodyBytes: 5000 }));

    let mode: 'json' | 'text' | 'raw' = 'json';
    const server = createServer((req, res) => {
      // Simulate body-parser middleware draining the stream before passing req to toNodeHandler.
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const parsed = req as typeof req & { body?: unknown };
        parsed.body = mode === 'json' ? JSON.parse(raw.toString('utf8')) : mode === 'text' ? raw.toString('utf8') : raw;
        void handler(parsed, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/doccue/turn`;
    try {
      for (const current of ['json', 'text', 'raw'] as const) {
        mode = current;
        const response = await globalThis.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask('hi')) });
        expect(response.status).toBe(200);
        const events = await readEvents(response);
        expect(textOf(events)).toBe('ok');
        expect(endOf(events).reason).toBe('completed');
      }
      // Size limit still applies to pre-parsed bodies.
      mode = 'json';
      const huge = await globalThis.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask('x'.repeat(6000))) });
      expect(huge.status).toBe(413);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('aborts the handler signal when the client disconnects mid-stream, and not on a normal finish', async () => {
    let normalAborted = false;
    let droppedAborted = false;
    let releaseStream: (() => void) | undefined;
    const server = createServer(
      toNodeHandler(async (request) => {
        if (new URL(request.url).pathname === '/normal') {
          request.signal.addEventListener('abort', () => (normalAborted = true));
          return new Response('ok');
        }
        request.signal.addEventListener('abort', () => {
          droppedAborted = true;
          releaseStream?.();
        });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
            releaseStream = () => {
              releaseStream = undefined;
              controller.close();
            };
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(await (await globalThis.fetch(`http://127.0.0.1:${port}/normal`)).text()).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(normalAborted).toBe(false);

      const socket = connect(port, '127.0.0.1');
      socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
      await new Promise<void>((resolve) => socket.once('data', () => resolve()));
      socket.destroy();
      for (let waited = 0; !droppedAborted && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(droppedAborted).toBe(true);
    } finally {
      releaseStream?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
