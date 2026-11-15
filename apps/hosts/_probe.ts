import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5180/d/service-overview');
await page.waitForTimeout(3000);
await page.getByTestId('data-testid TimePicker Open Button').click();
await page.waitForTimeout(800);
console.log(await page.evaluate(() => {
  const input = [...document.querySelectorAll('input')].find((i) => i.labels?.[0]?.textContent === '最近 7 天') as HTMLInputElement;
  const label = input.labels![0]!;
  const r = input.getBoundingClientRect(), lr = label.getBoundingClientRect();
  const cx = lr.x + lr.width / 2, cy = lr.y + lr.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return JSON.stringify({ input: [r.x, r.y, r.width, r.height], opacity: getComputedStyle(input).opacity, label: [lr.x, lr.y, lr.width, lr.height], labelVisible: label.checkVisibility({ checkVisibilityCSS: true }), hitAtLabelCenter: `${hit?.tagName} ${hit?.textContent?.slice(0, 30)}` });
}));
await browser.close();
