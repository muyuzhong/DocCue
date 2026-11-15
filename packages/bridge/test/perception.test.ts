import type { ScreenNode } from '@doccue/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectErrors, DEFAULT_ERROR_SELECTORS } from '../src/errors.js';
import { accessibleName, findControl, isInteractive, locatorOf, roleOf } from '../src/naming.js';
import { buildScreen } from '../src/screen.js';

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

beforeEach(() => {
  document.title = '新建数据源';
  document.body.innerHTML = '';
});

describe('naming', () => {
  it('names controls the way a screen reader would', () => {
    document.body.innerHTML = `
      <label for="host">主机地址</label><input id="host" />
      <label>数据库类型 <select id="kind"><option>MySQL</option><option selected>PostgreSQL</option></select></label>
      <input id="port" placeholder="端口，例如 5432" />
      <span id="pw-label">密码</span><input id="pw" type="password" aria-labelledby="pw-label" />
      <button id="test"><span>测试</span><span>连接</span></button>
      <button id="close" aria-label="关闭"><svg></svg></button>
      <input id="submit" type="submit" value="保存" />
      <div id="custom" role="button" title="更多"></div>
      <input id="cue" name="timeout" data-cue-id="datasource.timeout" />`;
    expect(['host', 'kind', 'port', 'pw', 'test', 'close', 'submit', 'custom', 'cue'].map((id) => accessibleName($(`#${id}`)))).toEqual([
      '主机地址',
      '数据库类型',
      '端口，例如 5432',
      '密码',
      '测试连接',
      '关闭',
      '保存',
      '更多',
      'timeout',
    ]);
    expect(['host', 'kind', 'pw', 'test', 'submit', 'custom'].map((id) => roleOf($(`#${id}`)))).toEqual(['textbox', 'combobox', 'textbox', 'button', 'button', 'button']);
    // The host's ID is an identity, not a name: it goes into the locator.
    expect(locatorOf($('#cue'))).toEqual({ role: 'textbox', name: 'timeout', id: 'datasource.timeout' });
  });

  it("keeps a label's block parts apart", () => {
    document.body.innerHTML = `<label for="limit"><div>限制</div><div class="description">默认情况下显示的项目数量</div></label><input id="limit" />`;
    expect(accessibleName($('#limit'))).toBe('限制 默认情况下显示的项目数量');
  });

  it('adds the dialog, and the row or section when a name is not unique', () => {
    document.body.innerHTML = `
      <table><tbody>
        <tr><td>mysql-prod</td><td><button class="del">删除</button></td></tr>
        <tr><td>pg-test</td><td><button class="del">删除</button></td></tr>
      </tbody></table>
      <section><h2>基本信息</h2><button class="edit">编辑</button></section>
      <section><h2>高级设置</h2><button class="edit">编辑</button></section>
      <div role="dialog" aria-labelledby="d-title"><h3 id="d-title">删除数据源</h3><button id="ok">确定</button></div>`;
    const [first, second] = Array.from(document.querySelectorAll('.del'));
    expect(locatorOf(first!)).toEqual({ role: 'button', name: '删除', within: [{ kind: 'row', name: 'mysql-prod' }] });
    expect(locatorOf(second!)).toEqual({ role: 'button', name: '删除', within: [{ kind: 'row', name: 'pg-test' }] });
    expect(locatorOf(document.querySelectorAll('.edit')[1]!)).toEqual({ role: 'button', name: '编辑', within: [{ kind: 'section', name: '高级设置' }] });
    expect(locatorOf($('#ok'))).toEqual({ role: 'button', name: '确定', within: [{ kind: 'dialog', name: '删除数据源' }] });
  });

  it('finds the control from a click on something inside it', () => {
    document.body.innerHTML = '<button id="b"><span id="inner">保存</span></button><div id="plain">文字</div>';
    let found: Element | undefined;
    document.addEventListener('click', (event) => (found = findControl(event)), { once: true });
    $('#inner').click();
    expect(found?.id).toBe('b');
    let none: Element | undefined = $('#b');
    document.addEventListener('click', (event) => (none = findControl(event)), { once: true });
    $('#plain').click();
    expect(none).toBeUndefined();
  });

  it('takes a tabindex alone for a control only on something clickable that holds no controls', () => {
    document.body.innerHTML = `
      <div id="panel" tabindex="0" style="cursor:pointer"><span id="text">说明文字</span><button>保存</button></div>
      <pre id="code" tabindex="0">SELECT 1;</pre>
      <div id="region" role="region" tabindex="0" style="cursor:pointer">滚动区</div>
      <div id="sentinel" tabindex="0"></div>
      <div id="fake" tabindex="0" style="cursor:pointer">更多</div>`;
    expect(['panel', 'code', 'region', 'sentinel', 'fake'].map((id) => isInteractive($(`#${id}`)))).toEqual([false, false, false, false, true]);
    // A click on the text of a container is not a click on the container.
    let found: Element | undefined = $('#panel');
    document.addEventListener('click', (event) => (found = findControl(event)), { once: true });
    $('#text').click();
    expect(found).toBeUndefined();
  });
});

