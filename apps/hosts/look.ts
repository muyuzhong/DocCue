/**
 * What the agent sees on a host app, without calling the model: opens a set of screens in the
 * system Chrome, takes the bridge's screen snapshot on each, and prints it as the model reads it,
 * with counts of what may be wrong (controls without a name, nodes cut by the size cap, content
 * the snapshot cannot reach: shadow roots, iframes, canvases).
 *
 *   pnpm --filter @doccue/hosts look <app> [screen name part]
 *
 * Each run starts a fresh copy of the app.
 * Snapshots and screenshots go to apps/hosts/.cache/look/<app>/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bridge } from '@doccue/bridge';
import { renderScreen, type ScreenNode } from '@doccue/core';
import { chromium } from 'playwright-core';
import { hostApp, resolvePath } from './host.js';

declare global {
  interface Window {
    doccue: Bridge;
  }
}

const CONTROLS = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider', 'spinbutton', 'listbox']);

function count(nodes: ScreenNode[], out = { nodes: 0, controls: 0, unnamed: [] as string[] }) {
  for (const node of nodes) {
    out.nodes++;
    if (CONTROLS.has(node.role)) {
      out.controls++;
      if (!node.name) out.unnamed.push(`[${node.ref}] ${node.role}${node.value ? ` = "${node.value}"` : ''}`);
    }
    count(node.children ?? [], out);
  }
  return out;
}

const app = await hostApp(process.argv[2]);
const filter = process.argv[3];
const host = await app.start();
const base = host.url;
const outDir = fileURLToPath(new URL(`.cache/look/${app.name}/`, import.meta.url));
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  for (const view of app.views.filter((v) => !filter || v.name.includes(filter))) {
    const page = await host.newPage(browser);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const path = await resolvePath(view.path, host);
    await page.goto(`${base}${path}`);
    await page.waitForFunction(() => window.doccue !== undefined, null, { timeout: 20_000 });
    await page.waitForTimeout(3000);
    if (view.prepare) {
      await view.prepare(page);
      await page.waitForTimeout(800);
    }
    const started = Date.now();
    const perception = await page.evaluate(() => window.doccue.perceive());
    const took = Date.now() - started;
    const unseen = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      return {
        elements: all.length,
        shadowRoots: all.filter((element) => element.shadowRoot && !element.hasAttribute('data-doccue-panel') && !element.hasAttribute('data-doccue-guide')).length,
        iframes: document.querySelectorAll('iframe').length,
        canvases: document.querySelectorAll('canvas').length,
      };
    });
    const text = renderScreen(perception.screen);
    const stats = count(perception.screen.nodes);
    writeFileSync(join(outDir, `${view.name}.txt`), `${text}\n`);
    await page.screenshot({ path: join(outDir, `${view.name}.png`) });
    console.log(`\n== ${view.name}  ${path}`);
    console.log(
      `   DOM ${unseen.elements} elements → snapshot ${stats.nodes} nodes, ${stats.controls} controls, ${text.length} chars, ${took} ms` +
        `${perception.screen.truncated ? `, ${perception.screen.truncated} cut by the cap` : ''}`,
    );
    if (unseen.shadowRoots || unseen.iframes || unseen.canvases) console.log(`   not reachable: ${unseen.shadowRoots} shadow roots, ${unseen.iframes} iframes, ${unseen.canvases} canvases`);
    if (stats.unnamed.length > 0) console.log(`   controls without a name (${stats.unnamed.length}): ${stats.unnamed.slice(0, 12).join(', ')}${stats.unnamed.length > 12 ? ' …' : ''}`);
    if (errors.length > 0) console.log(`   page errors: ${errors.slice(0, 3).join(' | ')}`);
    await page.close();
  }
  console.log(`\nsnapshots and screenshots: ${outDir}`);
} finally {
  await browser.close();
  await host.close();
}
