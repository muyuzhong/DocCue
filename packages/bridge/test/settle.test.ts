import { describe, expect, it } from 'vitest';
import { whenSettled } from '../src/settle.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('whenSettled', () => {
  it('waits for requests to come back and the page to stop changing', async () => {
    document.body.innerHTML = '<p id="status"></p>';
    let busy = true;
    let settled = false;
    const started = Date.now();
    void whenSettled(document, () => busy, { quietMs: 40, maxMs: 1000 }).then(() => (settled = true));

    await sleep(60);
    expect(settled).toBe(false); // a request is still on its way
    busy = false;
    document.querySelector('#status')!.textContent = '连接成功'; // its answer changes the page
    await sleep(25);
    expect(settled).toBe(false); // changed a moment ago
    await sleep(80);
    expect(settled).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('gives up after the maximum wait', async () => {
    const started = Date.now();
    await whenSettled(document, () => true, { quietMs: 20, maxMs: 120 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});
