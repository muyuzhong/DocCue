import type { AgentOutput, InputEvent } from '@doccue/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../src/bridge.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  emit(output: AgentOutput) {
    this.onmessage?.({ data: JSON.stringify(output) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

let posts: Array<{ url: string; body: { sessionId: string; events: InputEvent[] } }>;
let bridge: Bridge | undefined;
const originalFetch = window.fetch;
const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  posts = [];
  sessionStorage.clear();
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  };
  document.title = '新建数据源';
  document.body.innerHTML = `
    <label for="host">主机地址</label><input id="host" />
    <button id="test">测试连接</button>
    <div data-cue-ignore><input id="question" /></div>`;
});

afterEach(() => {
  bridge?.destroy();
  window.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

describe('createBridge', () => {
  it('keeps actions locally and sends them with the question, once', async () => {
    bridge = createBridge({ endpoint: '/doccue/', user: { attributes: { role: '新手' } }, resultWindowMs: 20 });
    expect(FakeEventSource.last!.url).toBe(`/doccue/stream?sessionId=${encodeURIComponent(bridge.sessionId)}`);
    const host = document.querySelector<HTMLInputElement>('#host')!;
    host.value = 'http://127.0.0.1:5432';
    host.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector<HTMLButtonElement>('#test')!.click();
    expect(posts).toEqual([]); // nothing leaves the browser before a question
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(bridge.recorded().map((entry) => entry.kind)).toEqual(['input', 'click']);

    await bridge.ask('为什么连不上？');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('/doccue/events');
    const { sessionId, events } = posts[0]!.body;
    expect(sessionId).toBe(bridge.sessionId);
    expect(events.map((event) => event.type)).toEqual(['user_info', 'perception', 'user_message']);
    const perception = events[1] as Extract<InputEvent, { type: 'perception' }>;
    expect(perception.timeline?.map((entry) => [entry.kind, entry.target, entry.value])).toEqual([
      ['input', '输入框「主机地址」', 'http://127.0.0.1:5432'],
      ['click', '按钮「测试连接」', undefined],
    ]);
    expect(perception.page).toEqual({ path: '/', title: '新建数据源' });
    expect(perception.screen).toContain('[1] 输入框「主机地址」: "http://127.0.0.1:5432"');
    expect(perception.screen).not.toContain('question');
    expect(events[2]).toEqual({ type: 'user_message', content: '为什么连不上？' });

    // A second question without new actions sends no timeline and no user info.
    await bridge.ask('还有别的原因吗？');
    expect(posts[1]!.body.events.map((event) => event.type)).toEqual(['perception', 'user_message']);
    expect((posts[1]!.body.events[0] as Extract<InputEvent, { type: 'perception' }>).timeline).toBeUndefined();
  });

  it('keeps one session per tab and unsent actions across reloads', async () => {
    const first = createBridge({ endpoint: '/doccue', resultWindowMs: 10 });
    document.querySelector<HTMLButtonElement>('#test')!.click();
    await sleep(30);
    first.destroy();
    bridge = createBridge({ endpoint: '/doccue', resultWindowMs: 10 });
    expect(bridge.sessionId).toBe(first.sessionId);
    expect(bridge.snapshot().timeline.map((entry) => entry.target)).toEqual(['按钮「测试连接」']);
  });

  it('passes outputs to listeners and sends cancel', async () => {
    bridge = createBridge({ endpoint: '/doccue' });
    const outputs: AgentOutput[] = [];
    const off = bridge.onOutput((output) => outputs.push(output));
    FakeEventSource.last!.emit({ type: 'text', turnId: 't', delta: '你好' });
    off();
    FakeEventSource.last!.emit({ type: 'text', turnId: 't', delta: '没人听' });
    expect(outputs).toEqual([{ type: 'text', turnId: 't', delta: '你好' }]);
    await bridge.cancel();
    expect(posts.at(-1)!.body.events).toEqual([{ type: 'cancel' }]);
  });
});