describe('errors', () => {
  it('collects visible errors, tied to their fields, and skips ignored regions', () => {
    document.body.innerHTML = `
      <div class="field"><label for="host">主机地址</label><input id="host" aria-describedby="host-err" /><p id="host-err" role="alert">Invalid Host Format</p></div>
      <div class="field"><label for="port">端口</label><input id="port" aria-invalid="true" /></div>
      <div class="field"><label for="name">名称</label><input id="name" /><span class="invalid-feedback">不能为空</span></div>
      <p role="alert" style="display:none">hidden error</p>
      <div data-cue-ignore><p role="alert">chat panel error</p></div>`;
    expect(collectErrors(document, DEFAULT_ERROR_SELECTORS)).toEqual([
      { text: 'Invalid Host Format', target: { role: 'textbox', name: '主机地址' } },
      { text: '不能为空', target: { role: 'textbox', name: '名称' } },
    ]);
  });
});

describe('buildScreen', () => {
  it('outlines headings, groups, controls with values, errors and text', () => {
    document.body.innerHTML = `
      <nav aria-label="主菜单"><a href="/datasource">数据源</a></nav>
      <h1>新建数据源</h1>
      <form aria-label="连接信息">
        <label for="host">主机地址</label><input id="host" value="http://127.0.0.1:5432" aria-invalid="true" />
        <p role="alert">Invalid Host Format</p>
        <label for="pw">密码</label><input id="pw" type="password" value="secret" />
        <label><input type="checkbox" checked /> 使用 SSL</label>
        <button type="button">测试连接</button>
        <button type="submit" disabled>保存</button>
      </form>
      <p>主机地址只填 IP 或域名。</p>
      <div role="status">已保存草稿</div>
      <div style="display:none"><button>隐藏按钮</button></div>
      <div data-cue-ignore><button>问答框</button></div>`;
    const { screen, elements } = buildScreen(document, { errorSelectors: DEFAULT_ERROR_SELECTORS });
    expect(screen).toEqual({
      page: { path: expect.any(String), title: '新建数据源' },
      nodes: [
        { ref: 1, role: 'navigation', name: '主菜单', children: [{ ref: 2, role: 'link', name: '数据源' }] },
        { ref: 3, role: 'heading', name: '新建数据源' },
        {
          ref: 4,
          role: 'form',
          name: '连接信息',
          children: [
            { ref: 5, role: 'textbox', name: '主机地址', value: 'http://127.0.0.1:5432', states: ['invalid'] },
            { role: 'alert', name: 'Invalid Host Format' },
            { ref: 6, role: 'textbox', name: '密码', states: ['password', 'filled'] },
            { ref: 7, role: 'checkbox', name: '使用 SSL', states: ['checked'] },
            { ref: 8, role: 'button', name: '测试连接' },
            { ref: 9, role: 'button', name: '保存', states: ['disabled'] },
          ],
        },
        { role: 'text', name: '主机地址只填 IP 或域名。' },
        { role: 'status', name: '已保存草稿' },
      ],
    });
    expect(JSON.stringify(screen)).not.toContain('secret');
    // Each number leads back to its element.
    expect(elements.get(5)).toBe($('#host'));
    expect((elements.get(9) as HTMLButtonElement).textContent).toBe('保存');
  });

  it('keeps the controls inside focusable containers and live regions', () => {
    document.body.innerHTML = `
      <div tabindex="0"><label for="name">名称</label><input id="name" value="orders-db" /></div>
      <div aria-live="polite"><p>正在测试连接</p><button>取消</button></div>
      <div aria-live="polite">已保存草稿</div>`;
    const { screen } = buildScreen(document, { errorSelectors: DEFAULT_ERROR_SELECTORS });
    expect(screen.nodes).toEqual([
      { ref: 1, role: 'textbox', name: '名称', value: 'orders-db' },
      {
        ref: 2,
        role: 'status',
        children: [
          { role: 'text', name: '正在测试连接' },
          { ref: 3, role: 'button', name: '取消' },
        ],
      },
      { role: 'status', name: '已保存草稿' },
    ]);
  });

  it('reads the choice of a custom select from beside its empty input', () => {
    // react-select's markup: the input only takes a filter; the choice is shown next to it.
    document.body.innerHTML = `
      <label for="tz">时区</label>
      <div class="select">
        <span aria-live="polite">option Default focused</span>
        <div class="value-container"><div class="single-value">Default</div><div><input id="tz" role="combobox" aria-expanded="false" /></div></div>
        <div class="indicator"><svg></svg></div>
      </div>
      <div class="select">
        <div class="value-container"><div id="kind-placeholder" class="placeholder">请选择</div><div><input role="combobox" aria-label="数据库类型" aria-describedby="kind-placeholder" /></div></div>
      </div>
      <div class="field"><label for="q">搜索</label><input id="q" role="combobox" /><span>Default</span></div>`;
    const { screen } = buildScreen(document, { errorSelectors: DEFAULT_ERROR_SELECTORS });
    expect(screen.nodes).toEqual([
      { role: 'status', name: 'option Default focused' },
      { ref: 1, role: 'combobox', name: '时区', value: 'Default', states: ['collapsed'] },
      // A placeholder is not a choice.
      { role: 'text', name: '请选择' },
      { ref: 2, role: 'combobox', name: '数据库类型', value: '' },
      // Text next to a field with its own label is the page's, not the field's.
      { ref: 3, role: 'combobox', name: '搜索', value: '' },
      { role: 'text', name: 'Default' },
    ]);
  });

  it('stops at the size cap and says how much is left', () => {
    document.body.innerHTML = Array.from({ length: 50 }, (_, i) => `<button>按钮${i}</button>`).join('');
    const { screen } = buildScreen(document, { errorSelectors: [], maxNodes: 20 });
    expect(screen.nodes).toHaveLength(20);
    expect(screen.truncated).toBe(30);
  });
});

