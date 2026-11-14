/** Using the bridge's built-in chat panel from a script, the way a user would. */
import type { Bridge } from '@doccue/bridge';
import type { Page } from 'playwright-core';

/** Opens the panel: the round button, or "Open" on the bar while a guide is on the page. */
export async function openPanel(page: Page): Promise<void> {
  await page.locator('[data-doccue-panel] .root').waitFor({ state: 'attached' });
  const expand = page.locator('[data-doccue-panel] .expand');
  const launcher = page.locator('[data-doccue-panel] .launcher');
  if (await expand.isVisible()) await expand.click();
  else if (await launcher.isVisible()) await launcher.click();
}

declare global {
  interface Window {
    /** The page exposes its bridge for tests and the console. */
    doccue: Bridge;
  }
}

/** Whether an answer is on its way or a guide is on the page. */
export function isBusy(page: Page): Promise<boolean> {
  return page.evaluate(() => window.doccue.busy());
}

/** Waits until a guide is on the page or the answer is over. */
export async function guideOrAnswer(page: Page): Promise<void> {
  await page.waitForFunction(() => window.doccue.guiding() || !window.doccue.busy(), null, { timeout: 240_000, polling: 100 });
}
