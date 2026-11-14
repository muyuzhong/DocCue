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
