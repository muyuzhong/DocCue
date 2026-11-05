import { beforeEach, describe, expect, it } from 'vitest';
import { collectErrors, DEFAULT_ERROR_SELECTORS } from '../src/errors.js';
import { accessibleName, controlRole, describeControl, findControl } from '../src/naming.js';
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
      <input id="cue" data-cue-id="datasource.timeout" />`;
    expect(['host', 'kind', 'port', 'pw', 'test', 'close', 'submit', 'custom', 'cue'].map((id) => accessibleName($(`#${id}`)))).toEqual([
      '主机地址',
      '数据库类型',
      '端口，例如 5432',
      '密码',
      '测试连接',
      '关闭',
      '保存',
      '更多',
      'datasource.timeout',
    ]);
    expect(['host', 'kind', 'pw', 'test', 'submit', 'custom'].map((id) => controlRole($(`#${id}`)))).toEqual([
      '输入框',
      '下拉框',
      '密码框',
      '按钮',
      '按钮',
      '按钮',
    ]);
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
    expect(describeControl(first!)).toBe('「mysql-prod」这一行 › 按钮「删除」');
    expect(describeControl(second!)).toBe('「pg-test」这一行 › 按钮「删除」');
    expect(describeControl(document.querySelectorAll('.edit')[1]!)).toBe('「高级设置」区域 › 按钮「编辑」');
    expect(describeControl($('#ok'))).toBe('弹窗「删除数据源」 › 按钮「确定」');
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
      { text: 'Invalid Host Format', target: '输入框「主机地址」', source: 'page' },
      { text: '不能为空', target: '输入框「名称」', source: 'page' },
      { text: '端口填写有误', target: '输入框「端口」', source: 'page' },
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
    expect(buildScreen(document, { errorSelectors: DEFAULT_ERROR_SELECTORS, maxChars: 5000 }).split('\n')).toEqual([
      expect.stringMatching(/^页面「新建数据源」/),
      '导航「主菜单」',
      '  [1] 链接「数据源」',
      '标题「新建数据源」',
      '表单「连接信息」',
      '  [2] 输入框「主机地址」: "http://127.0.0.1:5432" ⚠',
      '  报错「Invalid Host Format」',
      '  [3] 密码框「密码」：（已填写）',
      '  [4] 复选框「使用 SSL」（已勾选）',
      '  [5] 按钮「测试连接」',
      '  [6] 按钮「保存」（不可用）',
      '文字「主机地址只填 IP 或域名。」',
      '提示「已保存草稿」',
    ]);
  });

  it('stops at the size cap and says how much is left', () => {
    document.body.innerHTML = Array.from({ length: 50 }, (_, i) => `<button>按钮${i}</button>`).join('');
    const screen = buildScreen(document, { errorSelectors: [], maxChars: 200 });
    expect(screen.length).toBeLessThan(260);
    expect(screen).toMatch(/…（还有 \d+ 行未显示）$/);
  });
});
