import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { statusContext } from '../src/context/status-context.js';
import type { ModelEvent, ModelRequest } from '../src/model/types.js';
import { createScheduler } from '../src/scheduler/scheduler.js';
import type { AgentOutput, Scheduler } from '../src/scheduler/types.js';
import { createHandler, type HandlerOptions } from '../src/server/handler.js';
import { toNodeHandler } from '../src/server/node.js';
import { fakeModel, reply } from './helpers.js';

const BASE = 'http://test/doccue';

/** A scheduler that counts live subscriptions, to check streams clean up after themselves. */
function counting(scheduler: Scheduler): Scheduler & { active: () => number } {
  let active = 0;
  return {
    ...scheduler,
    active: () => active,
    subscribe(id, listener) {
      active++;
      const off = scheduler.subscribe(id, listener);
      return () => {
        active--;
        off();
      };
    },
  };
}

function setup(steps: Array<(request: ModelRequest) => ModelEvent[]>, options: Partial<HandlerOptions> = {}) {
  const model = fakeModel(...steps);
  const scheduler = counting(createScheduler({ model, context: statusContext() }));
  const handler = createHandler({ scheduler, basePath: '/doccue', keepAliveMs: 20, debug: true, ...options });
  return { model, scheduler, handler };
}

const post = (handler: (r: Request) => Promise<Response>, body: unknown, base = BASE) =>
  handler(new Request(`${base}/events`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

/** Reads SSE data events from a response until `done` says so. */
async function readOutputs(response: Response, done: (outputs: AgentOutput[]) => boolean): Promise<{ outputs: AgentOutput[]; raw: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let outputs: AgentOutput[] = [];
  const deadline = Date.now() + 2000;
  while (!done(outputs)) {
    if (Date.now() > deadline) throw new Error(`timed out; got ${raw}`);
    const { value, done: ended } = await reader.read();
    if (ended) break;
    raw += decoder.decode(value, { stream: true });
    outputs = raw
      .split('\n\n')
      .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line): line is string => line !== undefined)
      .map((line) => JSON.parse(line.slice(6)) as AgentOutput);
  }
  await reader.cancel();
  return { outputs, raw };
}

const ended = (outputs: AgentOutput[]) => outputs.some((o) => o.type === 'turn_end');

describe('createHandler', () => {
  it('takes events and streams the turn they start', async () => {
    const { handler, model, scheduler } = setup([() => reply('把 http:// 去掉')]);
    const stream = await handler(new Request(`${BASE}/stream?sessionId=s1`));
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

    const accepted = await post(handler, {
      sessionId: 's1',
      events: [
        { type: 'perception', page: { path: '/datasource/new', title: '新建数据源' }, errors: [{ text: 'Invalid Host Format' }] },
        { type: 'user_message', content: '为什么连不上？' },
      ],
    });
    expect(accepted.status).toBe(204);

    const { outputs, raw } = await readOutputs(stream, ended);
    expect(raw.startsWith('retry: 3000\n')).toBe(true);
    expect(outputs.map((o) => o.type)).toEqual(['turn_start', 'status', ...[...'把 http:// 去掉'].map(() => 'text'), 'turn_end']);
    expect(JSON.stringify(model.requests[0]!.messages)).toContain('Invalid Host Format');
    expect(scheduler.active()).toBe(0);
  });

  it('rejects bad requests with a reason', async () => {
    const { handler } = setup([], { maxBodyBytes: 200 });
    const errors = async (response: Response) => [response.status, ((await response.json()) as { errors: string[] }).errors];

    expect(await errors(await post(handler, '{not json'))).toEqual([400, ['body: invalid JSON']]);
    expect(await errors(await post(handler, { sessionId: 's', events: [{ type: 'shout' }] }))).toEqual([
      400,
      ['events[0].type: expected user_message, perception, user_info or cancel'],
    ]);
    expect(await errors(await post(handler, { sessionId: 's', events: [{ type: 'user_message', content: 'x'.repeat(300) }] }))).toEqual([
      413,
      ['body: larger than 200 bytes'],
    ]);
    expect((await handler(new Request(`${BASE}/events`))).status).toBe(405);
    expect((await handler(new Request(`${BASE}/stream?sessionId=s`, { method: 'POST', body: '{}' }))).status).toBe(405);
    expect((await handler(new Request(`${BASE}/stream?sessionId=bad id`))).status).toBe(400);
    expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
    expect((await handler(new Request('http://test/elsewhere/events', { method: 'POST', body: '{}' }))).status).toBe(404);
  });

  it('unsubscribes when the client disconnects', async () => {
    const { handler, scheduler } = setup([() => reply('ok')]);
    const controller = new AbortController();
    const stream = await handler(new Request(`${BASE}/stream?sessionId=s`, { signal: controller.signal }));
    expect(scheduler.active()).toBe(1);
    controller.abort();
    expect(scheduler.active()).toBe(0);
    // The session keeps working without a listener.
    expect((await post(handler, { sessionId: 's', events: [{ type: 'user_message', content: 'hi' }] })).status).toBe(204);
    await scheduler.idle('s');
    expect(stream.body).not.toBeNull();
  });

  it('shows what the agent knows on the debug endpoint, only when enabled', async () => {
    const { handler } = setup([]);
    await post(handler, { sessionId: 's', events: [{ type: 'perception', page: { path: '/x', title: '页面 X' }, screen: '- button "保存"' }] });
    const body = (await (await handler(new Request(`${BASE}/debug?sessionId=s`))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ known: true, status: '页面：页面 X（/x）', screen: '- button "保存"', messages: 0 });
    const off = createHandler({ scheduler: setup([]).scheduler, basePath: '/doccue' });
    expect((await off(new Request(`${BASE}/debug?sessionId=s`))).status).toBe(404);
  });
});

describe('toNodeHandler', () => {
  async function serve(listener: http.RequestListener): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }

  it('serves events and the stream over a real HTTP server, also when mounted Express-style', async () => {
    const { handler } = setup([() => reply('一'), () => reply('二')]);
    const node = toNodeHandler(handler);
    // Express strips the mount path from req.url and keeps it in originalUrl.
    const server = await serve((req, res) => {
      const mounted = req as http.IncomingMessage & { originalUrl?: string };
      if (req.url?.startsWith('/express/')) {
        mounted.originalUrl = req.url.replace('/express', '');
        req.url = req.url.replace('/express/doccue', '');
      }
      void node(mounted, res);
    });
    try {
      for (const [prefix, question] of [['', '问一'], ['/express', '问二']] as const) {
        const stream = await fetch(`${server.origin}${prefix}/doccue/stream?sessionId=n1`);
        expect(stream.status).toBe(200);
        const accepted = await fetch(`${server.origin}${prefix}/doccue/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'n1', events: [{ type: 'user_message', content: question }] }),
        });
        expect(accepted.status).toBe(204);
        const { outputs } = await readOutputs(stream, ended);
        expect(outputs.at(-1)).toMatchObject({ type: 'turn_end', reason: 'completed' });
      }
    } finally {
      await server.close();
    }
  });
});
