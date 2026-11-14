/** What the agent sees of a long page, in a real browser, and whether the model can still point into it. */
import type { ScreenNode } from '@doccue/bridge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPage, openPlayground, type Playground } from './page.js';

let playground: Playground;
beforeAll(async () => {
  playground = await openPlayground();
  // 40 more datasources than the three the mock starts with.
  for (let i = 0; i < 40; i++) {
    await fetch(`${playground.url}/api/datasources`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `ds-${i}`, kind: 'MySQL', host: `10.1.0.${i}`, port: 3306 }),
    });
  }
});
afterAll(() => playground?.close());

const find = (nodes: readonly ScreenNode[], role: string): ScreenNode | undefined => {
  for (const node of nodes) {
    if (node.role === role) return node;
    const inner = find(node.children ?? [], role);
    if (inner) return inner;
  }
  return undefined;
};
/** The name in the first cell of each row listed. */
const rowNames = (table: ScreenNode) => (table.children ?? []).filter((row) => row.role === 'row').map((row) => row.children?.[0]?.name);

describe('a long table', () => {
  it('shows the agent the rows on screen and counts the others', async () => {
    const user = await openPage(playground, '/datasource');
    await user.page.getByText('ds-39', { exact: true }).scrollIntoViewIfNeeded();
    const screen = await user.page.evaluate(() => window.doccue.perceive().screen);
    const table = find(screen.nodes, 'table')!;
    const names = rowNames(table);
    expect(table.more).toBeGreaterThan(0);
    expect(names.length + table.more!).toBe(44); // the header row and 43 datasources
    expect(names).toContain('ds-39'); // on screen
    expect(names).not.toContain('mysql-prod'); // scrolled away at the top
  });

  it('lets the model point at the row the user means', async () => {
    const user = await openPage(playground, '/datasource');
    await user.page.getByText('ds-38', { exact: true }).scrollIntoViewIfNeeded();
    await user.ask('帮我删掉 ds-38 这个数据源');
    await user.bubble();
    const row = await user.page.evaluate(() => {
      const box = document.querySelector('[data-doccue-guide]')!.shadowRoot!.querySelector('.spot')!.getBoundingClientRect();
      const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { text: element?.textContent?.trim(), row: element?.closest('tr')?.querySelector('td')?.textContent };
    });
    expect(row).toEqual({ text: '删除', row: 'ds-38' });
    await user.page.locator('[data-doccue-guide] .exit').click();
    await user.idle();
  });
});
