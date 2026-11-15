/**
 * Questions on a real host app with the real model: a script plays the user. It asks, then does
 * whatever the guide points at (clicks, types the case's values, picks from dropdowns by typing
 * and pressing Enter), across pages and menus, and reports for each case where the first step
 * pointed, every step, whether the goal was reached, and the model's time and tokens.
 *
 *   pnpm --filter @doccue/hosts ask [case name part]
 *
 * Each case gets a fresh Grafana. Uses the system Chrome and the model from the root .env.
 */
import { readFileSync } from 'node:fs';
import type { Bridge } from '@doccue/bridge';
import type { LogRecord } from '@doccue/core';
import { chromium, type ElementHandle, type Page } from 'playwright-core';
import { startGrafana, type Grafana } from './grafana/grafana.js';

declare global {
  interface Window {
    doccue: Bridge;
  }
}

interface Case {
  name: string;
  start: string;
  /** What the user did before asking. */
  prepare?: (page: Page) => Promise<void>;
  question: string;
  /** What the user types, by a pattern on the field's label. */
  values?: Array<[RegExp, string]>;
  /** Where the first step should point (a pattern on the control's label); `null`: no guide wanted. */
  first?: RegExp | null;
  /** Only look at the first step, then stop. */
  firstOnly?: boolean;
  goal?: (grafana: Grafana, page: Page) => Promise<boolean>;
}

const dashboard = async (grafana: Grafana) =>
  ((await grafana.api('/api/dashboards/uid/service-overview')) as { dashboard: { panels: Array<{ id: number; title: string }> } }).dashboard;

const cases: Case[] = [
  {
    name: 'fix-prometheus',
    start: '/connections/datasources/edit/prometheus-prod',
    prepare: async (page) => {
      await page.getByRole('button', { name: '保存并测试' }).click();
      await page.waitForTimeout(3000);
    },
    question: '为什么测试失败了？该怎么改？',
    first: /URL/i,
    firstOnly: true,
  },
  {
    name: 'new-mysql',
    start: '/',
    question: '我想新建一个 MySQL 数据源，名字叫 orders，地址是 10.0.0.8:3306，数据库 shop，用户名 app，密码 secret，带我做一遍。',
    values: [
      [/filter|筛选|搜索|search/i, 'MySQL'],
      [/^name$|名称/i, 'orders'],
      [/host|主机|url/i, '10.0.0.8:3306'],
      [/database|数据库/i, 'shop'],
      [/user|用户/i, 'app'],
      [/password|密码/i, 'secret'],
    ],
    first: /连接|数据源|添加新连接|新建|connection/i,
    goal: async (grafana) => ((await grafana.api('/api/datasources')) as Array<{ type: string; name: string; url: string }>).some((d) => d.type === 'mysql' && d.name === 'orders' && d.url === '10.0.0.8:3306'),
  },
  {
    name: 'refresh-off',
    start: '/d/service-overview',
    question: '这个仪表盘一直在自动刷新，怎么关掉？',
    first: /刷新/,
    goal: async (_grafana, page) => !page.url().includes('refresh='),
  },
  {
    name: 'time-7d',
    start: '/d/service-overview',
    question: '把时间范围改成最近 7 天。',
    first: /时间范围/,
    goal: async (_grafana, page) => page.url().includes('from=now-7d'),
  },
  {
    name: 'rename-panel',
    start: '/d/service-overview',
    question: '把 CPU 这个面板的标题改成 CPU usage，再保存仪表盘，带我做一遍。',
    values: [[/标题|title/i, 'CPU usage']],
    goal: async (grafana) => (await dashboard(grafana)).panels.some((panel) => panel.id === 3 && panel.title === 'CPU usage'),
  },
  {
    name: 'scenario-csv',
    start: '/d/service-overview?editPanel=1',
    question: '把这个查询的场景从 Random Walk 换成 CSV Metric Values。',
    values: [[/scenario/i, 'CSV Metric Values']],
    first: /scenario/i,
    goal: async (_grafana, page) => page.getByText('CSV Metric Values', { exact: true }).first().isVisible(),
  },
  {
    name: 'alert-rule-first-step',
    start: '/',
    question: '怎么新建一条告警规则？',
    first: /警报|告警|alert|新建/i,
    firstOnly: true,
  },
  {
    name: 'english-add-datasource',
    start: '/',
    question: 'How do I add a new data source?',
    first: /连接|数据源|添加新连接|新建|connection|data source/i,
    firstOnly: true,
  },
  {
    name: 'no-guide',
    start: '/connections/datasources',
    question: 'TestData 这个数据源是用来做什么的？',
    first: null,
  },
];

interface Target {
  handle: ElementHandle<Element>;
  tag: string;
  type: string;
  role: string;
  label: string;
  disabled: boolean;
}

