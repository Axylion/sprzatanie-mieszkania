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
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}${prefix}`;
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert.ok(await page.locator('.hero + .guide-entry').isVisible());
    await page.locator('#theme-select').selectOption('dark');
    await page.locator('.guide-entry').tap();
    const title = page.locator('#guide-title');
    await title.waitFor();
    assert.equal(await title.innerText(), 'Szafki kuchenne i ściana robocza');
    assert.deepEqual(await page.locator('.guide-top a').allTextContents(), ['← Harmonogram']);
    assert.equal(await page.locator('.guide-siblings, .guide-next, .guide-overview').count(), 0);

    const pagination = page.getByRole('navigation', { name: 'Nawigacja kart poradnika' });
    const previous = pagination.getByRole('button', { name: '‹ Poprzednia' });
    const next = pagination.getByRole('button', { name: 'Następna ›' });
    const position = page.locator('.guide-card-position');
    assert.equal(await pagination.count(), 1);
    assert.equal(await page.locator('.guide-article:has(.guide-tip) + .guide-pagination + .guide-categories').count(), 1);
    assert.equal(await position.innerText(), '1 / 8');
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isDisabled(), false);
    assert.equal(await page.locator('.guide-categories a svg').count(), 4);

    const touch = await context.newCDPSession(page);
    async function swipe(x, y, dx, dy) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y }]
      });
      for (let step = 1; step <= 5; step++) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: x + dx * step / 5, y: y + dy * step / 5 }]
        });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }

    await next.tap();
    await page.waitForURL('**/#poradnik/okap');
    await page.waitForFunction(() => document.querySelector('.guide-card-position')?.textContent === '2 / 8' && scrollY === 0);
    assert.equal(await title.evaluate(el => document.activeElement === el), true);
    await previous.tap();
    await page.waitForURL('**/#poradnik/szafki');

    await page.waitForFunction(() => document.querySelector('.guide-card-position')?.textContent === '1 / 8' && scrollY === 0);

    await swipe(80, 300, 180, 0);
    assert.match(page.url(), /#poradnik\/szafki$/);

    for (let index = 1; index < cards.length; index++) {
      await swipe(280, 230, -180, 4);
      await page.waitForURL(`**/#poradnik/${cards[index][0]}`);
      await page.waitForFunction(number => document.querySelector('.guide-card-position')?.textContent === `${number} / 8` && scrollY === 0, index + 1);
    }
    assert.equal(await next.isDisabled(), true);
    await swipe(280, 230, -180, 0);
    assert.match(page.url(), /#poradnik\/podloga$/);
    for (let index = cards.length - 2; index >= 0; index--) {
      await swipe(80, 230, 180, 0);
      await page.waitForURL(`**/#poradnik/${cards[index][0]}`);
      await page.waitForFunction(number => document.querySelector('.guide-card-position')?.textContent === `${number} / 8`, index + 1);
    }

    // A vertical drag scrolls the page, and a diagonal drag leaves the same card open.
    await swipe(240, 400, 0, -190);
    await page.waitForFunction(() => scrollY > 60);
    await swipe(250, 400, -100, -110);
    assert.equal(await position.innerText(), '1 / 8');
    await page.getByRole('navigation', { name: 'Działy poradnika' }).getByRole('link', { name: 'Toalety' }).click();
    await page.waitForURL('**/#poradnik/toaleta');
    await page.waitForFunction(() => document.querySelector('.guide-categories [aria-current]')?.textContent === 'Toalety' && scrollY === 0);

    const photo = page.locator('.guide-photo').first();
    await photo.click();
    const dialog = page.getByRole('dialog', { name: 'Powiększone zdjęcia' });
    assert.ok(await dialog.isVisible());
    assert.match(await dialog.locator('figcaption').innerText(), /^1 \/ 3/);
    await page.waitForFunction(() => {
      const enlarged = document.querySelector('#poradnik-gallery img');
      const thumbnail = document.querySelector('.guide-photo img');
      return enlarged.complete && enlarged.naturalWidth > 0 && enlarged.clientWidth > thumbnail.clientWidth;
    });
    const enlargedPhoto = await dialog.locator('img').boundingBox();
    const galleryY = Math.round(enlargedPhoto.y + enlargedPhoto.height / 2);
    await swipe(280, galleryY, -180, 0);
    assert.match(await dialog.locator('figcaption').innerText(), /^2 \/ 3/);
    assert.match(page.url(), /#poradnik\/toaleta$/);
    await swipe(80, galleryY, 180, 0);
    assert.match(await dialog.locator('figcaption').innerText(), /^1 \/ 3/);
    await dialog.getByRole('button', { name: 'Następne zdjęcie' }).click();
    assert.match(await dialog.locator('figcaption').innerText(), /^2 \/ 3/);
    await page.keyboard.press('ArrowLeft');
    assert.match(await dialog.locator('figcaption').innerText(), /^1 \/ 3/);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await photo.evaluate(el => document.activeElement === el), true);
    await photo.click();
    await dialog.getByRole('button', { name: 'Zamknij zdjęcie' }).click();
    assert.equal(await dialog.isVisible(), false);

    await page.getByRole('navigation', { name: 'Działy poradnika' }).getByRole('link', { name: 'Pozostałe' }).click();
    await page.waitForURL('**/#poradnik/powierzchnie');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('#guide-title')?.textContent.startsWith('WC,'));
    await page.goBack();
    await page.waitForURL('**/#poradnik/szafki');
    await page.goForward();
    await page.waitForURL('**/#poradnik/toaleta');
    await page.waitForFunction(() => document.querySelector('.guide-card-position')?.textContent === '5 / 8' && scrollY === 0);
    await page.getByRole('link', { name: '← Harmonogram' }).click();
    await page.locator('.hero').waitFor();
    await page.goBack();
    await page.waitForURL('**/#poradnik/toaleta');
    await page.goForward();
    await page.locator('.hero').waitFor();
    assert.equal(await page.locator('#theme-select').inputValue(), 'dark');

    // All photos must be usable on their first offline visit, including photos in the steps.
    await context.setOffline(true);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [index, [id, section]] of cards.entries()) {
        await page.goto(`${url}#poradnik/${id}`);
        await page.waitForFunction(number => document.querySelector('.guide-card-position')?.textContent === `${number} / 8`, index + 1);
        await page.waitForFunction(expected => {
          const images = [...document.querySelectorAll('.guide-photo img')];
          const illustrations = [...document.querySelectorAll('.guide-illustration img')];
          return images.length === expected && illustrations.length > 0 &&
            [...images, ...illustrations].every(img => img.complete && img.naturalWidth > 0);
        }, id === 'zlewozmywak' ? 7 : 3);
        assert.equal(await page.locator('.guide-categories [aria-current]').innerText(), section);
        assert.equal(await position.innerText(), `${index + 1} / 8`);
        assert.equal(await previous.isDisabled(), index === 0);
        assert.equal(await next.isDisabled(), index === 7);
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
