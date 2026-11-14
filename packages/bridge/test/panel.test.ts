import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridge, type Bridge } from '../src/bridge.js';
import { messagesFor } from '../src/messages.js';
import { renderMarkdown } from '../src/panel/markdown.js';
import type { Panel } from '../src/panel/panel.js';

describe('renderMarkdown', () => {
  it('renders the little Markdown answers use', () => {
    expect(renderMarkdown('原因是**主机地址**不对，改成 `127.0.0.1`。\n再测一次。')).toBe('<p>原因是<strong>主机地址</strong>不对，改成 <code>127.0.0.1</code>。<br>再测一次。</p>');
    expect(renderMarkdown('步骤：\n\n1. 改主机地址\n2. 点测试连接')).toBe('<p>步骤：</p><ol><li>改主机地址</li><li>点测试连接</li></ol>');
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('## 原因\n端口不对')).toBe('<p><strong>原因</strong></p><p>端口不对</p>');
    expect(renderMarkdown('```sql\nselect 1 < 2;\n```')).toBe('<pre><code>select 1 &lt; 2;</code></pre>');
  });

  it('never lets an answer become markup', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> **<script>alert(2)</script>** [link](javascript:alert(3))');
    expect(html).not.toMatch(/<img|<script|<a /);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });
});

describe('messagesFor', () => {
  it('picks the language from the locale, falls back to English, and takes overrides', () => {
    expect(messagesFor('zh-CN').title).toBe('应用内助手');
    expect(messagesFor('zh-TW').next).toBe('下一步');
    expect(messagesFor('fr-FR').title).toBe('Help');
    expect(messagesFor(undefined).send).toBe('Send');
    expect(messagesFor('zh-CN', { title: '数据平台助手' })).toMatchObject({ title: '数据平台助手', send: '发送' });
  });
});

describe('the chat panel', () => {
  let bridge: Bridge;
  let panel: Panel | undefined;
  const shadow = () => document.querySelector('[data-doccue-panel]')!.shadowRoot!;
  const $ = <T extends Element = HTMLElement>(selector: string) => shadow().querySelector<T>(selector)!;

  beforeEach(() => {
    sessionStorage.clear();
    document.documentElement.lang = 'zh-CN';
    document.body.innerHTML = '<h1>仪表盘</h1><button id="refresh">刷新</button>';
    bridge = createBridge({ endpoint: '/doccue', messages: { title: '数据平台助手' } });
  });
  afterEach(() => {
    panel?.unmount();
    bridge.destroy();
  });

  it('starts as a button in the corner and opens into a chat, in the page language', async () => {
    panel = await bridge.mount();
    expect($('.launcher').hidden).toBe(false);
    expect($('.panel').hidden).toBe(true);
    expect($('.launcher').getAttribute('aria-label')).toBe('打开助手');

    $<HTMLButtonElement>('.launcher').click();
    expect($('.panel').hidden).toBe(false);
    expect($('.launcher').hidden).toBe(true);
    expect($('header strong').textContent).toBe('数据平台助手'); // the host's wording
    expect($('textarea').getAttribute('placeholder')).toBe('有问题就问我…');
    expect($('.greeting').textContent).toMatch(/^遇到不会的操作/);
    expect($<HTMLButtonElement>('.send').disabled).toBe(true);

    $('.panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.panel').hidden).toBe(true);
  });

  it('remembers whether it was open for the next page of the tab', async () => {
    panel = await bridge.mount();
    expect($('.panel').hidden).toBe(true);
    panel.open();
    panel.unmount();
    bridge.destroy();

    bridge = createBridge({ endpoint: '/doccue' });
    panel = await bridge.mount();
    expect($('.panel').hidden).toBe(false);
  });

  it('can sit in the left corner and opens at once when asked to', async () => {
    panel = await bridge.mount({ side: 'left', open: true });
    expect(document.querySelector('[data-doccue-panel]')!.getAttribute('data-side')).toBe('left');
    expect($('.panel').hidden).toBe(false);
  });

  it('is not part of what the bridge records or shows the model', async () => {
    panel = await bridge.mount({ open: true });
    $<HTMLButtonElement>('.close').click();
    $<HTMLButtonElement>('.launcher').click();
    document.querySelector<HTMLButtonElement>('#refresh')!.click();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(bridge.recorded().map((entry) => entry.action?.target?.name)).toEqual(['刷新']);
    expect(JSON.stringify(bridge.perceive().screen)).not.toContain('应用内助手');
  });

  it('clears what it shows when the conversation is reset', async () => {
    sessionStorage.setItem('doccue:panel:lines', JSON.stringify([{ role: 'user', text: '旧问题' }]));
    sessionStorage.setItem('doccue:conversation', JSON.stringify([{ type: 'user', text: '旧问题', perception: { at: 0, screen: { page: { path: '/' }, nodes: [] }, actions: [] } }]));
    bridge.destroy();
    bridge = createBridge({ endpoint: '/doccue' });
    panel = await bridge.mount({ open: true });
    expect(shadow().querySelectorAll('.message.user')).toHaveLength(1); // drawn again after a page load

    $<HTMLButtonElement>('.reset').click();
    expect(shadow().querySelectorAll('.message')).toHaveLength(0);
    expect($('.greeting')).not.toBeNull();
    expect(bridge.conversation()).toEqual([]);
  });
});

