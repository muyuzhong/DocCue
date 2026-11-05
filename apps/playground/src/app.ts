/**
 * The demo app: a small "data platform" with a datasource list, a create form and a dashboard.
 * Plain DOM on purpose: the bridge has to work without any framework integration.
 */

interface Datasource {
  id: number;
  name: string;
  kind: string;
  host: string;
  port: number;
  status: string;
}

const main = () => document.querySelector<HTMLElement>('#main')!;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function toast(text: string, kind: 'success' | 'error'): void {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  element.textContent = text;
  document.querySelector('.toasts')!.append(element);
  setTimeout(() => element.remove(), 6000);
}

export function navigate(path: string): void {
  history.pushState({}, '', path);
  void render();
}

async function listPage(): Promise<void> {
  document.title = '数据源';
  const items = (await (await fetch('/api/datasources')).json()) as Datasource[];
  main().innerHTML = `
    <div class="page-head"><h1>数据源</h1><a class="button primary" href="/datasource/new" data-link>新建数据源</a></div>
    <table aria-label="数据源列表">
      <thead><tr><th>名称</th><th>类型</th><th>主机</th><th>端口</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        ${items
          .map(
            (item) => `<tr data-id="${item.id}">
              <td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.kind)}</td><td>${escapeHtml(item.host)}</td><td>${item.port}</td>
              <td><span class="badge ${item.status === '正常' ? 'ok' : 'bad'}">${escapeHtml(item.status)}</span></td>
              <td><button type="button" class="link edit">编辑</button><button type="button" class="link danger delete">删除</button></td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  main().querySelectorAll<HTMLButtonElement>('.delete').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.closest('tr')!;
      confirmDelete(Number(row.dataset.id), row.querySelector('td')!.textContent ?? '');
    });
  });
  main().querySelectorAll<HTMLButtonElement>('.edit').forEach((button) => {
    button.addEventListener('click', () => toast('编辑功能还没做', 'error'));
  });
}

function confirmDelete(id: number, name: string): void {
  const dialog = document.createElement('div');
  dialog.className = 'dialog-backdrop';
  dialog.innerHTML = `
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <h2 id="dialog-title">删除数据源</h2>
      <p>确定删除「${escapeHtml(name)}」吗？删除后依赖它的报表会失效。</p>
      <div class="actions"><button type="button" class="cancel">取消</button><button type="button" class="danger confirm">确定删除</button></div>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector('.cancel')!.addEventListener('click', () => dialog.remove());
  dialog.querySelector('.confirm')!.addEventListener('click', async () => {
    await fetch(`/api/datasources/${id}`, { method: 'DELETE' });
    dialog.remove();
    toast(`已删除「${name}」`, 'success');
    void listPage();
  });
}

function newPage(): void {
  document.title = '新建数据源';
  main().innerHTML = `
    <h1>新建数据源</h1>
    <form class="card" aria-label="连接信息" novalidate>
      <div class="field"><label for="name">名称</label><input id="name" placeholder="例如 orders-db" /></div>
      <div class="field"><label for="kind">数据库类型</label>
        <select id="kind"><option>MySQL</option><option selected>PostgreSQL</option><option>ClickHouse</option></select></div>
      <div class="field"><label for="host">主机地址</label><input id="host" aria-describedby="host-error" />
        <p class="field-error" id="host-error" role="alert" hidden></p></div>
      <div class="field"><label for="port">端口</label><input id="port" inputmode="numeric" aria-describedby="port-error" />
        <p class="field-error" id="port-error" role="alert" hidden></p></div>
      <div class="field"><label for="user">用户名</label><input id="user" /></div>
      <div class="field"><label for="password">密码</label><input id="password" type="password" /></div>
      <label class="check"><input id="ssl" type="checkbox" /> 使用 SSL</label>
      <div class="actions"><button type="button" id="test">测试连接</button><button type="submit" id="save" class="primary" disabled>保存</button></div>
    </form>`;

  const form = main().querySelector('form')!;
  const field = (id: string) => form.querySelector<HTMLInputElement>(`#${id}`)!;
  const setError = (id: string, message: string) => {
    const error = form.querySelector<HTMLElement>(`#${id}-error`)!;
    error.textContent = message;
    error.hidden = !message;
    field(id).setAttribute('aria-invalid', message ? 'true' : 'false');
  };
  const save = form.querySelector<HTMLButtonElement>('#save')!;
  form.addEventListener('input', (event) => {
    const id = (event.target as HTMLElement).id;
    if (id === 'host' || id === 'port') setError(id, '');
    save.disabled = true; // any change needs a new connection test
  });

  form.querySelector('#test')!.addEventListener('click', async () => {
    const host = field('host').value.trim();
    const port = field('port').value.trim();
    let valid = true;
    if (!host) (setError('host', '请填写主机地址'), (valid = false));
    else if (/:\/\/|\/|:/.test(host)) (setError('host', 'Invalid Host Format'), (valid = false));
    if (!port) (setError('port', '请填写端口'), (valid = false));
    else if (!/^\d+$/.test(port)) (setError('port', '端口只能是数字'), (valid = false));
    if (!valid) return;
    const button = form.querySelector<HTMLButtonElement>('#test')!;
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const response = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: field('kind').value, host, port }),
      });
      const body = (await response.json()) as { message?: string; version?: string };
      if (response.ok) {
        toast(`连接成功：${body.version ?? ''}`, 'success');
        save.disabled = false;
      } else {
        toast(`连接失败：${body.message ?? response.status}`, 'error');
      }
    } finally {
      button.disabled = false;
      button.textContent = '测试连接';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await fetch('/api/datasources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: field('name').value, kind: field('kind').value, host: field('host').value, port: field('port').value }),
    });
    toast('已保存', 'success');
    navigate('/datasource');
  });
}

function dashboardPage(): void {
  document.title = '仪表盘';
  main().innerHTML = `
    <h1>仪表盘</h1>
    <div class="cards">
      <section class="card stat"><h2>数据源</h2><p class="number">3</p></section>
      <section class="card stat"><h2>今日查询</h2><p class="number">1,284</p></section>
      <section class="card stat"><h2>失败的同步</h2><p class="number bad">2</p></section>
    </div>`;
}

export async function render(): Promise<void> {
  const path = location.pathname;
  document.querySelectorAll('.sidebar a').forEach((link) => link.toggleAttribute('aria-current', link.getAttribute('href') === path));
  if (path === '/datasource/new') newPage();
  else if (path === '/dashboard') dashboardPage();
  else await listPage();
}

export function startApp(): void {
  document.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-link]');
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute('href')!);
  });
  window.addEventListener('popstate', () => void render());
  void render();
}
