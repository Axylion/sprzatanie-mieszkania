const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFile } = require('node:fs/promises');
const { extname, join } = require('node:path');
const { chromium, firefox } = require('playwright');

const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css'};
for (const [name, engine, executablePath] of [
  ['Chromium', chromium, process.env.CHROME_PATH],
  ['Firefox', firefox, process.env.PLAYWRIGHT_FIREFOX_PATH]
]) {
  test(name + ' keeps keyboard focus visible on actions, not on programmatic headings', async t => {
    const browser = await engine.launch({executablePath});
    t.after(() => browser.close());
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.route('http://localhost:41789/**', async route => {
      const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      try {
        const body = path === 'dyskusje/config.js' ? '' : await readFile(join(__dirname, '..', path));
        await route.fulfill({body, contentType:mime[extname(path)]});
      } catch {
        await route.fulfill({status:404});
      }
    });
    const page = await context.newPage();
    for (const theme of ['light', 'dark']) {
      await page.goto('http://localhost:41789/');
      await page.evaluate(mode => {
        document.documentElement.dataset.theme = mode;
        document.querySelector('#admin-view').hidden = false;
        document.querySelector('#admin-panel').hidden = false;
        document.querySelector('#discussion-view').hidden = false;
        document.querySelector('#discussion-chat').hidden = false;
        const heading = document.querySelector('#private-peer-title');
        for (let element = heading.parentElement; element && element.id !== 'discussion-view'; element = element.parentElement) {
          element.hidden = false;
        }
        const row = Object.assign(document.createElement('div'), {className:'discussion-reactions'});
        row.innerHTML = '<button type="button" data-reaction="1" aria-pressed="true">1</button>' +
          '<button type="button" data-reaction="-1" aria-pressed="false">0</button>';
        document.querySelector('#discussion-chat').append(row);
      }, theme);
      const visibleOutline = el => getComputedStyle(el).outlineStyle !== 'none' && parseFloat(getComputedStyle(el).outlineWidth) > 0;
      for (const id of ['admin-title', 'private-peer-title']) {
        const heading = page.locator('#' + id);
        await heading.focus();
        assert.equal(await heading.evaluate(visibleOutline), false);
      }
      const pressed = page.locator('button[data-reaction="1"]');
      const unpressed = page.locator('button[data-reaction="-1"]');
      assert.notEqual(await pressed.evaluate(el => getComputedStyle(el).backgroundColor),
        await unpressed.evaluate(el => getComputedStyle(el).backgroundColor));
      assert.equal(await unpressed.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)');
      await pressed.focus();
      await page.keyboard.press('Tab');
      assert.equal(await unpressed.evaluate(el => document.activeElement === el), true);
      assert.equal(await unpressed.evaluate(visibleOutline), true);

      await page.locator('#notification-open').click();
      const readAll = page.locator('#notification-read-all');
      await readAll.evaluate(el => { el.hidden = false; });
      const close = page.getByRole('button', {name:'Zamknij powiadomienia'});
      assert.equal(await close.evaluate(el => document.activeElement === el), true);
      await page.keyboard.press('Tab');
      assert.equal(await readAll.evaluate(el => document.activeElement === el), true);
      assert.equal(await readAll.evaluate(el => el.matches(':focus-visible') &&
        getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#notification-panel').isVisible(), false);
    }
  });
}
