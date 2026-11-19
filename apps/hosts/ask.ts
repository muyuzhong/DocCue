/**
 * Questions on a real host app with the real model: a script plays the user. It asks, then does
 * whatever the guide points at (clicks, types the case's values, picks from dropdowns by typing
 * and pressing Enter), across pages and menus, and reports for each case where the first step
 * pointed, every step, whether the goal was reached, and the model's time and tokens.
 *
 *   pnpm --filter @doccue/hosts ask <app> [case name part]
 *
 * Each case gets a fresh copy of the app. DOCS=off gives DocCue none of the app's docs, to see
 * what they change. Uses the system Chrome and the model from the root .env.
 */
import { readFileSync } from 'node:fs';
import type { Bridge } from '@doccue/bridge';
import type { LogRecord } from '@doccue/core';
import { chromium, type ElementHandle, type Page } from 'playwright-core';
import { hostApp, resolvePath, type Case, type HostApp } from './host.js';

declare global {
  interface Window {
    doccue: Bridge;
  }
}

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
      label: (node.getAttribute('aria-label') ?? field.labels?.[0]?.textContent ?? (node.getAttribute('placeholder') || node.textContent) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      disabled: field.disabled === true || node.getAttribute('aria-disabled') === 'true',
    };
  });
  return { handle: element, ...info };
}

const valueFor = (test: Case, label: string) => test.values?.find(([pattern]) => pattern.test(label))?.[1];

interface Report {
  pass: boolean;
  /** Why it failed, when it did. */
  why?: string;
  /** guide calls the backend sent back to the model as invalid. */
  rejected: number;
  /** Time to the first text, per model call. */
  firstOutput: number[];
  first?: string;
  steps: string[];
  answer: string;
  calls: number;
  modelMs: number;
  slowestMs: number;
  tokens: { input: number; cached: number; output: number };
  wallMs: number;
}

