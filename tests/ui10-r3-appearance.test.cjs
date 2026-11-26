const assert = require('node:assert/strict');
const { readFile, mkdir } = require('node:fs/promises');
const { extname, join, resolve } = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

const root = process.env.G19_VISUAL_ROOT || resolve(__dirname, '..');
const baseline = Boolean(process.env.G19_VISUAL_ROOT);
const screenshots = process.env.G19_VISUAL_SCREENSHOTS;
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

test('UI10-r3 presentation across desktop and mobile, with both themes', async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  if (screenshots) await mkdir(screenshots, { recursive: true });

  async function check(width, theme) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try {
      await context.addInitScript(value => localStorage.setItem('cleaning-theme', value), theme);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'localhost') {
          const file = url.pathname.slice(1) || 'index.html';
          const body = file === 'dyskusje/config.js'
            ? 'window.goleszanDiscussionsConfig={url:"https://fixture.supabase.co",publishableKey:"sb_publishable_test",adminEmail:"admin@example.test"};'
            : await readFile(join(root, file)).catch(() => null);
          if (body === null) return route.fulfill({ status: 404 });
          return route.fulfill({ contentType: mime[extname(file)] || 'application/octet-stream', body });
        }
        if (url.hostname !== 'fixture.supabase.co') return route.abort();
        const endpoint = url.pathname.split('/').at(-1);
        const responses = {
          token: { access_token: 'fixture-admin', expires_in: 3600 },
          g19_rooms: [1, 2, 3, 4].map(room => ({ room, occupied: false })),
        };
        return route.fulfill({ json: responses[endpoint] ?? [], headers: { 'Access-Control-Allow-Origin': '*' } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const shot = async name => {
        if (screenshots && width !== 320) {
          await page.screenshot({ path: join(screenshots, `${baseline ? 'before' : 'after'}-${name}-${theme}-${width}.png`), fullPage: true });
        }
      };
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      const css = (selector, property) => page.locator(selector).first().evaluate((el, key) => getComputedStyle(el)[key], property);
      await page.goto('http://localhost/#ustawienia');
      const legend = page.getByText('Wybierz swój pokój, aby podłączyć urządzenie.', { exact: true });
      await legend.waitFor();
      assert.equal(await css('.cleaning-rules > h2', 'fontSize'), baseline ? '20px' : '22px');
      assert.equal(await css('#settings-title', 'fontSize'), baseline ? '20px' : '22px');
      assert.equal(await css('#room-setup legend', 'fontSize'), baseline ? '16px' : '15px');
      assert.ok(await fits());
      await page.evaluate(() => {
        const days = [...document.querySelectorAll('#calendar-days .calendar-weekend:not(.calendar-adjacent)')];
        const weekends = days.map(day => Number(day.dataset.date))
          .filter(day => new Date(day).getUTCDay() === 6);
        const own = weekends[0];
        const other = weekends.find(day => roomFor(day) !== roomFor(own));
        selectedRoom = String(roomFor(own));
        for (const day of [own, other]) {
          missed.set(new Date(day).toISOString().slice(0, 10), roomFor(day));
        }
        renderCalendar();
      });
      await shot('home');
      await page.locator('#announcements-open').click();
      const off = page.locator('#announcements-panel .push-switch');
      assert.equal(await off.getAttribute('aria-checked'), 'false');
      const notification = await off.evaluate(el => ({
        track: getComputedStyle(el, '::before').backgroundColor,
        label: getComputedStyle(el.querySelector('.push-state')).color,
      }));
      const calendar = {
        fill: await css('#calendar-days .calendar-missed-own', 'backgroundColor'),
        mark: await page.locator('#calendar-days .calendar-missed-other').first()
          .evaluate(el => getComputedStyle(el, '::before').backgroundColor),
      };
      const red = 'rgb(255, 164, 174)';
      const dark = theme === 'dark';
      assert.deepEqual(notification, {
        track: dark && !baseline ? red : 'rgb(212, 68, 84)',
        label: dark ? red : 'rgb(161, 42, 54)',
      });
      assert.deepEqual(calendar, {
        fill: dark ? (baseline ? 'rgb(134, 59, 91)' : red) : 'rgb(141, 54, 88)',
        mark: dark ? (baseline ? 'rgb(246, 142, 175)' : red) : 'rgb(188, 66, 105)',
      });
      await shot('notifications');
      await page.keyboard.press('Escape');
      await page.goto('http://localhost/#administracja');
      await page.getByLabel('Hasło').fill('fixture-password');
      await page.getByRole('button', { name: 'Zaloguj się' }).click();
      await page.locator('#admin-sections [data-section=duties]').click();
      const missed = page.locator('#admin-duty-missed');
      await missed.check();
      assert.equal(await page.locator('#admin-duty-preview-status').textContent(), 'Niewykonany');
      const duty = await page.evaluate(() => ({
        checkbox: getComputedStyle(document.getElementById('admin-duty-missed')).backgroundColor,
        text: getComputedStyle(document.getElementById('admin-duty-preview-status')).color,
        icon: getComputedStyle(document.querySelector('#admin-duty-preview-status').parentElement.querySelector('svg')).color,
      }));
      assert.deepEqual(duty, {
        checkbox: dark && !baseline ? red : 'rgb(194, 36, 49)',
        text: dark ? (baseline ? 'rgb(255, 157, 167)' : red) : 'rgb(185, 35, 48)',
        icon: dark ? (baseline ? 'rgb(255, 157, 167)' : red) : 'rgb(185, 35, 48)',
      });
      const button = page.locator('#admin-refresh');
      const neighbors = () => Promise.all(['#admin-title', '#admin-refresh', '#admin-logout', '#admin-sections']
        .map(selector => page.locator(selector).boundingBox()));
      const before = await neighbors();
      await button.click();
      const feedback = page.getByText('Dane odświeżone.', { exact: true });
      await feedback.waitFor();
      assert.ok(await fits());
      if (!baseline) {
        assert.deepEqual(await neighbors(), before);
        assert.ok((await feedback.boundingBox()).x + (await feedback.boundingBox()).width <= before[1].x);
        assert.equal(await css('#admin-refresh-status', 'borderTopWidth'), '0px');
        assert.equal(await css('#admin-refresh-status', 'backgroundColor'), 'rgba(0, 0, 0, 0)');
      }
      await shot('duties');
      await feedback.waitFor({ state: 'detached' });
      if (!baseline) assert.deepEqual(await neighbors(), before);
      assert.ok(await fits());
      console.log(`${theme} ${width}px: PASS ${JSON.stringify({ notification, calendar, duty })}`);
    } finally {
      await context.close();
    }
  }

  for (const width of [320, 390, 1280]) {
    await Promise.all(['light', 'dark'].map(theme => check(width, theme)));
  }
});