describe('buildScreen on big pages', () => {
  const place = (element: Element, top: number) => {
    (element as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  };
  const refsIn = (nodes: readonly ScreenNode[]): number[] => nodes.flatMap((node) => [...(node.ref === undefined ? [] : [node.ref]), ...refsIn(node.children ?? [])]);

  it('lists some rows of a long table and counts the rest', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>ds-${i}</td><td><button>删除</button></td></tr>`).join('');
    document.body.innerHTML = `<table aria-label="数据源"><tbody>${rows}</tbody></table>`;
    const { screen } = buildScreen(document, { errorSelectors: [] });
    const table = screen.nodes[0]!;
    expect(table).toMatchObject({ role: 'table', name: '数据源', more: 20 });
    expect(table.children).toHaveLength(20);
    expect(table.children![0]).toMatchObject({ role: 'row', children: [{ role: 'text', name: 'ds-0' }, { role: 'button', name: '删除' }] });
  });

  it('wraps a long plain list in a list node to count what is left out', () => {
    document.body.innerHTML = `<ul aria-label="最近打开">${Array.from({ length: 30 }, (_, i) => `<li><a href="/r/${i}">报表 ${i}</a></li>`).join('')}</ul>`;
    const { screen } = buildScreen(document, { errorSelectors: [] });
    expect(screen.nodes).toEqual([expect.objectContaining({ role: 'list', name: '最近打开', more: 10 })]);
    expect(screen.nodes[0]!.children).toHaveLength(20);
  });

  it('prefers the rows the user can see, the middle ones when there are too many', () => {
    document.body.innerHTML = `<table><tbody>${Array.from({ length: 40 }, (_, i) => `<tr><td>ds-${i}</td></tr>`).join('')}</tbody></table>`;
    // Scrolled down: rows 30 to 39 are on screen.
    document.querySelectorAll('tr').forEach((row, i) => place(row, (i - 30) * 20));
    const { screen } = buildScreen(document, { errorSelectors: [], maxRows: 10 });
    expect(screen.nodes[0]!.children!.map((row) => row.children![0]!.name)).toEqual(Array.from({ length: 10 }, (_, i) => `ds-${30 + i}`));
    // Rows 10 to 39 on screen, room for 10: the middle ones.
    document.querySelectorAll('tr').forEach((row, i) => place(row, (i - 10) * 20));
    const { screen: middle } = buildScreen(document, { errorSelectors: [], maxRows: 10 });
    expect(middle.nodes[0]!.children!.map((row) => row.children![0]!.name)).toEqual(Array.from({ length: 10 }, (_, i) => `ds-${20 + i}`));
  });

  it('keeps an open dialog and the errors when the page is too big, numbering what is kept in order', () => {
    document.body.innerHTML = `
      ${Array.from({ length: 50 }, (_, i) => `<button>按钮${i}</button>`).join('')}
      <p role="alert">保存失败</p>
      <div role="dialog" aria-label="删除数据源"><p>删除后无法恢复。</p><button>取消</button><button>确定删除</button></div>`;
    const { screen, elements } = buildScreen(document, { errorSelectors: ['[role="alert"]'], maxNodes: 8 });
    expect(screen.truncated).toBe(50 + 5 - 8); // 50 buttons, plus the alert and the dialog with its text and two buttons
    expect(screen.nodes.slice(-2)).toEqual([
      { role: 'alert', name: '保存失败' },
      { ref: 4, role: 'dialog', name: '删除数据源', children: [{ role: 'text', name: '删除后无法恢复。' }, { ref: 5, role: 'button', name: '取消' }, { ref: 6, role: 'button', name: '确定删除' }] },
    ]);
    expect(refsIn(screen.nodes)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(elements.get(6)!.textContent).toBe('确定删除');
  });

  it('keeps what is in view before what is scrolled away', () => {
    document.body.innerHTML = Array.from({ length: 50 }, (_, i) => `<button>按钮${i}</button>`).join('');
    document.querySelectorAll('button').forEach((button, i) => place(button, i < 40 ? 2000 + i * 20 : (i - 40) * 20));
    const { screen } = buildScreen(document, { errorSelectors: [], maxNodes: 10 });
    expect(screen.nodes.map((node) => node.name)).toEqual(Array.from({ length: 10 }, (_, i) => `按钮${40 + i}`));
  });
});
