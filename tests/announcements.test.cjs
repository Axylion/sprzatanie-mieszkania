// Run: npm install --no-save playwright && node --test tests/announcements.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mimeTypes = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};
const announcement = (id, body, extra = {}) => ({
  id, title: 'Informacja ' + id, body, publishedAt: '2026-01-01T12:00:00Z', ...extra
});

test('PWA v11-1 to v12 update under the GitHub Pages subpath', async () => {
  let legacy = true;
  const prefix = '/sprzatanie-mieszkania/';
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) { res.writeHead(404); return res.end(); }
    const name = pathname.slice(prefix.length) || 'index.html';
    const target = path.join(root, name);
    if (!fs.existsSync(target)) { res.writeHead(404); return res.end(); }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', mimeTypes[path.extname(name)] || 'text/html');
    const contents = fs.readFileSync(target);
    res.end(name === 'sw.js' && legacy
      ? contents.toString().replace('shell-v12', 'shell-v11-1')
      : contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install({time:new Date('2026-11-04T12:00:00Z')});
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      const cache = await caches.open('goleszan19-shell-v11-1');
      await cache.put('./announcements.json', new Response('[{"stale":true}]'));
    });
    legacy = false;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(async () => {
      const keys = await caches.keys();
      return keys.includes('goleszan19-shell-v12') && !keys.includes('goleszan19-shell-v11-1');
    });
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelector('.announcement-toggle')?.hidden === false);
    assert.deepEqual(await page.evaluate(async () => (await fetch('./announcements.json')).json()), JSON.parse(fs.readFileSync(path.join(root,'announcements.json'),'utf8')));
    await page.locator('.announcement-dismiss').click();
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => !document.querySelector('#announcements-restore').hidden);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await context.setOffline(true);
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelectorAll('#schedule .schedule-row').length === 12);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.equal(await page.locator('#announcements-restore').isVisible(), false);
    await page.getByRole('button', {name:'Pokój nr 3',exact:true}).click();
    await page.getByRole('button', {name:'Potwierdź pokój'}).click();
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => localStorage.getItem('cleaning-room') === '3' && document.querySelector('#room-setup').hidden);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !document.querySelector('#announcements-restore').hidden);
    await page.locator('#announcements-restore').click();
    assert.equal(await page.locator('.announcement-entry').count(), 1);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
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
    res.setHeader('Content-Type', mimeTypes[path.extname(file)] || 'text/html');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install({time:new Date('2026-11-04T12:00:00Z')});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelectorAll('#schedule .schedule-row').length === 12);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [roomFor(BASE),roomFor(BASE + WEEK),roomFor(BASE + 2*WEEK),roomFor(BASE - WEEK),roomFor(Date.UTC(2027,0,2))]), [3,4,1,2,4]);
    data = [announcement('a', long), announcement('b', long), announcement('short','Krótki tekst.'),
      announcement('future',long,{publishedAt:'2099-01-01'}), announcement('expired',long,{expiresAt:'2026-01-02'}), {id:'invalid'}];
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    for (const width of [320, 360, 390, 430, 768, 1280]) {
      await page.setViewportSize({width,height:844});
      for (const theme of ['light','dark']) {
        await page.selectOption('#theme-select', theme);
        await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(47, 136, 66)');
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).color), 'rgb(255, 255, 255)');
        assert.equal(await page.locator('#announcements-card').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 246, 175)');
        assert.equal(await page.locator('#announcements-heading').evaluate(e => getComputedStyle(e).fontWeight), '700');
        assert.equal(await page.locator('.announcement-entry').nth(2).locator('.announcement-toggle').isVisible(), false);
        const first = page.locator('.announcement-entry').nth(0);
        assert.equal(await first.locator('.announcement-toggle').isVisible(), true);
        assert.ok(await first.locator('p').evaluate(e => Math.abs(e.clientHeight - parseFloat(getComputedStyle(e).lineHeight)*3) < 2));
        await first.locator('.announcement-toggle').click();
        assert.equal(await first.locator('.announcement-toggle').textContent(), 'Zwiń ↑');
        assert.equal(await page.locator('.announcement-entry').nth(1).locator('.announcement-toggle').getAttribute('aria-expanded'), 'false');
        await first.locator('.announcement-toggle').click();
        assert.equal(await first.locator('.announcement-toggle').textContent(), 'Więcej ↓');
        if (process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`mobile-${width}-${theme}.png`),fullPage:true});
      }
    }
    assert.ok(await page.locator('#announcements-card').evaluate(e => e.compareDocumentPosition(document.querySelector('.intro')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await page.locator('.announcement-date').first().textContent(), 'Opublikowano: 1 sty 2026');
    // Icon, 26px transparent circle, 44px hit target and keyboard operation.
    assert.equal(await page.locator('#shortcut-open svg').count(), 1);
    assert.equal(await page.locator('#shortcut-open svg').evaluate(e => getComputedStyle(e).stroke), 'rgb(255, 255, 255)');
    const dismiss = page.locator('.announcement-dismiss').first();
    assert.match(await dismiss.getAttribute('aria-label'), /na tym urządzeniu/);
    assert.deepEqual(await dismiss.evaluate(e => ({width:e.offsetWidth,height:e.offsetHeight,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,svg:e.querySelector('svg').getBoundingClientRect().width})), {width:44,height:44,bg:'rgba(0, 0, 0, 0)',color:'rgb(51, 51, 51)',svg:26});
    assert.equal(await page.locator('#announcements-restore').isVisible(), false);
    await dismiss.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.announcement-entry').count(), 2);
    assert.equal(await page.locator('#announcements-restore').isVisible(), true);
    assert.equal(await page.locator('.announcement-dismiss').first().evaluate(e => e === document.activeElement), true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 2);
    // Separate device/browser context still sees all announcements; JSON is unchanged.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(url);
    await otherPage.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    await other.close();
    assert.equal(data.length, 6);
    await page.locator('.announcement-dismiss').first().click();
    await page.locator('.announcement-dismiss').first().click();
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.equal(await page.locator('#announcements-card').evaluate(e => e.getBoundingClientRect().height), 0);
    const restore = page.getByRole('button', {name:'Pokaż ukryte ogłoszenia',exact:true});
    assert.equal(await restore.isVisible(), true);
    if (process.env.AXE_PATH) {
      await page.addScriptTag({path:process.env.AXE_PATH});
      const violations = await page.evaluate(async () => (await axe.run({include:['#announcements-restore']})).violations);
      assert.deepEqual(violations.map(v => v.id), []);
    }
    assert.equal(await restore.evaluate(e => e === document.activeElement), true);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#announcements-restore').hidden);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await restore.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.announcement-entry').count(), 3);
    assert.equal(await restore.isVisible(), false);
    assert.equal(await page.locator('.announcement-dismiss').first().evaluate(e => e === document.activeElement), true);
    // Reused IDs with new publication dates/title/body/version must not inherit hiding.
    await page.locator('.announcement-dismiss').first().click();
    const original = {...data[0]};
    for (const change of [{title:'Zmieniony tytuł'}, {body:'Zmieniona treść'}, {publishedAt:'2026-02-01T12:00:00Z'}, {updatedAt:'2026-02-01T12:00:00Z'}, {id:'new-id'}]) {
      data[0] = {...original, ...change};
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    }
    // Corrupt storage and storage quota/permission errors do not break announcements.
    await page.evaluate(() => localStorage.setItem('goleszan19-hidden-announcements-v1', '{bad json'));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await page.locator('.announcement-dismiss').first().click();
    assert.equal(await page.locator('.announcement-entry').count(), 2);
    await restore.click();
    assert.equal(await page.locator('.announcement-entry').count(), 3);
    // System theme follows OS changes.
    await page.reload();
    await page.selectOption('#theme-select', 'system');
    await page.emulateMedia({colorScheme:'dark'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.emulateMedia({colorScheme:'light'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    // Verify the shipped, explicitly labelled sample really overflows on desktop.
    data = JSON.parse(fs.readFileSync(path.join(root,'announcements.json'),'utf8'));
    assert.equal(data.length, 1);
    assert.equal(data[0].expiresAt, '2026-11-16T00:00:00+01:00');
    assert.match(data[0].body, /TO JEST OGŁOSZENIE TESTOWE/);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.announcement-toggle')?.hidden === false);
    assert.ok(await page.locator('.announcement-body').evaluate(e => Math.abs(e.clientHeight - parseFloat(getComputedStyle(e).lineHeight)*3) < 2));
    if (process.env.SCREENSHOT_DIR) {
      for (const width of [360,1280]) {
        await page.setViewportSize({width,height:900});
        for (const theme of ['light','dark']) {
          await page.selectOption('#theme-select',theme);
          await page.waitForTimeout(250); // Poczekaj na przejście kolorów motywu przed zrzutem.
          await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`sample-${width}-${theme}.png`),fullPage:true});
          if (process.env.AXE_PATH) {
            await page.addScriptTag({path:process.env.AXE_PATH});
            const audit = await page.evaluate(async () => (await axe.run({include:['#announcements-card','#shortcut-open']}, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','best-practice']}})).violations);
            // Zatwierdzone kolory przycisku #2f8842 / white mają kontrast 4.45:1 (< 4.5:1).
            // Tylko ten istniejący wyjątek jest dopuszczony; pozostałe elementy muszą przejść audyt.
            assert.deepEqual(audit.flatMap(v => v.nodes.filter(n => !(v.id === 'color-contrast' && n.target.length === 1 && n.target[0] === '#shortcut-open')).map(n => ({id:v.id,target:n.target}))), []);
          }
        }
      }
    }
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
      const c = await caches.open('goleszan19-shell-v12');
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
    await page.getByRole('button',{name:'Pokój nr 2',exact:true}).click();
    await page.getByRole('button', {name:'Potwierdź pokój'}).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cleaning-room')), '2');
    assert.equal(await page.locator('#room-setup').isVisible(), false);
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

test('Warsaw expiry, live timers and local restore on devices in other timezones', async () => {
  const data = [
    announcement('permanent', 'Bez terminu'),
    announcement('date', 'Do końca dnia', {expiresAt:'2026-11-04'}),
    announcement('instant', 'Do konkretnej godziny', {expiresAt:'2026-11-05T00:00:02'}),
    announcement('future', 'Późniejsza publikacja', {publishedAt:'2026-11-05T00:00:03'}),
    announcement('invalid-date', 'Nieprawidłowa data', {expiresAt:'2026-02-30'}),
    announcement('invalid-type', 'Nieprawidłowy typ', {expiresAt:123}),
    announcement('invalid-empty', 'Pusty termin', {expiresAt:''})
  ];
  const server = http.createServer((req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname;
    if (file === '/announcements.json') {
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify(data));
    }
    const target = path.join(root, file === '/' ? 'index.html' : file);
    if (!fs.existsSync(target)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', mimeTypes[path.extname(file)] || 'text/html');
    res.end(fs.readFileSync(target));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
  try {
    const pages = [];
    const errors = [];
    for (const timezoneId of ['America/Los_Angeles','Asia/Tokyo']) {
      const context = await browser.newContext({timezoneId,serviceWorkers:'block'});
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.clock.install({time:new Date('2026-11-04T22:59:58Z')});
      await page.clock.pauseAt(new Date('2026-11-04T22:59:59Z'));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
      pages.push(page);
      const parsed = await page.evaluate(() => [
        parseAnnouncementDate('2026-11-04T12:30:00'),
        parseAnnouncementDate('2026-07-01T12:30'),
        parseAnnouncementDate('2026-11-04',true),
        parseAnnouncementDate('2026-03-29',true),
        parseAnnouncementDate('2026-10-25',true),
        parseAnnouncementDate('2026-10-25T02:30'),
        parseAnnouncementDate('2026-11-05T00:00:02+01:00'),
        parseAnnouncementDate('2026-11-04T23:00:02Z'),
        parseAnnouncementDate('2026-11-05T08:00:02+09:00')
      ].map(value => new Date(value).toISOString()));
      assert.deepEqual(parsed,[
        '2026-11-04T11:30:00.000Z','2026-07-01T10:30:00.000Z',
        '2026-11-04T23:00:00.000Z','2026-03-29T22:00:00.000Z',
        '2026-10-25T23:00:00.000Z','2026-10-25T00:30:00.000Z',
        '2026-11-04T23:00:02.000Z','2026-11-04T23:00:02.000Z','2026-11-04T23:00:02.000Z'
      ]);
      assert.equal(await page.evaluate(() => [
        '2026-03-29T02:30','2026-02-30','2026-11-04T24:00','bad',''
      ].every(value => Number.isNaN(parseAnnouncementDate(value)))),true);
      // W dni zmiany czasu sam dzień trwa odpowiednio 23 i 25 godzin.
      assert.deepEqual(await page.evaluate(() => ['2026-03-29','2026-10-25'].map(value =>
        (parseAnnouncementDate(value,true)-parseAnnouncementDate(value))/3600000)),[23,25]);
    }
    const [page, other] = pages;
    const hide = id => page.getByRole('button',{name:'Ukryj ogłoszenie na tym urządzeniu: Informacja '+id,exact:true}).click();
    await hide('permanent');
    await hide('instant');
    assert.equal(await page.locator('.announcement-entry').count(),1);
    assert.equal(await other.locator('.announcement-entry').count(),3);
    // Dokładnie o północy w Warszawie ogłoszenie z samą datą znika na obu urządzeniach.
    for (const p of pages) await p.clock.runFor(1000);
    assert.equal(await page.locator('#announcements-card').isVisible(),false);
    assert.equal(await page.locator('#announcements-card').evaluate(e => e.getBoundingClientRect().height),0);
    assert.equal(await other.locator('.announcement-entry').count(),2);
    await page.locator('#announcements-restore').click();
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja permanent','Informacja instant']);
    await hide('instant');
    for (const p of pages) await p.clock.runFor(2000);
    assert.equal(await page.locator('#announcements-restore').isVisible(),false);
    assert.deepEqual(await other.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    // Termin nie usuwa wpisu z JSON i nie można go przywrócić lokalną funkcją.
    await hide('permanent');
    await page.locator('#announcements-restore').click();
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    assert.deepEqual(await page.evaluate(async () => (await fetch('./announcements.json')).json()),data);
    // Zaplanowana publikacja również uwzględnia Warsaw i działa bez przeładowania.
    for (const p of pages) await p.clock.runFor(1000);
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja future','Informacja permanent']);
    assert.equal(await page.locator('#announcements-restore').isVisible(),false);
    // Wpisy bez expiresAt pozostają aktywne także po miesiącu.
    for (const p of pages) {
      await p.clock.fastForward(16 * 86400000);
      await p.clock.fastForward(16 * 86400000);
    }
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja future','Informacja permanent']);
    // Przedłużony termin jest nową wersją, nie dziedziczy wcześniejszego ukrycia.
    data[2].expiresAt = '2099-12-31';
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.announcement-entry').length === 3);
    assert.equal(await page.locator('.announcement-entry h3').allTextContents().then(t => t.includes('Informacja instant')),true);
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
