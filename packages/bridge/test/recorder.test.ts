import type { PageInfo, TimelineEntry } from '@doccue/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_SELECTORS } from '../src/errors.js';
import { createRecorder, type Recorder } from '../src/recorder.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

let recorder: Recorder | undefined;
let entries: TimelineEntry[];
let pages: PageInfo[];
const originalFetch = window.fetch;

function start(windowMs = 60) {
  entries = [];
  pages = [];
  recorder = createRecorder({
    document,
    errorSelectors: DEFAULT_ERROR_SELECTORS,
    resultWindowMs: windowMs,
    captureNetwork: true,
    skipUrl: (url) => url.includes('/doccue/'),
    onEntry: (entry) => entries.push(entry),
    onPage: (page) => pages.push(page),
  });
}

function change(element: HTMLElement) {
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.title = '新建数据源';
  document.body.innerHTML = `
    <div class="field"><label for="host">主机地址</label><input id="host" /><p class="err" role="alert" hidden></p></div>
    <label for="pw">密码</label><input id="pw" type="password" />
    <label for="kind">类型</label><select id="kind"><option>MySQL</option><option>PostgreSQL</option></select>
    <label><input id="ssl" type="checkbox" /> 使用 SSL</label>
    <button id="test">测试连接</button>
    <a id="list" href="/datasource">数据源列表</a>
    <div data-cue-ignore><button id="chat">发送</button></div>`;
});

afterEach(() => {
  recorder?.stop();
  window.fetch = originalFetch;
});

describe('createRecorder', () => {
  it('pairs an action with the error it caused', async () => {
    start();
    $('#test').addEventListener('click', () => {
      const error = $('.err');
      error.textContent = 'Invalid Host Format';
      error.hidden = false;
    });
    $('#test').click();
    await sleep(120);
    expect(entries).toEqual([
      { at: expect.any(Number), page: '/', kind: 'click', target: '按钮「测试连接」', result: '出现报错「Invalid Host Format」（输入框「主机地址」）' },
    ]);
  });

  it('records final values of fields, but never a password', async () => {
    start(10);
    const host = $<HTMLInputElement>('#host');
    host.value = 'http://127.0.0.1:5432';
    change(host);
    const pw = $<HTMLInputElement>('#pw');
    pw.value = 'secret';
    change(pw);
    const kind = $<HTMLSelectElement>('#kind');
    kind.selectedIndex = 1;
    change(kind);
    const ssl = $<HTMLInputElement>('#ssl');
    ssl.checked = true;
    change(ssl);
    // Clicking into a field is not an action of its own.
    host.click();
    await sleep(50);
    expect(entries.map(({ kind, target, value }) => ({ kind, target, value }))).toEqual([
      { kind: 'input', target: '输入框「主机地址」', value: 'http://127.0.0.1:5432' },
      { kind: 'input', target: '密码框「密码」', value: undefined },
      { kind: 'select', target: '下拉框「类型」', value: 'PostgreSQL' },
      { kind: 'check', target: '复选框「使用 SSL」', value: undefined },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('notes page changes, as the result of a click or on their own', async () => {
    start();
    $('#list').addEventListener('click', (event) => {
      event.preventDefault();
      document.title = '数据源列表';
      history.pushState({}, '', '/datasource');
    });
    $('#list').click();
    await sleep(150);
    history.pushState({}, '', '/dashboard');
    document.title = '仪表盘';
    await sleep(100);
    expect(entries.map(({ kind, target, result }) => ({ kind, target, result }))).toEqual([
      { kind: 'click', target: '链接「数据源列表」', result: '进入页面「数据源列表」' },
      { kind: 'navigate', target: '仪表盘', result: undefined },
    ]);
    expect(pages.map((page) => page.path)).toEqual(['/datasource', '/dashboard']);
  });

  it('reports failed requests with the server message, but not the bridge’s own', async () => {
    window.fetch = async (input: RequestInfo | URL) =>
      String(input).includes('/doccue/')
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ message: 'connection refused' }), { status: 500 });
    start();
    $('#test').addEventListener('click', () => {
      void fetch('/api/test-connection', { method: 'POST' });
      void fetch('/doccue/events', { method: 'POST' });
    });
    $('#test').click();
    await sleep(120);
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'click', result: '接口 POST /api/test-connection 返回 500：connection refused' }),
    ]);
  });

  it('ignores the assistant’s own UI and finishes the open action on flush', () => {
    start(10_000);
    $('#chat').click();
    expect(entries).toEqual([]);
    $('#test').click();
    expect(entries).toEqual([]);
    recorder!.flush();
    expect(entries).toEqual([expect.objectContaining({ kind: 'click', target: '按钮「测试连接」' })]);
  });
});
