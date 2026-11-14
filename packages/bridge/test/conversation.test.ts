import type { Item } from '@doccue/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, fitConversation, type Bridge, type BridgeEvent } from '../src/bridge.js';

const perception = { at: 1, screen: { page: { path: '/' }, nodes: [] }, actions: [] };
const question = (text: string): Item => ({ type: 'user', text, perception });
const answer = (text: string): Item => ({ type: 'model', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
const guided: Item = { type: 'model', messages: [{ role: 'assistant', content: [{ type: 'tool_call', id: 'g1', name: 'guide', args: {}, rawArgs: '{}' }] }] };
const result: Item = { type: 'guide_result', callId: 'g1', result: { outcome: 'completed', completedSteps: 1, perception } };

describe('fitConversation', () => {
  const items = [question('一'.repeat(300)), answer('a'), question('二'), guided, result, answer('b'), question('三'), answer('c')];

  it('leaves a conversation that fits as it is', () => {
    expect(fitConversation(items, 100_000)).toBe(items);
  });

  it('drops the oldest exchanges first, whole, so a guide call keeps its result', () => {
    const fitted = fitConversation(items, JSON.stringify(items.slice(2)).length);
    expect(fitted).toEqual(items.slice(2));
    expect(fitted[0]).toEqual(question('二'));
    expect(fitConversation(items, JSON.stringify(items.slice(2)).length - 1)).toEqual(items.slice(6));
  });

  it('always keeps the latest exchange', () => {
    expect(fitConversation(items, 10)).toEqual([question('三'), answer('c')]);
  });
});

describe('failures', () => {
  let bridge: Bridge;
  let errors: Array<Extract<BridgeEvent, { type: 'error' }>>;

  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<h1>仪表盘</h1>';
  });
  afterEach(() => bridge.destroy());

  const create = (endpoint: string) => {
    bridge = createBridge({ endpoint, maxQuestionChars: 10 });
    errors = [];
    bridge.on('error', (event) => errors.push(event));
  };

  it('turns away a question that is too long, before sending anything', async () => {
    create('/doccue');
    await expect(bridge.ask('这个问题超过了十个字的上限')).rejects.toThrow('longer than 10 characters');
    expect(errors).toEqual([{ type: 'error', message: 'DocCue: the question is longer than 10 characters' }]);
    expect(bridge.conversation()).toEqual([]);
    expect(bridge.busy()).toBe(false);
  });

  it('reports a backend it cannot reach', async () => {
    // Nothing listens on port 9 of this machine.
    create('http://127.0.0.1:9/doccue');
    const states: boolean[] = [];
    bridge.on('state', (event) => states.push(event.busy));
    await expect(bridge.ask('你好')).rejects.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.status).toBeUndefined();
    expect(states).toEqual([true, false]);
  });
});

describe('full page loads', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState({}, '', '/settings/notifications');
    document.body.innerHTML = '<form><label for="email">通知邮箱</label><input id="email" /><button type="button" id="save">保存</button></form>';
  });

  it('keeps a click that loads a new page, and notes where it led', async () => {
    const first = createBridge({ endpoint: '/doccue', resultWindowMs: 10_000 });
    document.querySelector<HTMLButtonElement>('#save')!.click();
    // The form posts and the browser leaves the page before the click's effects could be seen.
    window.dispatchEvent(new Event('pagehide'));
    first.destroy();

    history.replaceState({}, '', '/settings');
    document.body.innerHTML = '<h1>设置</h1><p role="status">已保存</p>';
    const second = createBridge({ endpoint: '/doccue' });
    expect(second.recorded()).toEqual([
      { at: expect.any(Number), action: { type: 'click', target: { role: 'button', name: '保存' } }, effects: [{ type: 'navigate', page: { path: '/settings' } }] },
    ]);
    second.destroy();
  });

  it('notes nothing when the same page is loaded again', () => {
    const first = createBridge({ endpoint: '/doccue' });
    window.dispatchEvent(new Event('pagehide'));
    first.destroy();
    const second = createBridge({ endpoint: '/doccue' });
    expect(second.recorded()).toEqual([]);
    second.destroy();
  });
});

describe('leaving the page while an answer is on its way', () => {
  it('does not take the cut-off request for a failure, so the next page asks again', async () => {
    const { createServer } = await import('node:http');
    const bodies: string[] = [];
    let cut: () => void = () => {};
    const server = createServer((req, res) => {
      // The page and the server are on different origins here: answer the preflight.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        if (bodies.length === 1) cut = () => req.socket.destroy(); // the browser drops it on the way out
        else res.writeHead(503).end(); // enough to see the request came
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/doccue`;
    try {
      sessionStorage.clear();
      document.body.innerHTML = '<h1>仪表盘</h1>';
      const first = createBridge({ endpoint });
      const failures: unknown[] = [];
      first.on('error', (event) => failures.push(event));
      const asked = first.ask('数据平台能接入哪些数据库？').catch(() => {});
      while (bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));

      window.dispatchEvent(new Event('pagehide'));
      cut();
      await asked;
      expect(failures).toEqual([]);
      first.destroy();

      const second = createBridge({ endpoint });
      while (bodies.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(JSON.parse(bodies[1]!).conversation).toEqual(JSON.parse(bodies[0]!).conversation);
      second.destroy();
    } finally {
      server.close();
    }
  });
});
