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

async function ask(page: Page, question: string): Promise<void> {
  const before = await page.locator('.message.assistant.done').count();
  console.log(`\n—— 提问：${question}`);
  console.log(`本地已记录、随这次提问发送的操作：\n${await page.locator('.recorded').innerText()}`);
  await page.locator('.assistant textarea').fill(question);
  await page.locator('.assistant textarea').press('Enter');
  const started = Date.now();
  await page.locator('.message.assistant.done').nth(before).waitFor({ timeout: 240_000 });
  console.log(`\n状态栏（agent 看到的）：\n${await page.locator('.status').innerText()}`);
  console.log(`\n回答（${Math.round((Date.now() - started) / 1000)} 秒）：\n${await page.locator('.message.assistant.done').nth(before).innerText()}`);
}

try {
  await page.goto(`${base}/datasource`);
  await page.getByRole('link', { name: '新建数据源' }).first().click();
  await page.getByLabel('主机地址').fill('http://127.0.0.1:5432');
  await page.getByLabel('端口').fill('5432');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shots}/1-host-error.png` });
  await ask(page, '为什么连不上？');
  console.log(`\n界面树（上一次提问时）：\n${await page.locator('.screen').innerText()}`);

  await page.getByLabel('主机地址').fill('127.0.0.1');
  await page.getByLabel('端口').fill('5433');
  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByRole('alert').filter({ hasText: '连接失败' }).waitFor();
  await page.waitForTimeout(1200);
  await ask(page, '现在又是什么问题？');
  await page.screenshot({ path: `${shots}/2-after-answers.png` });
  console.log(`\n截图：${shots}`);
} finally {
  await browser.close();
  await running?.close();
}
