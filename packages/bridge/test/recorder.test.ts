import type { TimelineEntry } from '@doccue/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ERROR_SELECTORS } from '../src/errors.js';
import { createRecorder, type Recorder } from '../src/recorder.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

let recorder: Recorder | undefined;
let entries: TimelineEntry[];
const originalFetch = window.fetch;

let acted: Element[];

function start(windowMs = 60) {
  entries = [];
  acted = [];
  recorder = createRecorder({
    onAction: (element) => acted.push(element),
    document,
    errorSelectors: DEFAULT_ERROR_SELECTORS,
    resultWindowMs: windowMs,
    captureNetwork: true,
    skipUrl: (url) => url.includes('/doccue/'),
    onEntry: (entry) => entries.push(entry),
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
      {
        at: expect.any(Number),
        action: { type: 'click', target: { role: 'button', name: '测试连接' } },
        effects: [{ type: 'error', text: 'Invalid Host Format', target: { role: 'textbox', name: '主机地址' } }],
      },
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
    // Clicking into a field is not an action of its own...
    host.click();
    // ...unless it takes no typing, like a date picker's read-only input: the click is what opens it.
    document.body.insertAdjacentHTML('beforeend', '<label for="due">预定日期</label><input id="due" readonly /><label for="done">完成日期</label><input id="done" inputmode="none" />');
    $('#due').click();
    $('#done').click();
    await sleep(50);
    expect(entries.map((entry) => entry.action)).toEqual([
      { type: 'input', target: { role: 'textbox', name: '主机地址' }, value: 'http://127.0.0.1:5432' },
      { type: 'input', target: { role: 'textbox', name: '密码' } },
      { type: 'select', target: { role: 'combobox', name: '类型' }, value: 'PostgreSQL' },
      { type: 'check', target: { role: 'checkbox', name: '使用 SSL' } },
      { type: 'click', target: { role: 'textbox', name: '预定日期' } },
      { type: 'click', target: { role: 'textbox', name: '完成日期' } },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('notes page changes, as the effect of a click or on their own', async () => {
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
    expect(entries.map(({ action, effects }) => ({ action, effects }))).toEqual([
      { action: { type: 'click', target: { role: 'link', name: '数据源列表' } }, effects: [{ type: 'navigate', page: { path: '/datasource', title: '数据源列表' } }] },
      { action: undefined, effects: [{ type: 'navigate', page: { path: '/dashboard', title: '仪表盘' } }] },
    ]);
  });

  it('keeps a page change with the click that caused it, even when the next action is quick', async () => {
    start();
    $('#list').addEventListener('click', (event) => {
      event.preventDefault();
      history.pushState({}, '', '/datasource');
      setTimeout(() => (document.title = '数据源列表'), 20);
    });
    $('#list').click();
    const host = $<HTMLInputElement>('#host');
    host.value = '127.0.0.1';
    change(host);
    await sleep(150);
    // The title wasn't set yet when the click's record closed, so only the path is known.
    expect(entries.map(({ action, effects }) => ({ type: action?.type, effects }))).toEqual([
      { type: 'click', effects: [{ type: 'navigate', page: { path: '/datasource' } }] },
      { type: 'input', effects: undefined },
    ]);
  });

  it('reports failed requests with the server message, but not the bridge’s own', async () => {
    window.fetch = async (input: RequestInfo | URL) =>
      String(input).includes('/doccue/')
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ message: 'connection refused' }), { status: 500 });
    start();
    $('#test').addEventListener('click', () => {
      void fetch('/api/test-connection', { method: 'POST' });
      void fetch('/doccue/turn', { method: 'POST' });
    });
    $('#test').click();
    await sleep(120);
    expect(entries.map((entry) => entry.effects)).toEqual([
      [{ type: 'request_failed', method: 'POST', path: '/api/test-connection', status: 500, message: 'connection refused' }],
    ]);
  });

  it('records picking from a custom dropdown as one select on the dropdown, by click or Enter', async () => {
    // react-select's markup: the input controls a list rendered elsewhere (a portal).
    document.body.innerHTML = `
      <label for="scenario">场景</label>
      <div><div class="single-value">Random Walk</div><input id="scenario" role="combobox" aria-expanded="true" aria-controls="menu" /></div>
      <div id="portal"><div role="listbox" id="menu">
        <div role="option" id="o1">Random Walk</div><div role="option" id="o2"><span>CSV Metric Values</span></div>
      </div></div>`;
    start(20);
    $('#o2 span').click();
    await sleep(40);
    expect(entries.map((entry) => entry.action)).toEqual([{ type: 'select', target: { role: 'combobox', name: '场景' }, value: 'CSV Metric Values' }]);
    // A guide step on the dropdown or on the option itself counts as done.
    expect(acted).toEqual([$('#scenario'), $('#o2')]);

    $('#scenario').setAttribute('aria-activedescendant', 'o1');
    $('#scenario').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(40);
    expect(entries.at(-1)!.action).toEqual({ type: 'select', target: { role: 'combobox', name: '场景' }, value: 'Random Walk' });
  });

  it('ignores the assistant’s own UI and finishes the open action on flush', () => {
    start(10_000);
    $('#chat').click();
    expect(entries).toEqual([]);
    $('#test').click();
    expect(entries).toEqual([]);
    recorder!.flush();
    expect(entries.map((entry) => entry.action)).toEqual([{ type: 'click', target: { role: 'button', name: '测试连接' } }]);
  });
});