describe('links in answers', () => {
  it('opens http(s) links in a new tab, showing the site when the text says something else', () => {
    expect(renderMarkdown('见[连接问题排查](https://docs.example.com/troubleshooting)。')).toBe(
      '<p>见<a href="https://docs.example.com/troubleshooting" target="_blank" rel="noopener noreferrer nofollow">连接问题排查</a><span class="site"> · docs.example.com</span>。</p>',
    );
    expect(renderMarkdown('文档在 https://docs.example.com/a?b=1&c=2。')).toBe(
      '<p>文档在 <a href="https://docs.example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">https://docs.example.com/a?b=1&amp;c=2</a>。</p>',
    );
  });

  it('leaves addresses inside `code` alone', () => {
    expect(renderMarkdown('不要带协议头，比如 `http://`、`mysql://` 都不行，见 https://docs.example.com。')).toBe(
      '<p>不要带协议头，比如 <code>http://</code>、<code>mysql://</code> 都不行，见 <a href="https://docs.example.com/" target="_blank" rel="noopener noreferrer nofollow">https://docs.example.com</a>。</p>',
    );
  });

  it('leaves anything that is not http(s) as text', () => {
    expect(renderMarkdown('[点我](javascript:alert(1))')).toBe('<p>[点我](javascript:alert(1))</p>');
    expect(renderMarkdown('[文件](file:///etc/passwd) ![图](https://x.example/a.png)')).not.toMatch(/<a href="file|<img/);
    expect(renderMarkdown('[x](https://ok.example/"onmouseover="alert(1))')).not.toContain('"onmouseover');
  });
});

describe('the panel in other settings', () => {
  let bridge: Bridge;
  let panel: Panel | undefined;
  const shadow = () => document.querySelector('[data-doccue-panel]')!.shadowRoot!;
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<h1>仪表盘</h1>';
  });
  afterEach(() => {
    panel?.unmount();
    bridge.destroy();
  });

  it('takes the theme for the panel and the guide', async () => {
    bridge = createBridge({ endpoint: '/doccue', theme: 'dark' });
    panel = await bridge.mount();
    expect(shadow().querySelector('.root')!.getAttribute('data-theme')).toBe('dark');
    const { runGuide } = await import('../src/guide.js');
    const guide = runGuide({ document, steps: [{ target: 1, text: '这里' }], find: () => document.querySelector('h1') ?? undefined, messages: bridge.messages, theme: bridge.theme, waitMs: 100 });
    expect(document.querySelector('[data-doccue-guide]')!.shadowRoot!.querySelector('.layer')!.getAttribute('data-theme')).toBe('dark');
    guide.stop();
  });

  it('shows a failure that happened before it was mounted, once', async () => {
    // Nothing listens on port 9 of this machine.
    bridge = createBridge({ endpoint: 'http://127.0.0.1:9/doccue' });
    await bridge.ask('你好').catch(() => {});
    expect(bridge.lastError()).toBeDefined();
    panel = await bridge.mount({ open: true });
    expect(Array.from(shadow().querySelectorAll('.message.error')).map((line) => line.textContent)).toEqual(['出错了，请稍后再试。']);
  });

  it('shows the latest 200 lines of a long conversation, and says older ones are not shown', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第 ${i} 句` }));
    sessionStorage.setItem('doccue:panel:lines', JSON.stringify(lines));
    sessionStorage.setItem('doccue:conversation', JSON.stringify([{ type: 'user', text: 'x', perception: { at: 0, screen: { page: { path: '/' }, nodes: [] }, actions: [] } }]));
    bridge = createBridge({ endpoint: '/doccue' });
    panel = await bridge.mount({ open: true });
    const shown = shadow().querySelectorAll('.message');
    expect(shown).toHaveLength(200);
    expect(shown[0]!.textContent).toBe('第 50 句');
    expect(shadow().querySelector('.earlier')!.textContent).toBe('更早的消息没有显示。');
  });
});
