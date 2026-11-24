const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFile } = require('node:fs/promises');
const { extname, join } = require('node:path');
const { chromium } = require('playwright');

test('Calendar marks the local date in both themes and refreshes at local midnight', async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const mimeTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };
  const start = new Date('2026-11-07T07:59:59.500Z');
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
    try {
      await context.route('http://127.0.0.1:41961/**', async route => {
        const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
        try {
          const body = path === 'dyskusje/config.js' ? '' : await readFile(join(__dirname, '..', path));
          await route.fulfill({ body, contentType: mimeTypes[extname(path)] });
        } catch {
          await route.fulfill({ status: 404 });
        }
      });
      await context.addInitScript(mode => {
        localStorage.setItem('cleaning-theme', mode);
        localStorage.setItem('cleaning-room', '4');
      }, theme);
      const page = await context.newPage();
      await page.clock.install({ time: new Date(start.getTime() - 10_000) });
      await page.clock.pauseAt(start);
      await page.goto('http://127.0.0.1:41961/');
      await page.clock.runFor(50);
      const today = page.locator('#calendar-days [aria-current="date"]');
      const underline = () => today.evaluate(el => {
        const style = getComputedStyle(el, '::after');
        return [style.height, style.backgroundColor];
      });

      // In Warsaw it is already Saturday. The viewer is still on Friday, November 6.
      assert.equal(await today.textContent(), '6');
      assert.equal(await today.evaluate(el => el.classList.contains('calendar-weekend')), false);
      assert.deepEqual(await underline(), ['3px', theme === 'light' ? 'rgb(0, 114, 121)' : 'rgb(99, 229, 239)']);

      await page.clock.runFor(1000);
      assert.equal(await today.textContent(), '7');
      assert.equal(await today.evaluate(el => el.classList.contains('calendar-own')), true);
      assert.equal(await today.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(8, 109, 114)');
      assert.deepEqual(await underline(), ['3px', 'rgb(186, 255, 248)']);

      await page.locator('#calendar-next-month').evaluate(el => el.click());
      assert.equal(await today.count(), 0);
      await page.locator('#calendar-prev').evaluate(el => el.click());
      assert.equal(await today.textContent(), '7');
    } finally {
      await context.close();
    }
  }
});
