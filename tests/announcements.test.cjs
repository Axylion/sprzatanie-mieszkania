// Run: npm install --no-save playwright && node --test tests/announcements.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const announcement = (id, body, extra = {}) => ({
  id, title: 'Informacja ' + id, body, publishedAt: '2026-01-01T12:00:00Z', ...extra
});
const long = 'Pierwszy wiersz\nDrugi wiersz\nTrzeci wiersz\nCzwarty wiersz\nPiąty wiersz';

test('mobile announcements, refresh, themes and offline PWA', async () => {
  let data = [], requests = [], fail = false;
  const server = http.createServer((req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname;
    if (file === '/announcements.json') {
      requests.push(req.headers);
      res.writeHead(fail ? 503 : 200, {'Content-Type':'application/json', 'Cache-Control':'public, max-age=86400'});
      return res.end(JSON.stringify(data));
    }
    const target = path.join(root, file === '/' ? 'index.html' : file);
    if (!fs.existsSync(target)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('#schedule .schedule-row').length === 12);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    data = [announcement('a', long), announcement('b', long), announcement('short','Krótki tekst.'),
      announcement('future',long,{publishedAt:'2099-01-01'}), announcement('expired',long,{expiresAt:'2026-01-02'}), {id:'invalid'}];
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({width,height:844});
      for (const theme of ['light','dark']) {
        await page.selectOption('#theme-select', theme);
        await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(47, 136, 66)');
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).color), 'rgb(255, 255, 255)');
        assert.equal(await page.locator('#announcements-card').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 246, 175)');
        assert.equal(await page.locator('#announcements-heading').evaluate(e => getComputedStyle(e).fontWeight), '700');
        assert.equal(await page.locator('.announcement-entry').nth(2).locator('button').isVisible(), false);
        const first = page.locator('.announcement-entry').nth(0);
        assert.equal(await first.locator('button').isVisible(), true);
        assert.ok(await first.locator('p').evaluate(e => Math.abs(e.clientHeight - parseFloat(getComputedStyle(e).lineHeight)*3) < 2));
        await first.locator('button').click();
        assert.equal(await first.locator('button').textContent(), 'Zwiń ↑');
        assert.equal(await page.locator('.announcement-entry').nth(1).locator('button').getAttribute('aria-expanded'), 'false');
        await first.locator('button').click();
        assert.equal(await first.locator('button').textContent(), 'Więcej ↓');
        if (process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`mobile-${width}-${theme}.png`),fullPage:true});
      }
    }
    assert.ok(await page.locator('#announcements-card').evaluate(e => e.compareDocumentPosition(document.querySelector('.intro')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await page.locator('.announcement-date').first().textContent(), 'Opublikowano: 1 sty 2026');
    data = [announcement('fresh','Świeża wiadomość')];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.querySelector('.announcement-entry h3')?.textContent === 'Informacja fresh');
    data = [];
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForFunction(() => document.querySelector('#announcements-card').hidden);
    data = [announcement('online','Nowa wiadomość')];
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !document.querySelector('#announcements-card').hidden);
    fail = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelector('#announcements-card').hidden);
    fail = false;
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    // Even a deliberately seeded stale PWA response must never be used for news.
    await page.evaluate(async () => {
      const c = await caches.open('goleszan19-shell-v3');
      await c.put('./announcements.json',new Response('[{"stale":true}]'));
    });
    assert.deepEqual(await page.evaluate(async () => (await fetch('./announcements.json')).json()), data);
    assert.ok(requests.some(headers => headers['cache-control']?.includes('no-cache')));
    await page.locator('#shortcut-open').click();
    assert.equal(await page.locator('#shortcut-help').isVisible(), true);
    await page.locator('#shortcut-close').click();
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#schedule .schedule-row').length === 12);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await page.getByRole('button',{name:'Pokój 2',exact:true}).click();
    assert.match(await page.locator('#personal-result').textContent(), /pokoju nr 2/);
    await page.locator('#toggle-schedule').click();
    assert.equal(await page.locator('#schedule .schedule-row:visible').count(), 12);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !document.querySelector('#announcements-card').hidden);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
