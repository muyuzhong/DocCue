import type { Item, StreamEvent, TurnRequest } from '@doccue/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../src/bridge.js';
import { runGuide, type RunningGuide } from '../src/guide.js';
import { describeElement, findByLocator } from '../src/locate.js';
import { messagesFor } from '../src/messages.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const overlay = () => document.querySelector('[data-doccue-guide]')?.shadowRoot ?? undefined;
const bubbleText = () => overlay()?.querySelector('.text')?.textContent;
const bubbleShown = () => overlay()?.querySelector<HTMLElement>('.bubble')?.hidden === false;

const PAGE = `
  <h1>新建数据源</h1>
  <label for="host">主机地址</label><input id="host" />
  <button id="test">测试连接</button>`;

beforeEach(() => {
  sessionStorage.clear();
  document.title = '新建数据源';
  document.documentElement.lang = 'zh-CN';
  document.body.innerHTML = PAGE;
});

describe('runGuide', () => {
  let guide: RunningGuide | undefined;
  const start = (steps: Array<{ selector: string; text: string; expect?: 'ack' }>, waitMs = 150) =>
    (guide = runGuide({
      document,
      steps: steps.map(({ text, expect }, index) => ({ target: index + 1, text, ...(expect ? { expect } : {}) })),
      find: (index) => document.querySelector(steps[index]!.selector) ?? undefined,
      messages: messagesFor('zh-CN'),
      waitMs,
    }));
  afterEach(() => guide?.stop());

  it('shows each step and moves on when the user acts on its element', async () => {
    const running = start([
      { selector: '#host', text: '去掉 http://' },
      { selector: '#test', text: '再测一次' },
    ]);
    expect(bubbleText()).toBe('去掉 http://');
    expect(overlay()!.querySelector('.progress')!.textContent).toBe('1 / 2');
    expect(overlay()!.querySelector('.next')!.textContent).toBe('下一步');

    running.action($('h1')); // not an element of any step
    expect(bubbleText()).toBe('去掉 http://');
    running.action($('#host'));
    expect(bubbleText()).toBe('再测一次');
    expect(overlay()!.querySelector('.next')!.textContent).toBe('完成');
    running.action($('#test'));
    await expect(running.done).resolves.toEqual({ outcome: 'completed', completedSteps: 2 });
    expect(overlay()).toBeUndefined();
  });

  it('moves on with Next, waits for it on steps that only explain, and ends on Exit', async () => {
    const running = start([
      { selector: 'h1', text: '这里是新建页面', expect: 'ack' },
      { selector: '#host', text: '填主机地址' },
    ]);
    running.action($('h1'));
    expect(bubbleText()).toBe('这里是新建页面');
    overlay()!.querySelector<HTMLButtonElement>('.next')!.click();
    expect(bubbleText()).toBe('填主机地址');
    overlay()!.querySelector<HTMLButtonElement>('.exit')!.click();
    await expect(running.done).resolves.toEqual({ outcome: 'exited', completedSteps: 1 });
  });

  it('jumps ahead when the user does a later step first, and counts the ones in between as skipped', async () => {
    const running = start([
      { selector: 'h1', text: '这里是新建页面', expect: 'ack' },
      { selector: '#host', text: '填主机地址' },
      { selector: '#test', text: '再测一次' },
    ]);
    running.action($('#test'));
    await expect(running.done).resolves.toEqual({ outcome: 'completed', completedSteps: 3, skippedSteps: [2] });
  });

  it('continues from where a guide was and reports each move', async () => {
    const moves: unknown[] = [];
    guide = runGuide({
      document,
      steps: [{ target: 1, text: '填主机地址' }, { target: 2, text: '再测一次' }],
      find: (index) => [$('#host'), $('#test')][index],
      messages: messagesFor('en'),
      waitMs: 150,
      start: { completedSteps: 1, skippedSteps: [1] },
      onProgress: (progress) => moves.push(progress),
    });
    expect(bubbleText()).toBe('再测一次');
    expect(overlay()!.querySelector('.next')!.textContent).toBe('Done');
    guide.action($('#test'));
    expect(moves).toEqual([{ completedSteps: 2, skippedSteps: [1] }]);
  });

  it('reports steps passed with Next as skipped', async () => {
    const running = start([
      { selector: '#host', text: '填主机地址' },
      { selector: '#test', text: '再测一次' },
    ]);
    overlay()!.querySelector<HTMLButtonElement>('.next')!.click();
    running.action($('#test'));
    await expect(running.done).resolves.toEqual({ outcome: 'completed', completedSteps: 2, skippedSteps: [1] });
  });

  it('waits for an element to appear, and gives up when it stays away', async () => {
    const running = start([
      { selector: '#host', text: '填主机地址' },
      { selector: '#later', text: '点确定' },
      { selector: '#never', text: '不会出现' },
    ]);
    running.action($('#host'));
    expect(bubbleShown()).toBe(false);
    document.body.insertAdjacentHTML('beforeend', '<button id="later">确定</button>');
    await sleep(120);
    expect(bubbleShown()).toBe(true);
    expect(bubbleText()).toBe('点确定');
    running.action($('#later'));
    await expect(running.done).resolves.toEqual({ outcome: 'not_found', completedSteps: 2 });
  });

  it('reports the user going elsewhere when the current element disappears', async () => {
    const running = start([{ selector: '#host', text: '填主机地址' }]);
    document.body.innerHTML = '<h1>仪表盘</h1>';
    await expect(running.done).resolves.toEqual({ outcome: 'deviated', completedSteps: 0 });
  });

  it('stops from outside without an outcome of its own', async () => {
    const running = start([{ selector: '#host', text: '填主机地址' }]);
    expect(running.stop()).toEqual({ completedSteps: 0 });
    await expect(running.done).resolves.toBeUndefined();
  });
});

