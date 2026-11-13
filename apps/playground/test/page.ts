/**
 * Drives the playground in the system Chrome, the way a user would, with the real model behind
 * it. Each test gets its own browser context, so its conversation (in sessionStorage) is its own.
 */
import type { Bridge, Item, TurnRequest } from '@doccue/bridge';
import { chromium, type Browser, type Page } from 'playwright-core';
import { start } from '../server.js';

export interface Playground {
  url: string;
  browser: Browser;
  close(): Promise<void>;
}

export async function openPlayground(): Promise<Playground> {
  const server = await start(0);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  return {
    url: server.url,
    browser,
    close: async () => {
      await browser.close();
      await server.close();
    },
  };
}

declare global {
  interface Window {
    doccue: Bridge;
  }
}

export interface UserPage {
  page: Page;
  /** Every request the bridge sent to the backend, in order. */
  posts: TurnRequest[];
  /** Types a question into the chat panel and waits until it has gone out. */
  ask(question: string): Promise<void>;
  /** Waits until the bridge has nothing in progress: no answer on its way, no guide on screen. */
  idle(): Promise<void>;
  busy(): Promise<boolean>;
  conversation(): Promise<Item[]>;
  /** The guide's bubble text and progress, once a guide is on screen. */
  bubble(): Promise<{ text: string; progress: string }>;
  /** The control under the spotlight, as `tag#id` or `tag "text"`. */
  highlighted(): Promise<string | undefined>;
  /** Presses Next until no guide is left on screen and the bridge is idle. */
  finishGuides(): Promise<void>;
}

export async function openPage(playground: Playground, path: string): Promise<UserPage> {
  const context = await playground.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const posts: TurnRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/doccue/turn')) posts.push(request.postDataJSON() as TurnRequest);
  });
  await page.goto(`${playground.url}${path}`);
  await page.waitForFunction(() => window.doccue !== undefined);

  const bubble = page.locator('[data-doccue-guide] .bubble');
  const user: UserPage = {
    page,
    posts,
    async ask(question) {
      const before = posts.length;
      await page.locator('.assistant textarea').fill(question);
      await page.locator('.assistant textarea').press('Enter');
      await page.waitForFunction((count) => window.doccue.busy() || count, posts.length > before);
      for (let waited = 0; posts.length === before && waited < 10_000; waited += 50) await page.waitForTimeout(50);
    },
    idle: () => page.waitForFunction(() => !window.doccue.busy(), null, { timeout: 180_000, polling: 100 }).then(() => undefined),
    busy: () => page.evaluate(() => window.doccue.busy()),
    conversation: () => page.evaluate(() => window.doccue.conversation()),
    async bubble() {
      await bubble.waitFor({ state: 'visible', timeout: 120_000 });
      return { text: (await bubble.locator('.text').innerText()).trim(), progress: (await bubble.locator('.progress').innerText()).trim() };
    },
    async highlighted() {
      const box = await page.locator('[data-doccue-guide] .spot').boundingBox();
      if (!box) return undefined;
      return page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)?.closest('button, a, input, select, textarea, h1, h2, h3');
        if (!element) return undefined;
        return element.id ? `${element.tagName.toLowerCase()}#${element.id}` : `${element.tagName.toLowerCase()} "${element.textContent?.trim()}"`;
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    },
    async finishGuides() {
      const deadline = Date.now() + 180_000;
      while (await user.busy()) {
        if (Date.now() > deadline) throw new Error('the bridge did not become idle');
        if (await bubble.isVisible()) await bubble.locator('.next').click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    },
  };
  return user;
}

/** On the create page: a host with a scheme and a port, then a connection test. Leaves "Invalid Host Format" on screen. */
export async function enterWrongHost(page: Page): Promise<void> {
  await page.getByLabel('主机地址').fill('http://127.0.0.1:5432');
  await page.getByLabel('端口').fill('5432');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByText('Invalid Host Format').waitFor();
  // Let the recorder close the click's record with the error it caused.
  await page.waitForTimeout(1200);
}

export const userItems = (conversation: readonly Item[]) => conversation.filter((item): item is Extract<Item, { type: 'user' }> => item.type === 'user');
export const guideResults = (conversation: readonly Item[]) => conversation.filter((item): item is Extract<Item, { type: 'guide_result' }> => item.type === 'guide_result');
