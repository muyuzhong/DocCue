/**
 * End-to-end demo in a real browser (the system Chrome, driven by playwright-core): use the
 * playground like a person would, ask the assistant, and print what it saw and answered.
 *
 *   pnpm --filter @doccue/playground e2e
 *
 * PLAYGROUND_URL reuses a running playground (otherwise one is started on a free port).
 * E2E_SCREENSHOTS sets where screenshots go (default apps/playground/.e2e/).
 * Uses the real model from the root .env, so answers take as long as the model does.
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { start } from '../server.js';

const shots = process.env.E2E_SCREENSHOTS ?? fileURLToPath(new URL('../.e2e/', import.meta.url));
mkdirSync(shots, { recursive: true });

const running = process.env.PLAYGROUND_URL ? undefined : await start(0);
const base = process.env.PLAYGROUND_URL ?? running!.url;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (error) => console.log(`[页面报错] ${error.message}`));

const guideBubble = page.locator('[data-doccue-guide] .bubble');
const busy = page.locator('.assistant .stop');

/** Types a question and waits until a guide is on screen or the answer has ended. */
async function ask(page: Page, question: string): Promise<void> {
  console.log(`\n—— 提问：${question}`);
  console.log(`本地已记录、随这次提问发送的操作：\n${await page.locator('.recorded').innerText()}`);
  await page.locator('.assistant textarea').fill(question);
  await page.locator('.assistant textarea').press('Enter');
  await guideBubble.or(page.locator('.assistant .stop[hidden]')).first().waitFor({ state: 'attached', timeout: 240_000 });
}

/** Waits for the exchange to end; steps of a guide the script has no action for are walked through with Next. */
async function finish(page: Page): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (await busy.isVisible()) {
    if (Date.now() > deadline) throw new Error('the answer did not end in time');
    if (await guideBubble.isVisible()) {
      console.log(`  （脚本点了「下一步」：${(await guideBubble.locator('.text').innerText()).trim()}）`);
      await guideBubble.locator('.next').click({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
}

/** Prints what was said since the last call. */
let printed = 0;
async function printMessages(page: Page): Promise<void> {
  const all = await page.locator('.messages .message').allInnerTexts();
  for (const text of all.slice(printed)) console.log(`  · ${text.replace(/\n+/g, ' / ')}`);
  printed = all.length;
}

try {
  await page.goto(`${base}/datasource`);
  await page.getByRole('link', { name: '新建数据源' }).first().click();
  await page.getByLabel('主机地址').fill('http://127.0.0.1:5432');
  await page.getByLabel('端口').fill('5432');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.waitForTimeout(1500);

  // 1. A wrong value: the agent should say why and point at the field.
  await ask(page, '为什么连不上？');
  console.log(`\n模型看到的现场信息：\n${await page.locator('.context').innerText()}\n`);
  await printMessages(page);
  if (await guideBubble.isVisible()) {
    console.log(`\n页面上的气泡：${(await guideBubble.locator('.text').innerText()).trim()}`);
    await page.screenshot({ path: `${shots}/1-guide.png` });
    // Do what a user would: fix the field, then test again. Each action moves the guide on.
    await page.getByLabel('主机地址').fill('127.0.0.1');
    await page.getByLabel('主机地址').press('Tab');
    await page.waitForTimeout(300);
    if (await guideBubble.isVisible()) console.log(`下一个气泡：${(await guideBubble.locator('.text').innerText()).trim()}`);
    await page.getByRole('button', { name: '测试连接' }).click();
    await page.waitForTimeout(500);
  } else {
    console.log('\n（模型没有发起引导）');
  }
  await finish(page);
  await printMessages(page);
  console.log(`\n模型最后看到的：\n${await page.locator('.context').innerText()}`);
  await page.screenshot({ path: `${shots}/2-after-guide.png` });

  // 2. A question that needs no pointing: a plain answer, no guide.
  await ask(page, 'ClickHouse 的默认端口是多少？');
  await finish(page);
  await printMessages(page);
  console.log(`\n截图：${shots}`);
} finally {
  await browser.close();
  await running?.close();
}