/** The control under the spotlight: what a user would see highlighted. */
async function highlighted(page: Page): Promise<Target | undefined> {
  const box = await page.locator('[data-doccue-guide] .spot').boundingBox();
  if (!box) return undefined;
  const handle = await page.evaluateHandle(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return (
      element?.closest('button, a, input, select, textarea, [role="button"], [role="tab"], [role="link"], [role="combobox"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]') ??
      element
    );
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) return undefined;
  const info = await element.evaluate((node) => {
    const field = node as HTMLInputElement;
    return {
      tag: node.tagName.toLowerCase(),
      type: field.type ?? '',
      role: node.getAttribute('role') ?? '',
      label: (node.getAttribute('aria-label') ?? field.labels?.[0]?.textContent ?? node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      disabled: field.disabled === true || node.getAttribute('aria-disabled') === 'true',
    };
  });
  return { handle: element, ...info };
}

const valueFor = (test: Case, label: string) => test.values?.find(([pattern]) => pattern.test(label))?.[1];

interface Report {
  pass: boolean;
  first?: string;
  steps: string[];
  answer: string;
  calls: number;
  modelMs: number;
  slowestMs: number;
  tokens: { input: number; cached: number; output: number };
  wallMs: number;
}

async function run(test: Case, browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<Report> {
  const grafana = await startGrafana();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bubble = page.locator('[data-doccue-guide] .bubble');
  const steps: string[] = [];
  let first: string | undefined;
  let guided = false;
  const started = Date.now();
  try {
    await page.goto(`${grafana.url}${test.start}`);
    await page.waitForFunction(() => window.doccue !== undefined, null, { timeout: 20_000 });
    await page.waitForTimeout(2500);
    await test.prepare?.(page);
    await page.locator('[data-doccue-panel] .launcher').click();
    await page.locator('[data-doccue-panel] textarea').fill(test.question);
    await page.locator('[data-doccue-panel] textarea').press('Enter');

    const deadline = Date.now() + 300_000;
    let last = '';
    let repeats = 0;
    await page.waitForFunction(() => window.doccue.guiding() || !window.doccue.busy(), null, { timeout: 240_000, polling: 100 });
    while (await page.evaluate(() => window.doccue?.busy() ?? true).catch(() => true)) {
      try {
        if (Date.now() > deadline) throw new Error('did not finish in time');
        if (!(await bubble.isVisible())) {
          await page.waitForTimeout(300);
          continue;
        }
        guided = true;
        const text = (await bubble.locator('.text').innerText()).trim();
        const target = await highlighted(page);
        if (first === undefined) first = target ? `${target.role || target.tag} "${target.label}"` : '(nothing under the spotlight)';
        if (test.firstOnly) {
          steps.push(`${first}  ← ${text}`);
          await page.evaluate(() => window.doccue.stop());
          break;
        }
        repeats = text === last ? repeats + 1 : 0;
        last = text;
        const value = target ? valueFor(test, target.label) : undefined;
        const combobox = target && (target.role === 'combobox' || target.tag === 'select');
        const field = target && !combobox && (target.tag === 'textarea' || (target.tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes(target.type)));
        let did: string;
        if (!target || target.disabled || repeats >= 2) {
          did = 'Next';
          await bubble.locator('.next').click();
        } else if (combobox) {
          did = `pick "${target.label}"${value ? ` = ${value}` : ''}`;
          await target.handle.click();
          if (value) {
            await page.keyboard.type(value);
            await page.waitForTimeout(500);
            await page.keyboard.press('Enter');
          }
        } else if (field) {
          did = `type "${target.label}" = ${value ?? 'test'}`;
          await target.handle.fill(value ?? 'test');
          await target.handle.press('Tab');
        } else {
          did = `click ${target.role || target.tag} "${target.label}"`;
          await target.handle.click({ timeout: 3000 }).catch(async () => {
            did += ' (could not click: Next)';
            await bubble.locator('.next').click();
          });
        }
        steps.push(`${did}  ← ${text}`);
        await page.waitForTimeout(400);
      } catch (error) {
        if (!String(error).includes('context was destroyed') && !String(error).includes('navigat')) throw error;
        await page.waitForTimeout(300);
      }
    }
    if (!test.firstOnly) await page.waitForFunction(() => !window.doccue.busy(), null, { timeout: 120_000 }).catch(() => undefined);
    const said = await page.locator('[data-doccue-panel] .message.assistant').allInnerTexts().catch(() => []);
    const answer = (said.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 200);

    let pass = true;
    if (test.first === null) pass = !guided;
    else if (test.first) pass = first !== undefined && test.first.test(first);
    if (pass && test.goal && !test.firstOnly) pass = await test.goal(grafana, page);

    const records = readFileSync(grafana.proxy.logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
    const calls = records.filter((record) => record.kind === 'model_call');
    const tokens = { input: 0, cached: 0, output: 0 };
    for (const call of calls) {
      const usage = call.result?.usage;
      if (!usage) continue;
      tokens.input += usage.inputTokens;
      tokens.cached += usage.cacheReadTokens;
      tokens.output += usage.outputTokens;
    }
    return {
      pass,
      first,
      steps,
      answer,
      calls: calls.length,
      modelMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
      slowestMs: Math.max(0, ...calls.map((call) => call.durationMs)),
      tokens,
      wallMs: Date.now() - started,
    };
  } finally {
    await page.close();
    await grafana.close();
  }
}

const filter = process.argv[2];
const selected = cases.filter((test) => !filter || test.name.includes(filter));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
try {
  for (const test of selected) {
    console.log(`\n== ${test.name}\n   ${test.question}`);
    try {
      const report = await run(test, browser);
      if (report.pass) passed++;
      console.log(`   first step: ${report.first ?? '(no guide)'}`);
      for (const step of report.steps) console.log(`     ${step}`);
      console.log(`   answer: ${report.answer}`);
      console.log(
        `   ${report.calls} model calls, ${(report.modelMs / 1000).toFixed(1)} s in the model (slowest ${(report.slowestMs / 1000).toFixed(1)} s), ` +
          `${report.tokens.input} input tokens (${report.tokens.cached} cached), ${report.tokens.output} output; ${(report.wallMs / 1000).toFixed(0)} s in all`,
      );
      console.log(`   ${report.pass ? 'PASS' : 'FAIL'}`);
    } catch (error) {
      console.log(`   error: ${error instanceof Error ? error.message : String(error)}`);
      console.log('   FAIL');
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${passed} / ${selected.length} passed`);
process.exitCode = passed === selected.length ? 0 : 1;
