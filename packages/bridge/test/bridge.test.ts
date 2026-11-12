import type { StreamEvent, TurnRequest } from '@doccue/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../src/bridge.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): StreamEvent[] => [
  { type: 'status', state: 'thinking' },
  { type: 'text', delta: text },
  { type: 'end', reason: 'completed', item: { type: 'model', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] }, usage },
];
const sse = (events: StreamEvent[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

let posts: Array<{ url: string; body: TurnRequest }>;
let respond: (init?: RequestInit) => Promise<Response>;
let bridge: Bridge | undefined;
const originalFetch = window.fetch;

beforeEach(() => {
  posts = [];
  respond = async () => sse(answer('去掉 http://'));
  sessionStorage.clear();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) as TurnRequest });
    return respond(init);
  };
  document.title = '新建数据源';
  document.documentElement.lang = 'zh-CN';
  document.body.innerHTML = `
    <label for="host">主机地址</label><input id="host" />
    <button id="test">测试连接</button>
    <div data-cue-ignore><input id="question" /></div>`;
});

afterEach(() => {
  bridge?.destroy();
  window.fetch = originalFetch;
});

function act() {
  const host = document.querySelector<HTMLInputElement>('#host')!;
  host.value = 'http://127.0.0.1:5432';
  host.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector<HTMLButtonElement>('#test')!.click();
}

describe('createBridge', () => {
  it('keeps actions locally and sends them once, with the screen and the question', async () => {
    bridge = createBridge({ endpoint: '/doccue/', user: { role: '新手' }, resultWindowMs: 20 });
    act();
    expect(posts).toEqual([]); // nothing leaves the browser before a question
    await sleep(40);
    expect(bridge.recorded().map((entry) => entry.action?.type)).toEqual(['input', 'click']);

    const deltas: string[] = [];
    bridge.on('text', (event) => deltas.push(event.delta));
    await bridge.ask('为什么连不上？');
    expect(deltas).toEqual(['去掉 http://']);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/doccue/turn');
    const { v, locale, user, conversation } = posts[0]!.body;
    expect({ v, locale, user }).toEqual({ v: 1, locale: 'zh-CN', user: { role: '新手' } });
    expect(conversation).toHaveLength(1);
    const first = conversation[0] as Extract<TurnRequest['conversation'][number], { type: 'user' }>;
    expect(first.text).toBe('为什么连不上？');
    expect(first.perception.actions.map((entry) => entry.action)).toEqual([
      { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: 'http://127.0.0.1:5432' },
      { type: 'click', target: { role: 'button', name: '测试连接' } },
    ]);
    expect(first.perception.screen).toEqual({
      page: { path: '/', title: '新建数据源' },
      nodes: [
        { ref: 1, role: 'textbox', name: '主机地址', value: 'http://127.0.0.1:5432' },
        { ref: 2, role: 'button', name: '测试连接' },
      ],
    });

    // The next request carries the whole conversation; actions already sent are not repeated.
    await bridge.ask('还有别的原因吗？');
    expect(posts[1]!.body.conversation.map((item) => item.type)).toEqual(['user', 'model', 'user']);
    expect(posts[1]!.body.conversation[0]).toEqual(first);
    expect((posts[1]!.body.conversation[2] as typeof first).perception.actions).toEqual([]);
    expect(bridge.conversation().map((item) => item.type)).toEqual(['user', 'model', 'user', 'model']);
  });

  it('keeps the conversation and unsent actions across reloads, until reset', async () => {
    const first = createBridge({ endpoint: '/doccue', resultWindowMs: 10 });
    await first.ask('你好');
    document.querySelector<HTMLButtonElement>('#test')!.click();
    await sleep(30);
    first.destroy();

    bridge = createBridge({ endpoint: '/doccue', resultWindowMs: 10 });
    expect(bridge.conversation().map((item) => item.type)).toEqual(['user', 'model']);
    expect(bridge.perceive().actions.map((entry) => entry.action?.target)).toEqual([{ role: 'button', name: '测试连接' }]);
    bridge.reset();
    expect(bridge.conversation()).toEqual([]);
  });

  it('stops the answer in progress and reports failed requests', async () => {
    bridge = createBridge({ endpoint: '/doccue' });
    respond = (init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = bridge.ask('你好');
    await sleep(10);
    bridge.stop();
    await expect(pending).resolves.toBeUndefined();

    respond = async () => new Response(JSON.stringify({ errors: ['v: expected 1'] }), { status: 400 });
    await expect(bridge.ask('再问一次')).rejects.toThrow('DocCue 400: v: expected 1');
  });
});
