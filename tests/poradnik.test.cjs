const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const prefix = '/sprzatanie-mieszkania/';
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
const cards = [
  ['szafki', 'Kuchnia'], ['okap', 'Kuchnia'], ['urzadzenia', 'Kuchnia'],
  ['zlewozmywak', 'Kuchnia'], ['toaleta', 'Toalety'], ['kabina', 'Łazienka'],
  ['powierzchnie', 'Pozostałe'], ['podloga', 'Pozostałe']
];

test('guide routes, accessible gallery, responsive layout and offline links under GitHub Pages', async () => {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith(prefix)) {
      const target = path.join(root, pathname.slice(prefix.length) || 'index.html');
      try {
        const body = await fs.readFile(target);
        res.writeHead(200, { 'Content-Type': types[path.extname(target)], 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch (_) {}
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROME_PATH,
      args: ['--no-sandbox']
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}${prefix}`;
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.ok(await page.locator('.hero + .guide-entry').isVisible());
    await page.locator('#theme-select').selectOption('dark');
    await page.locator('.guide-entry').tap();
    await page.getByRole('heading', { name: 'Poradnik sprzątania' }).waitFor();
    assert.equal(await page.locator('.guide-card-links a').count(), 8);
    await page.getByRole('link', { name: 'WC, umywalka, lustro i szafki' }).tap();
    await page.locator('#guide-title').waitFor();
    assert.match(page.url(), /#poradnik\/toaleta$/);
    assert.equal(await page.locator('.guide-categories [aria-current]').innerText(), 'Toalety');

    const photo = page.locator('.guide-photo').first();
    await photo.tap();
    const dialog = page.getByRole('dialog', { name: 'Powiększone zdjęcia' });
    assert.ok(await dialog.isVisible());
    assert.match(await dialog.locator('figcaption').innerText(), /^1 \/ 3/);
    await page.waitForFunction(() => {
      const enlarged = document.querySelector('#poradnik-gallery img');
      const thumbnail = document.querySelector('.guide-photo img');
      return enlarged.complete && enlarged.naturalWidth > 0 && enlarged.clientWidth > thumbnail.clientWidth;
    });
    await dialog.getByRole('button', { name: 'Następne zdjęcie' }).tap();
    assert.match(await dialog.locator('figcaption').innerText(), /^2 \/ 3/);
    await page.keyboard.press('ArrowLeft');
    assert.match(await dialog.locator('figcaption').innerText(), /^1 \/ 3/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await photo.evaluate(el => document.activeElement === el), true);
    await photo.tap();
    await dialog.getByRole('button', { name: 'Zamknij zdjęcie' }).tap();
    assert.equal(await dialog.isVisible(), false);

    await page.getByRole('navigation', { name: 'Działy poradnika' }).getByRole('link', { name: 'Pozostałe' }).tap();
    await page.waitForURL('**/#poradnik/powierzchnie');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#guide-title')?.textContent.startsWith('WC,'));
    await page.goBack();
    await page.getByRole('heading', { name: 'Poradnik sprzątania' }).waitFor();
    await page.goBack();
    await page.locator('.hero').waitFor();
    assert.equal(await page.locator('#theme-select').inputValue(), 'dark');

    // All photos must be usable on their first offline visit, including photos in the steps.
    await context.setOffline(true);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [id, section] of cards) {
        await page.goto(`${url}#poradnik/${id}`);
        await page.waitForFunction(expected => {
          const images = [...document.querySelectorAll('.guide-photo img')];
          const illustrations = [...document.querySelectorAll('.guide-illustration img')];
          return images.length === expected && illustrations.length > 0 &&
            [...images, ...illustrations].every(img => img.complete && img.naturalWidth > 0);
        }, id === 'zlewozmywak' ? 7 : 3);
        assert.equal(await page.locator('.guide-categories [aria-current]').innerText(), section);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.locator('.guide-panel h2 svg').first().evaluate(svg => getComputedStyle(svg).width), '36px');
        if (process.env.SCREENSHOT_DIR && (width === 390 || width === 1280)) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${id}-${width}.png`), fullPage: true });
        }
      }
      // Reloading a direct link requires the cached HTML, CSS, scripts, and photos.
      await page.reload();
      await page.waitForFunction(() => [...document.querySelectorAll('.guide-photo img')].filter(img => img.complete && img.naturalWidth > 0).length === 3);
      assert.equal(await page.locator('#guide-title').innerText(), 'Podłoga i wycieraczka');
    }
    await page.getByRole('link', { name: '← Harmonogram' }).click();
    await page.locator('#next-room').waitFor();
    assert.equal(await page.locator('#schedule .schedule-row').count(), 12);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
