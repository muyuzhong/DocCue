/** The bridge's built-in chat panel in the playground, with the real model. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PANEL, enterWrongHost, openPage, openPlayground, type Playground } from './page.js';

let playground: Playground;
beforeAll(async () => {
  playground = await openPlayground();
});
afterAll(() => playground?.close());

describe('the chat panel', () => {
  it('shows the answer, and folds into a bar while a guide is on the page', async () => {
    const user = await openPage(playground, '/datasource/new');
    await enterWrongHost(user.page);
    await user.ask('为什么连不上？');
    await user.bubble();
    const panel = user.page.locator(`${PANEL} .panel`);
    const bar = user.page.locator(`${PANEL} .bar`);
    expect(await panel.isVisible()).toBe(false);
    expect(await bar.isVisible()).toBe(true);
    expect(await bar.innerText()).toContain('正在页面上指给你看');
    // What the model said before pointing is already in the panel.
    expect((await user.answers()).join('')).toMatch(/主机地址/);

    // Opening the panel during the guide leaves the guide where it is.
    await user.page.locator(`${PANEL} .expand`).click();
    expect(await panel.isVisible()).toBe(true);
    expect(await user.page.evaluate(() => window.doccue.guiding())).toBe(true);

    await user.page.locator('[data-doccue-guide] .exit').click();
    await user.idle();
    expect(await bar.isVisible()).toBe(false);
    expect(await panel.isVisible()).toBe(true);
  });

  it('says when it is checking the docs', async () => {
    const user = await openPage(playground, '/datasource');
    // Note every status line the panel shows while the answer comes in.
    await user.page.evaluate(() => {
      const seen: string[] = ((window as unknown as { statuses: string[] }).statuses = []);
      const root = document.querySelector('[data-doccue-panel]')!.shadowRoot!;
      new MutationObserver(() => root.querySelectorAll('.status').forEach((status) => seen.push(status.textContent ?? ''))).observe(root, { subtree: true, childList: true, characterData: true });
    });
    await user.ask('删除数据源以后还能恢复吗？只用文字回答，不要在页面上指。');
    await user.finishGuides();
    const statuses = await user.page.evaluate(() => (window as unknown as { statuses: string[] }).statuses);
    expect(statuses).toContain('思考中…');
    expect(statuses).toContain('正在查文档…');
    expect((await user.answers()).at(-1)).toMatch(/无法恢复|不能恢复|不可恢复/);
  });

  it('tells the user when the backend fails, instead of waiting forever', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.page.route('**/doccue/turn', (route) => route.fulfill({ status: 502, body: 'bad gateway' }));
    await user.ask('你好');
    await user.idle();
    expect(await user.page.locator(`${PANEL} .message.error`).last().innerText()).toBe('出错了，请稍后再试。');
    expect(await user.page.locator(`${PANEL} .message.assistant`).count()).toBe(0);
  });

  it('tells the user when the answer owed after a page load cannot come', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.ask('数据平台能接入哪些数据库？只用文字回答，不要在页面上指。');
    // The page goes away before the answer; on the new page the backend is down.
    await user.page.route('**/doccue/turn', (route) => route.fulfill({ status: 502, body: 'bad gateway' }));
    await user.reload();
    await user.idle();
    expect(await user.page.locator(`${PANEL} .message.error`).last().innerText()).toBe('出错了，请稍后再试。');
    expect((await user.conversation()).map((item) => item.type)).toEqual(['user']);
  });

  it('asks for a new conversation when the backend turns this one away', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.page.route('**/doccue/turn', (route) => route.fulfill({ status: 413, contentType: 'application/json', body: '{"errors":["body: larger than 2000000 bytes"]}' }));
    await user.ask('你好');
    await user.idle();
    expect(await user.page.locator(`${PANEL} .message.error`).last().innerText()).toBe('这段对话没法继续了，请点右上角开始新对话。');
  });

  it('takes the whole screen on a phone', async () => {
    const user = await openPage(playground, '/dashboard', { width: 390, height: 844 });
    await user.page.locator(`${PANEL} .launcher`).click();
    expect(await user.page.locator(`${PANEL} .panel`).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  });
});