async function run(app: HostApp, test: Case, browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<Report> {
  const host = await app.start({ language: test.language, docs: process.env.DOCS !== 'off' });
  const page = await host.newPage(browser);
  const bubble = page.locator('[data-doccue-guide] .bubble');
  const steps: string[] = [];
  let first: string | undefined;
  let guided = false;
  const started = Date.now();
  try {
    await page.goto(`${host.url}${await resolvePath(test.start, host)}`);
    await page.waitForFunction(() => window.doccue !== undefined, null, { timeout: 20_000 });
    await page.waitForTimeout(2500);
    await test.prepare?.(page);
    await page.locator('[data-doccue-panel] .launcher').click();
    await page.locator('[data-doccue-panel] textarea').fill(test.question);
    await page.locator('[data-doccue-panel] textarea').press('Enter');

    const deadline = Date.now() + 300_000;
    let last = '';
    let repeats = 0;
    let loadingSince: number | undefined;
    await page.waitForFunction(() => window.doccue.guiding() || !window.doccue.busy(), null, { timeout: 240_000, polling: 100 });
    while (await page.evaluate(() => window.doccue?.busy() ?? true).catch(() => true)) {
      try {
        if (Date.now() > deadline) throw new Error('did not finish in time');
        // A page stuck loading: reload it, as a person would after a while.
        const loading = app.loading ? await page.evaluate((source) => new RegExp(source).test(document.body.innerText), app.loading.source) : false;
        loadingSince = loading ? (loadingSince ?? Date.now()) : undefined;
        if (loadingSince !== undefined && Date.now() - loadingSince > 6000) {
          steps.push('(page stuck loading: reload)');
          loadingSince = undefined;
          await page.reload();
          await page.waitForTimeout(1000);
          continue;
        }
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
        // By the field's label, else by what the bubble says (a date picker's input may be labelled "Datepicker input").
        const value = target ? (valueFor(test, target.label) ?? valueFor(test, text)) : undefined;
        const combobox = target && (target.role === 'combobox' || target.tag === 'select');
        const field = target && !combobox && (target.tag === 'textarea' || (target.tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes(target.type)));
        let did: string;
        // A file chooser is not something the script can fill: it moves on as a person without the file would.
        if (!target || target.disabled || repeats >= 2 || target.type === 'file') {
          did = 'Next';
          await bubble.locator('.next').click();
        } else if (combobox) {
          did = `pick "${target.label}"${value ? ` = ${value}` : ''}`;
          await target.handle.click();
          if (value) {
            // Filter the list, then click the option, as a person would.
            await page.keyboard.type(value);
            await page.waitForTimeout(500);
            const option = page.getByRole('option', { name: value, exact: true }).first();
            if (await option.isVisible().catch(() => false)) await option.click();
            else await page.keyboard.press('Enter');
          }
        } else if (field && value && /^\d{4}-\d{2}-\d{2}$/.test(value) && (await target.handle.evaluate((node) => (node as HTMLInputElement).readOnly || node.getAttribute('inputmode') === 'none'))) {
          // A date picker that takes no typing: open it and click the day, as a person would. Cases
          // use a date in the month it opens on.
          did = `pick date "${target.label}" = ${value}`;
          await target.handle.click();
          await page.waitForTimeout(500);
          const day = String(Number(value.slice(8)));
          // The day of this month, not the same number from the month before or after shown around it.
          const cells = page.locator('[role="gridcell"], td').filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) });
          let clicked = false;
          for (let i = 0; i < (await cells.count()) && !clicked; i++) {
            const cell = cells.nth(i);
            const outside = await cell.evaluate((node) => /offset|outside|other|adjacent|disabled/i.test(`${node.className} ${node.firstElementChild?.className ?? ''}`));
            if (outside || !(await cell.isVisible().catch(() => false))) continue;
            await cell.click();
            clicked = true;
          }
          if (!clicked) did += ' (no day to click)';
          await page.waitForTimeout(300);
          const confirm = page.getByRole('button', { name: /^(select|选择|确定|apply|ok)$/i }).first();
          if (await confirm.isVisible().catch(() => false)) await confirm.click();
        } else if (field) {
          // A field the case has no value for gets something that fits it.
          const typed = value ?? (target.type === 'number' ? '1' : 'test');
          did = `type "${target.label}" = ${typed}`;
          await target.handle.fill(typed);
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
    const fullAnswer = (said.at(-1) ?? '').replace(/\s+/g, ' ');
    const answer = fullAnswer.slice(0, 300);

    let why: string | undefined;
    if (test.first === null && guided) why = 'guided, but no guide was wanted';
    else if (test.first && !(first !== undefined && test.first.test(first))) why = 'first step pointed elsewhere';
    else if (test.goal && !test.firstOnly && !(await test.goal(host, page))) why = 'goal not reached';
    else if (test.says && !test.says.test(`${steps.join(' ')} ${fullAnswer}`)) why = `the answer does not say ${test.says}`;
    else if (test.never?.test(`${steps.join(' ')} ${fullAnswer}`)) why = `the answer says ${test.never}`;
    if (!why && test.answerIn) {
      const said = `${steps.join(' ')} ${fullAnswer}`;
      const cjk = (said.match(/[\u4e00-\u9fff]/g) ?? []).length;
      const latin = (said.match(/[A-Za-z]/g) ?? []).length;
      if (test.answerIn === 'en' && cjk >= latin) why = 'answered in Chinese to an English question';
      // Chinese with names and URLs in Latin letters: a good share of Chinese characters is enough.
      if (test.answerIn === 'zh' && cjk < 20) why = 'answered in English to a Chinese question';
    }
    if (why && test.orSaid?.test(`${steps.join(' ')} ${fullAnswer}`)) why = undefined;
    const pass = why === undefined;

    const records = readFileSync(host.proxy.logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogRecord);
    const calls = records.filter((record) => record.kind === 'model_call');
    const rejected = new Set<string>();
    for (const call of calls)
      for (const message of call.request.messages)
        if (message.role === 'tool') for (const result of message.results) if (result.isError) rejected.add(result.callId);
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
      ...(why ? { why } : {}),
      rejected: rejected.size,
      firstOutput: calls.flatMap((call) => (call.firstOutputMs === undefined ? [] : [call.firstOutputMs])),
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
    await host.close();
  }
}

const app = await hostApp(process.argv[2]);
const filter = process.argv[3];
const selected = app.cases.filter((test) => !filter || test.name.includes(filter));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
try {
  for (const test of selected) {
    console.log(`\n== ${test.name}\n   ${test.question}`);
    try {
      const report = await run(app, test, browser);
      if (report.pass) passed++;
      console.log(`   first step: ${report.first ?? '(no guide)'}`);
      for (const step of report.steps) console.log(`     ${step}`);
      console.log(`   answer: ${report.answer}`);
      const seconds = (ms: number) => (ms / 1000).toFixed(1);
      const firsts = report.firstOutput;
      console.log(
        `   ${report.calls} model calls${report.rejected ? ` (${report.rejected} guide calls rejected)` : ''}, ${seconds(report.modelMs)} s in the model (slowest ${seconds(report.slowestMs)} s` +
          `${firsts.length ? `, first text after ${seconds(firsts.reduce((a, b) => a + b, 0) / firsts.length)} s on average` : ''}), ` +
          `${report.tokens.input} input tokens (${report.tokens.cached} cached), ${report.tokens.output} output; ${(report.wallMs / 1000).toFixed(0)} s in all`,
      );
      console.log(`   ${report.pass ? 'PASS' : `FAIL: ${report.why}`}`);
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