describe('findByLocator', () => {
  it('finds a control again after the page re-rendered it', () => {
    const locator = describeElement($('#test'))!;
    expect(locator).toEqual({ role: 'button', name: '测试连接' });
    document.body.innerHTML = PAGE;
    expect(findByLocator(document, locator)).toBe($('#test'));
    expect(findByLocator(document, describeElement($('h1'))!)).toBe($('h1'));
    expect(findByLocator(document, { role: 'button', name: '保存' })).toBeUndefined();
  });

  it('tells same-named controls apart by row, and prefers the host’s ID', () => {
    document.body.innerHTML = `
      <table><tbody>
        <tr><td>mysql-prod</td><td><button>删除</button></td></tr>
        <tr><td>pg-test</td><td><button id="second">删除</button></td></tr>
      </tbody></table>
      <button data-cue-id="toolbar.refresh" id="refresh">刷新</button>`;
    expect(findByLocator(document, { role: 'button', name: '删除', within: [{ kind: 'row', name: 'pg-test' }] })).toBe($('#second'));
    expect(findByLocator(document, { role: 'button', name: '改了名字', id: 'toolbar.refresh' })).toBe($('#refresh'));
  });
});

describe('createBridge with guides', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const model = (content: unknown): Item => ({ type: 'model', messages: [{ role: 'assistant', content }] });
  const sse = (events: StreamEvent[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
  /** The model's answers, in order: a guide pointing at [2] (the host field) and [3], then plain text. */
  const guideAnswer = (callId: string): StreamEvent[] => [
    { type: 'text', delta: '主机地址格式不对，我指给你看。' },
    { type: 'guide', callId, steps: [{ target: 2, text: '去掉 http://' }, { target: 3, text: '再测一次' }] },
    { type: 'end', reason: 'guide', item: model([{ type: 'tool_call', id: callId }]), usage },
  ];
  const textAnswer = (text: string): StreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'end', reason: 'completed', item: model([{ type: 'text', text }]), usage },
  ];

  const create = () => createBridge({ endpoint: '/doccue', resultWindowMs: 20, targetWaitMs: 150, settle: { quietMs: 20, maxMs: 200 } });
  /** Resolves when the bridge is done with the question it is working on. */
  const idle = (target: Bridge) =>
    new Promise<void>((resolve) => {
      if (!target.busy()) resolve();
      else target.on('state', (event) => !event.busy && resolve());
    });
  let bridge: Bridge;
  let posts: TurnRequest[];
  /** What each request gets, in order. `hang`: no answer until the request is aborted. */
  let answers: Array<StreamEvent[] | 'hang'>;
  const originalFetch = window.fetch;

  beforeEach(() => {
    posts = [];
    window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)) as TurnRequest);
      const answer = answers.shift()!;
      if (answer !== 'hang') return sse(answer);
      return new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    };
    bridge = create();
  });
  afterEach(() => {
    bridge.destroy();
    window.fetch = originalFetch;
  });

  it('runs the guide the model started and sends what the user did as its result', async () => {
    answers = [guideAnswer('g1'), textAnswer('连上了。')];
    const ended: unknown[] = [];
    bridge.on('guide_end', (event) => ended.push(event));
    const asked = bridge.ask('为什么连不上？');
    await sleep(20);
    expect(bubbleText()).toBe('去掉 http://');
    expect(posts).toHaveLength(1);

    const host = $<HTMLInputElement>('#host');
    host.value = '127.0.0.1';
    host.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bubbleText()).toBe('再测一次');
    $('#test').click();
    await asked;

    expect(overlay()).toBeUndefined();
    expect(ended).toEqual([{ type: 'guide_end', outcome: 'completed', completedSteps: 2 }]);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.conversation.map((item) => item.type)).toEqual(['user', 'model', 'guide_result']);
    const result = posts[1]!.conversation[2] as Extract<Item, { type: 'guide_result' }>;
    expect(result).toMatchObject({ callId: 'g1', result: { outcome: 'completed', completedSteps: 2 } });
    expect(result.result.perception.actions.map((entry) => entry.action)).toEqual([
      { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: '127.0.0.1' },
      { type: 'click', target: { role: 'button', name: '测试连接' } },
    ]);
    expect(result.result.perception.screen.nodes[1]).toMatchObject({ ref: 2, role: 'textbox', value: '127.0.0.1' });
    expect(bridge.conversation().map((item) => item.type)).toEqual(['user', 'model', 'guide_result', 'model']);
  });

  it('ends the guide as interrupted when the user asks something else', async () => {
    answers = [guideAnswer('g1'), textAnswer('只填 IP 或域名。')];
    const first = bridge.ask('为什么连不上？');
    await sleep(20);
    expect(bubbleShown()).toBe(true);
    await bridge.ask('主机地址该填什么？');
    await first;
    expect(overlay()).toBeUndefined();
    expect(posts[1]!.conversation.map((item) => item.type)).toEqual(['user', 'model', 'guide_result', 'user']);
    expect(posts[1]!.conversation[2]).toMatchObject({ callId: 'g1', result: { outcome: 'interrupted', completedSteps: 0 } });
  });

  it('keeps the result but asks nothing more when the user exits', async () => {
    answers = [guideAnswer('g1')];
    const asked = bridge.ask('为什么连不上？');
    await sleep(20);
    overlay()!.querySelector<HTMLButtonElement>('.exit')!.click();
    await asked;
    expect(posts).toHaveLength(1);
    expect(bridge.conversation().at(-1)).toMatchObject({ type: 'guide_result', result: { outcome: 'exited' } });
  });

  it('says when it is busy', async () => {
    answers = [guideAnswer('g1')];
    const states: boolean[] = [];
    bridge.on('state', (event) => states.push(event.busy));
    void bridge.ask('为什么连不上？');
    await sleep(20);
    expect(bridge.busy()).toBe(true);
    bridge.stop();
    expect(bridge.busy()).toBe(false);
    expect(states).toEqual([true, false]);
    expect(bridge.conversation().at(-1)).toMatchObject({ type: 'guide_result', result: { outcome: 'exited' } });
  });

  it('continues a guide on the next page after a full page load', async () => {
    answers = [guideAnswer('g1'), textAnswer('连上了。')];
    void bridge.ask('为什么连不上？');
    await sleep(20);
    const host = $<HTMLInputElement>('#host');
    host.value = '127.0.0.1';
    host.dispatchEvent(new Event('change', { bubbles: true }));
    expect(bubbleText()).toBe('再测一次');

    bridge.destroy(); // the page goes away with the guide on its second step
    document.body.innerHTML = PAGE;
    bridge = create();
    await sleep(20);
    expect(bubbleText()).toBe('再测一次');
    expect(overlay()!.querySelector('.progress')!.textContent).toBe('2 / 2');
    $('#test').click();
    await idle(bridge);

    expect(posts[1]!.conversation.map((item) => item.type)).toEqual(['user', 'model', 'guide_result']);
    expect(posts[1]!.conversation[2]).toMatchObject({ callId: 'g1', result: { outcome: 'completed', completedSteps: 2 } });
    expect(bridge.conversation().map((item) => item.type)).toEqual(['user', 'model', 'guide_result', 'model']);
  });

  it('reports a guide whose last step loaded a new page, and gets the answer still owed', async () => {
    answers = [guideAnswer('g1'), textAnswer('连上了。')];
    void bridge.ask('为什么连不上？');
    await sleep(20);
    $<HTMLInputElement>('#host').dispatchEvent(new Event('change', { bubbles: true }));
    $('#test').click(); // the last step: the guide is complete, and the page goes away at once
    bridge.destroy();
    expect(posts).toHaveLength(1);

    document.body.innerHTML = '<h1>数据源</h1>';
    bridge = create();
    await idle(bridge);
    expect(posts).toHaveLength(2);
    const result = posts[1]!.conversation[2] as Extract<Item, { type: 'guide_result' }>;
    expect(result).toMatchObject({ callId: 'g1', result: { outcome: 'completed', completedSteps: 2 } });
    expect(result.result.perception.screen.nodes).toEqual([{ ref: 1, role: 'heading', name: '数据源' }]);
  });

  it('asks again on the next page when the page went away before the answer came', async () => {
    answers = ['hang', textAnswer('好的。')];
    void bridge.ask('怎么新建数据源？');
    await sleep(20);
    bridge.destroy();
    bridge = create();
    await idle(bridge);
    expect(posts[1]!.conversation).toEqual(posts[0]!.conversation);
    expect(bridge.conversation().map((item) => item.type)).toEqual(['user', 'model']);
    // Nothing is owed any more: a third page asks nothing.
    bridge.destroy();
    bridge = create();
    await sleep(20);
    expect(posts).toHaveLength(2);
  });
});
