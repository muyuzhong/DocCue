/**
 * Multi-step scenarios in a real browser: a script plays the user. It asks a question, then does
 * whatever the guide on the page points at (clicks buttons and links, fills fields with the
 * scenario's values), across pages and dialogs, and checks that the goal was reached.
 *
 *   pnpm journeys            all journeys
 *   pnpm journeys delete     only journeys whose name contains "delete"
 *
 * Uses the system Chrome and the real model from the root .env. Each journey gets its own
 * playground server, so the mock data starts fresh.
 */
import { chromium, type ElementHandle, type Page } from 'playwright-core';
import { start } from '../server.js';
import { guideOrAnswer, isBusy, openPanel } from './panel.js';

const datasources = async (url: string) => (await (await fetch(`${url}/api/datasources`)).json()) as Array<{ name: string; kind: string; host: string }>;

interface Journey {
  name: string;
  start: string;
  question: string;
  /** What the user types or picks, by the field's label. */
  values: Record<string, string>;
  /** Reload the page after this many actions, to check that the guide carries on. */
  reloadAfter?: number;
  /** Checks the mock backend of the playground at `url`. */
  goal: (url: string) => Promise<boolean>;
}

const journeys: Journey[] = [
  {
    name: 'create a datasource, starting on another page',
    start: '/dashboard',
    question: '我想新建一个 MySQL 数据源，名字叫 orders，地址是 10.0.0.8，带我做一遍。',
    values: { 名称: 'orders', 数据库类型: 'MySQL', 主机地址: '10.0.0.8', 端口: '3306', 用户名: 'root', 密码: 'secret' },
    goal: async (url) => (await datasources(url)).some((item) => item.name === 'orders' && item.kind === 'MySQL' && item.host === '10.0.0.8'),
  },
  {
    name: 'delete a datasource through a confirmation dialog',
    start: '/dashboard',
    question: '帮我把 pg-test 这个数据源删掉。',
    values: {},
    goal: async (url) => {
      const list = await datasources(url);
      return list.length === 2 && !list.some((item) => item.name === 'pg-test');
    },
  },
  {
    name: 'carry on after a full page reload',
    start: '/dashboard',
    question: '我想新建一个 PostgreSQL 数据源，名字叫 billing，地址是 10.0.0.9，带我做一遍。',
    values: { 名称: 'billing', 数据库类型: 'PostgreSQL', 主机地址: '10.0.0.9', 端口: '5432', 用户名: 'app', 密码: 'secret' },
    reloadAfter: 1,
    goal: async (url) => (await datasources(url)).some((item) => item.name === 'billing' && item.host === '10.0.0.9'),
  },
  {
    name: 'change the notification email across whole page loads and a form post',
    start: '/dashboard',
    question: '帮我把通知邮箱改成 ops@example.com，带我做一遍。',
    values: { 通知邮箱: 'ops@example.com' },
    goal: async (url) => (await (await fetch(`${url}/api/settings`)).json()).email === 'ops@example.com',
  },
];

interface Target {
  handle: ElementHandle<Element>;
  tag: string;
  type: string;
  label: string;
  disabled: boolean;
}

/** The control under the spotlight: what a user would see highlighted. */
async function highlighted(page: Page): Promise<Target | undefined> {
  const box = await page.locator('[data-doccue-guide] .spot').boundingBox();
  if (!box) return undefined;
  const handle = await page.evaluateHandle(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element?.closest('button, a, input, select, textarea, [role="button"], [role="tab"], [role="link"]') ?? element;
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) return undefined;
  const info = await element.evaluate((node) => {
    const field = node as HTMLInputElement;
    return {
      tag: node.tagName.toLowerCase(),
      type: field.type ?? '',
      label: (field.labels?.[0]?.textContent ?? node.getAttribute('aria-label') ?? node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      disabled: field.disabled === true,
    };
  });
  return { handle: element, ...info };
}

async function run(journey: Journey): Promise<boolean> {
  const server = await start(0);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bubble = page.locator('[data-doccue-guide] .bubble');
    try {
    await page.goto(`${server.url}${journey.start}`);
    await openPanel(page);
    await page.locator('[data-doccue-panel] textarea').fill(journey.question);
    await page.locator('[data-doccue-panel] textarea').press('Enter');

    const deadline = Date.now() + 240_000;
    let actions = 0;
    let last = '';
    let repeats = 0;
    await guideOrAnswer(page);
    while (await isBusy(page)) {
      try {
        if (Date.now() > deadline) throw new Error('did not finish in time');
        if (!(await bubble.isVisible())) {
          await page.waitForTimeout(300);
          continue;
        }
        const text = (await bubble.locator('.text').innerText()).trim();
        const target = await highlighted(page);
        // The same step again after acting on it: the action did not count (e.g. a disabled button). Skip it.
        repeats = text === last ? repeats + 1 : 0;
        last = text;
        // A disabled control may only be waiting for something (a connection test): wait like a person would.
        if (target?.disabled) {
          for (let waited = 0; waited < 5000 && (await target.handle.evaluate((node) => (node as HTMLButtonElement).disabled)); waited += 250) await page.waitForTimeout(250);
          target.disabled = await target.handle.evaluate((node) => (node as HTMLButtonElement).disabled);
        }
        const value = target ? journey.values[target.label] : undefined;
        if (!target || target.disabled || repeats >= 2 || (target.tag === 'select' && value === undefined)) {
          console.log(`    下一步  ${text}`);
          await bubble.locator('.next').click();
        } else if (target.tag === 'select') {
          console.log(`    选择    「${target.label}」= ${value}  ← ${text}`);
          await target.handle.selectOption({ label: value! });
        } else if (target.tag === 'textarea' || (target.tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes(target.type))) {
          console.log(`    填写    「${target.label}」= ${value ?? 'test'}  ← ${text}`);
          await target.handle.fill(value ?? 'test');
          await target.handle.press('Tab');
        } else {
          console.log(`    点击    「${target.label}」  ← ${text}`);
          await target.handle.click();
        }
        actions++;
        await page.waitForTimeout(400);
        if (actions === journey.reloadAfter) {
          console.log('    （刷新页面）');
          await page.reload();
          await page.waitForTimeout(500);
        }
      } catch (error) {
        // A whole new page is loading: whatever was being read is gone. Look again in a moment.
        if (!String(error).includes('context was destroyed') && !String(error).includes('navigat')) throw error;
        await page.waitForTimeout(300);
      }
    }
    const said = await page.locator('[data-doccue-panel] .message.assistant').allInnerTexts();
    console.log(`    最后的回答：${(said.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
    const reached = await journey.goal(server.url);
    if (!reached) console.log('    目标没有达成（看后端的模拟数据）');
    return reached;
  } finally {
    await browser.close();
    await server.close();
  }
}

const filter = process.argv[2];
const selected = journeys.filter((journey) => !filter || journey.name.includes(filter));
let passed = 0;
for (const journey of selected) {
  console.log(`\n${journey.name}\n  ${journey.question}`);
  let ok = false;
  try {
    ok = await run(journey);
  } catch (error) {
    console.log(`    出错：${error instanceof Error ? error.message : String(error)}`);
  }
  if (ok) passed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}`);
}
console.log(`\n${passed} / ${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
