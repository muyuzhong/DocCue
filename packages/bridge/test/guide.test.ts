import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('puts the spotlight on the label of a control the page hides to draw its own', async () => {
    document.body.innerHTML = `
      <ul><li><input id="d7" type="checkbox" style="opacity: 0" /><label for="d7" id="d7-label">最近 7 天</label></li></ul>
      <p><input id="sliver" type="radio" /><label for="sliver" id="sliver-label">每天</label></p>`;
    $('#d7').getBoundingClientRect = () => new DOMRect(300, 100, 0, 13);
    $('#d7-label').getBoundingClientRect = () => new DOMRect(100, 90, 200, 38);
    $('#sliver').getBoundingClientRect = () => new DOMRect(300, 200, 1, 1);
    $('#sliver-label').getBoundingClientRect = () => new DOMRect(100, 190, 80, 30);
    const spot = () => overlay()!.querySelector<HTMLElement>('.spot')!.style;
    const running = start([
      { selector: '#d7', text: '选最近 7 天' },
      { selector: '#sliver', text: '选每天' },
    ]);
    expect([spot().left, spot().top, spot().width]).toEqual(['96px', '86px', '208px']);
    // Done when the control itself changes, as clicking its label does.
    running.action($('#d7'));
    expect(bubbleText()).toBe('选每天');
    expect([spot().left, spot().top, spot().width]).toEqual(['96px', '186px', '88px']);
  });

  it('scrolls a step into view, also inside a list that clips it', () => {
    document.body.innerHTML = `<ul style="height: 40px; overflow: auto"><li>a</li><li><button id="far">最近 7 天</button></li></ul><button id="low">保存</button>`;
    const far = $('#far');
    const low = $('#low');
    far.getBoundingClientRect = () => new DOMRect(100, 20, 80, 30);
    low.getBoundingClientRect = () => new DOMRect(100, 5000, 80, 30);
    far.scrollIntoView = vi.fn();
    low.scrollIntoView = vi.fn();
    const running = start([
      { selector: '#far', text: '选最近 7 天' },
      { selector: '#low', text: '保存' },
    ]);
    // In the window but maybe clipped by its list: the least scrolling that shows it.
    expect(far.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    running.action(far);
    // Below the window: to the middle.
    expect(low.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });

  it('completes a step on something that is no control when the user clicks it', async () => {
    document.body.innerHTML = `
      <section id="panel"><h2 id="title"><span>CPU</span></h2><div class="chart"></div></section>
      <section id="card"><h2>Memory</h2><button id="menu">菜单</button></section>`;
    const running = start([
      { selector: '#title', text: '点 CPU 面板的标题' },
      { selector: '#card', text: '在这张卡片上打开菜单' },
    ]);
    $('#title span').click();
    expect(bubbleText()).toBe('在这张卡片上打开菜单');
    // A target that holds controls waits for one of them, as recorded: a click on its blank part is not it.
    $('#card h2').click();
    expect(bubbleText()).toBe('在这张卡片上打开菜单');
    running.action($('#menu'));
    await expect(running.done).resolves.toEqual({ outcome: 'completed', completedSteps: 2 });
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

  it('finds groups again too: forms, navigation, dialogs, lists', () => {
    const markup = `
      <nav aria-label="主菜单"><a href="/a">数据源</a></nav>
      <form aria-label="连接信息"><input aria-label="主机地址" /></form>
      <div role="dialog" aria-label="删除数据源"><button>确定</button></div>
      <ul aria-label="最近打开"><li>报表 1</li></ul>
      <table><tbody><tr><td>mysql-prod</td></tr></tbody></table>`;
    document.body.innerHTML = markup;
    const locators = ['nav', 'form', '[role="dialog"]', 'ul'].map((selector) => describeElement($(selector))!);
    expect(locators).toEqual([
      { role: 'navigation', name: '主菜单' },
      { role: 'form', name: '连接信息' },
      { role: 'dialog', name: '删除数据源' },
      { role: 'list', name: '最近打开' },
    ]);
    expect(describeElement($('tr'))).toBeUndefined(); // a row has no name to find it by
    document.body.innerHTML = markup; // re-rendered: new elements
    expect(locators.map((locator) => findByLocator(document, locator))).toEqual([$('nav'), $('form'), $('[role="dialog"]'), $('ul')]);
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
