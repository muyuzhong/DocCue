/**
 * Guides across whole page loads, as in a classic multi-page app: the settings pages are reached
 * by plain links, and their form really posts to the server, which redirects. The real model
 * leads; the test does what the spotlight points at.
 */
import type { Item } from '@doccue/bridge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guideResults, openPage, openPlayground, type Playground } from './page.js';

let playground: Playground;
beforeAll(async () => {
  playground = await openPlayground();
});
afterAll(() => playground?.close());

describe('a multi-page app', () => {
  it('guides through two page loads and a form post, and hears what each led to', async () => {
    const user = await openPage(playground, '/dashboard');
    await user.ask('帮我把通知邮箱改成 ops@example.com，带我做一遍。');

    const done: string[] = [];
    const deadline = Date.now() + 200_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`not finished; did: ${done.join(' / ')}`);
      // Between pages there is no bridge for a moment.
      const state = await user.page.evaluate(() => (window.doccue ? { busy: window.doccue.busy(), guiding: window.doccue.guiding() } : undefined)).catch(() => undefined);
      if (state && !state.busy) break;
      if (!state?.guiding || !(await user.page.locator('[data-doccue-guide] .bubble').isVisible())) {
        await user.page.waitForTimeout(300);
        continue;
      }
      const target = await user.highlighted();
      if (target === 'input#email') {
        await user.page.locator('#email').fill('ops@example.com');
        await user.page.locator('#email').press('Tab');
      } else if (target?.startsWith('a ') || target?.startsWith('button "保存"')) {
        // A plain link or the form's submit: a whole new page.
        await Promise.all([user.page.waitForEvent('load'), user.page.mouse.click(...(await spotCenter()))]);
        await user.ready();
      } else {
        await user.page.locator('[data-doccue-guide] .next').click();
      }
      done.push(target ?? '?');
      await user.page.waitForTimeout(400);
    }

    const { email } = (await (await fetch(`${playground.url}/api/settings`)).json()) as { email: string };
    expect(email).toBe('ops@example.com');
    expect(done).toEqual(expect.arrayContaining(['a "设置"', 'a "修改通知邮箱"', 'input#email', 'button "保存"']));

    // The click on Save posted the form; on the next page the bridge told the model where it led.
    const conversation: Item[] = await user.conversation();
    const saved = guideResults(conversation).find((item) => item.result.perception.actions.some((entry) => entry.action?.target?.name === '保存'));
    expect(saved?.result.outcome).toBe('completed');
    expect(saved?.result.perception.screen.page.path).toBe('/settings');
    expect(saved?.result.perception.actions.find((entry) => entry.action?.target?.name === '保存')?.effects).toContainEqual({ type: 'navigate', page: { path: '/settings' } });
    expect((await user.answers()).at(-1)).toMatch(/ops@example\.com|已保存|改好/);

    async function spotCenter(): Promise<[number, number]> {
      const box = (await user.page.locator('[data-doccue-guide] .spot').boundingBox())!;
      return [box.x + box.width / 2, box.y + box.height / 2];
    }
  });
});
