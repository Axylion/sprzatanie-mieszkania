// Run: npm install --no-save playwright && node --test tests/announcements.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
async function setTheme(page, theme) {
  await page.locator('#theme-toggle').click();
  await page.locator('#theme-menu label:has(input[value="' + theme + '"])').click();
}

const mimeTypes = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
};
const publicRpc = '/rest/v1/rpc/g19_public_announcements';
const testConfig = 'window.goleszanDiscussionsConfig = {url:location.origin,publishableKey:"sb_publishable_testing"};';
const announcement = (id, body, extra = {}) => ({
  id, title: 'Informacja ' + id, body, publishedAt: '2026-01-01T12:00:00Z', ...extra
});

test('PWA v13-10-1 to v13-10-2 update under the GitHub Pages subpath', async () => {
  let legacy = true;
  const prefix = '/sprzatanie-mieszkania/';
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === publicRpc) {
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify([{
        ...announcement('postgres-microseconds','Dłuższa informacja o pracach. '.repeat(20)),
        publishedAt:'2026-11-15T23:03:38.627737+00:00',
        expiresAt:'2026-12-15T23:03:38.627737+00:00',
        version:1
      }, announcement('expired','Archiwalny tekst',{
        publishedAt:'2026-11-13T11:00:00.50001+00:00', expiresAt:'2026-11-16T07:00:00.123456+00:00'
      })]));
    }
    if ([prefix + 'dyskusje/config.js', '/dyskusje/config.js'].includes(pathname)) {
      res.setHeader('Content-Type','text/javascript');
      return res.end(testConfig);
    }
    const name = pathname.slice(pathname.startsWith(prefix) ? prefix.length : 1) || 'index.html';
    const target = path.join(root, name);
    if (!fs.statSync(target, {throwIfNoEntry:false})?.isFile()) {
      res.setHeader('Content-Type', 'text/html');
      return res.end(fs.readFileSync(path.join(root, 'index.html')));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', mimeTypes[path.extname(name)] || 'text/html');
    const contents = fs.readFileSync(target);
    res.end(name === 'sw.js' && legacy
      ? contents.toString().replace('shell-v13-10-2', 'shell-v13-10-1')
      : contents);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:390,height:750}});
  // Capture requests from the navigation start, before the canonical document loads.
  for (const mount of ['/', prefix]) {
    for (const route of ['administracja', 'dyskusje', 'poradnik', 'harmonogram', 'calendar-title']) {
      const clean = await browser.newContext({serviceWorkers:'block'});
      try {
        const first = await clean.newPage();
        const base = `http://127.0.0.1:${server.address().port}${mount}`;
        const misplaced = [], errors = [];
        first.on('request', request => {
          const pathname = new URL(request.url()).pathname;
          if (pathname.startsWith(mount + route + '/') &&
              ['stylesheet','script','image','manifest'].includes(request.resourceType()) &&
              !fs.statSync(path.join(root, pathname.slice(mount.length)), {throwIfNoEntry:false})?.isFile()) {
            misplaced.push(request.url());
          }
        });
        first.on('console', entry => { if (entry.type() === 'error' && entry.text().includes('MIME type')) errors.push(entry.text()); });
        const hash = route === 'administracja' ? '#dyskusje' : '#' + route;
        await first.goto(base + route + '/?utm_source=chatgpt.com' + (route === 'administracja' ? hash : ''));
        await first.waitForURL(base + '?utm_source=chatgpt.com' + hash, {waitUntil:'load'});
        assert.ok(await first.evaluate(() => [...document.querySelectorAll('head > link[rel=stylesheet]')].every(link => link.sheet?.cssRules.length)));
        assert.equal(await first.locator('head > link[rel=stylesheet]').count(), 2);
        assert.equal(await first.evaluate(() => Boolean(window.g19AnnouncementContent)), true);
        assert.deepEqual(misplaced, []);
        assert.deepEqual(errors, []);
      } finally { await clean.close(); }
    }

  }
  const page = await context.newPage();
  await page.clock.install({time:new Date('2026-11-16T08:00:00Z')});
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      const cache = await caches.open('goleszan19-shell-v13-10-1');
      await cache.put('./announcements.json', new Response('[{"stale":true}]'));
      localStorage.setItem('goleszan19-hidden-announcements-v1', JSON.stringify([JSON.stringify(['old-hidden', 1])]));
      localStorage.removeItem('goleszan19-hidden-announcements-v2');
    });
    legacy = false;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForFunction(async () => {
      const keys = await caches.keys();
      return keys.includes('goleszan19-shell-v13-10-2') && !keys.includes('goleszan19-shell-v13-10-1');
    });
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelector('.announcement-toggle')?.hidden === false);
    assert.equal(await page.locator('#ogloszenie-postgres-microseconds').count(),1);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('goleszan19-hidden-announcements-v2'))?.includes('old-hidden'));
    assert.equal(await page.locator('#ogloszenie-expired').count(),0);
    assert.equal(await page.evaluate(() => parseAnnouncementDate('2026-11-15T23:03:38.627737+00:00')),
      Date.parse('2026-11-15T23:03:38.627Z'));
    assert.deepEqual(await page.evaluate(async () => (await fetch('./announcements.json')).json()), JSON.parse(fs.readFileSync(path.join(root,'announcements.json'),'utf8')));
    const appUrl = `http://127.0.0.1:${server.address().port}${prefix}`;
    await page.goto(appUrl + '#calendar-title');
    await page.waitForFunction(() => {
      const target = document.getElementById('calendar-title').getBoundingClientRect();
      return location.hash === '#calendar-title' && scrollY > 0 && target.top >= 0 && target.bottom <= innerHeight;
    });
    const announcementId = await page.locator('.announcement-entry').first().getAttribute('id');
    await page.goto(appUrl + '#' + announcementId);
    await page.waitForFunction(id => {
      const target = document.getElementById(id)?.getBoundingClientRect();
      return location.hash === '#' + id && target && target.top >= 0 && target.top < innerHeight;
    }, announcementId);
    const mimeErrors = [];
    page.on('console', entry => { if (entry.type() === 'error' && entry.text().includes('MIME type')) mimeErrors.push(entry.text()); });
    for (const width of [390, 1280]) {
      await page.setViewportSize({width,height:850});
      // The intermediate HTML redirects synchronously; wait for the actual route below,
      // rather than a load event from the document being discarded.
      await page.goto(appUrl + 'administracja/?utm_source=chatgpt.com#dyskusje', {waitUntil:'commit'});
      await page.waitForURL(appUrl + '?utm_source=chatgpt.com#dyskusje');
      await page.locator('#discussion-view').waitFor();
      for (const [route, selector] of [
        ['administracja', '#admin-view'],
        ['dyskusje', '#discussion-view'],
        ['poradnik', '#poradnik-view'],
        ['harmonogram', '#harmonogram']
      ]) {
        await page.goto(appUrl + route + '/?check=1', {waitUntil:'commit'});
        await page.waitForURL(appUrl + '?check=1#' + route);
        await page.locator(selector).waitFor();
        assert.equal(await page.locator('.brand-icon svg').evaluate(icon=>icon.getBoundingClientRect().width),25);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.evaluate(()=>[...document.querySelectorAll('link[rel=stylesheet]')].every(link=>link.sheet?.cssRules.length > 0)),true);
      }
      assert.deepEqual(await page.locator('.dashboard-links svg').evaluateAll(icons=>icons.map(icon=>icon.getBoundingClientRect().width)),[24]);
      assert.equal(await page.locator('#calendar-days').evaluate(element=>getComputedStyle(element).display),'grid');
    }
    const shadow = locator => locator.evaluate(element => getComputedStyle(element).boxShadow);
    async function checkTextLink(selector) {
      const link = page.locator(selector).first();
      await link.hover();
      assert.equal(await shadow(link), 'none', selector);
      assert.match(await link.evaluate(element => getComputedStyle(element).textDecorationLine), /underline/);
      await page.keyboard.press('Tab');
      await link.focus();
      assert.equal(await link.evaluate(element => element.matches(':focus-visible')), true, selector);
      assert.notEqual(await link.evaluate(element => getComputedStyle(element).outlineStyle), 'none', selector);
    }
    async function checkControl(selector) {
      const control = page.locator(selector).first();
      await page.mouse.move(0,0);
      const before = await shadow(control);
      await control.hover();
      if (await page.evaluate(()=>innerWidth>=760 && document.documentElement.dataset.theme==='dark')) {
        assert.equal(await shadow(control), 'none', selector);
        assert.equal(await control.evaluate(el=>getComputedStyle(el).filter), 'brightness(1.08)', selector);
      } else assert.notEqual(await shadow(control), before, selector);
    }
    for (const width of [390,1280]) {
      await page.setViewportSize({width,height:850});
      for (const theme of ['light','dark']) {
        await page.goto(appUrl + '#harmonogram');
        await setTheme(page, theme);
        await checkControl('.brand-icon');
        await checkControl('#theme-toggle');
        await checkControl('.dashboard-links .guide-entry');
        assert.equal(await page.locator('#calendar-days button, #calendar-days [aria-pressed]').count(),0);
        await checkTextLink('footer #admin-link');
        await page.goto(appUrl + '#dyskusje');
        await checkTextLink('#discussion-view .guide-home-link');
        await page.goto(appUrl + '#poradnik');
        await checkTextLink('#poradnik-view .guide-home-link');
        await checkControl('#poradnik-view .guide-categories a[aria-current]');
        await page.goto(appUrl + '#administracja');
        await checkTextLink('#admin-view .guide-home-link');
      }
    }
    await page.goto(appUrl + '#harmonogram');
    assert.deepEqual(mimeErrors, []);
    await page.locator('.announcement-entry').first().waitFor();
    await page.locator('.announcement-dismiss').click();
    await page.reload({waitUntil:"domcontentloaded"});
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await context.setOffline(true);
    await page.goto(appUrl + 'administracja/#harmonogram');
    await page.waitForURL(appUrl + '#harmonogram');
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => document.querySelectorAll('#calendar-days .calendar-day').length >= 28);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.equal(await page.locator('#announcements-restore').count(), 0);
    await page.getByRole('button', {name:'Pokój nr 3',exact:true}).click();
    await page.getByRole('button', {name:'Potwierdź pokój'}).click();
    await page.reload({waitUntil:"domcontentloaded"});
    await page.waitForFunction(() => localStorage.getItem('cleaning-room') === '3' && document.querySelector('#room-setup').hidden);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#announcements-open').click();
    await page.locator('#hidden-announcements-list button').first().click();
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
    if (file === '/dyskusje/config.js') {
      res.setHeader('Content-Type','text/javascript');
      return res.end(testConfig);
    }
    if (file === publicRpc) {
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
    await page.waitForFunction(() => document.querySelectorAll('#calendar-days .calendar-day').length >= 28);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => [roomFor(BASE),roomFor(BASE + WEEK),roomFor(BASE + 2*WEEK),roomFor(BASE - WEEK),roomFor(Date.UTC(2027,0,2))]), [3,4,1,2,4]);
    const month = page.locator('#calendar-month');
    const days = page.locator('#calendar-days .calendar-day');
    const next = page.getByRole('button', { name: 'Następny miesiąc' });
    const prev = page.getByRole('button', { name: 'Poprzedni miesiąc' });
    assert.equal(await month.textContent(), 'listopad 2026');
    assert.equal(await page.locator('#calendar-days span[aria-hidden="true"]').count(), 12);
    assert.equal(await days.count(), 30);
    assert.match(await page.locator('#calendar-next').textContent(), /7–8 listopada 2026 · Pokój 4/);
    await next.click();
    assert.equal(await month.textContent(), 'grudzień 2026');
    assert.ok(await days.getByText('26', { exact: true }).evaluate(el => el.classList.contains('calendar-weekend')));
    await next.click();
    assert.equal(await month.textContent(), 'styczeń 2027');
    assert.ok(await days.getByText('2', { exact: true }).evaluate(el => el.classList.contains('calendar-weekend')));
    await days.getByText('4', { exact: true }).click();
    assert.equal(await page.locator('#calendar-days [aria-pressed]').count(),0);
    await next.click();
    assert.equal(await days.count(), 28);
    await page.clock.setFixedTime(new Date('2028-02-10T12:00:00Z'));
    await page.reload();
    assert.equal(await month.textContent(), 'luty 2028');
    assert.equal(await days.count(), 29);
    await prev.click();
    assert.equal(await month.textContent(), 'styczeń 2028');
    await page.clock.setFixedTime(new Date('2026-11-04T12:00:00Z'));
    await page.reload();

    data = [announcement('b', long, {legacyHideKey:'shared'}), announcement('short','Krótki tekst.'),
      announcement('a', long, {publishedAt:'2026-01-02T12:00:00Z',legacyHideKey:'shared'}),
      announcement('future',long,{publishedAt:'2099-01-01'}), announcement('expired',long,{expiresAt:'2026-01-02'}), {id:'invalid'}];
    await page.reload();
    const slide = page.locator('.announcement-entry');
    const position = page.locator('#announcement-position');
    const nextSlide = page.getByRole('button', {name:'Następne ogłoszenie'});
    const previousSlide = page.getByRole('button', {name:'Poprzednie ogłoszenie'});
    await page.locator('#ogloszenie-a').waitFor();
    assert.equal(await slide.count(),1);
    assert.equal(await position.textContent(),'1 / 3');
    assert.equal(await previousSlide.isDisabled(),true);
    await nextSlide.click();
    assert.equal(await slide.getAttribute('id'),'ogloszenie-b');
    await nextSlide.press('ArrowRight');
    assert.equal(await slide.getAttribute('id'),'ogloszenie-short');
    assert.equal(await slide.locator('.announcement-toggle').isVisible(),false);
    assert.equal(await nextSlide.isDisabled(),true);
    await previousSlide.click();
    await previousSlide.click();
    const swipe = dx => slide.locator('.announcement-body').evaluate((element, dx) => {
      const init = {pointerId:4, pointerType:'touch', isPrimary:true, bubbles:true, clientY:100};
      element.dispatchEvent(new PointerEvent('pointerdown', {...init,clientX:120}));
      element.dispatchEvent(new PointerEvent('pointerup', {...init,clientX:120+dx}));
    }, dx);
    await swipe(-90);
    assert.equal(await slide.getAttribute('id'),'ogloszenie-b');
    await swipe(90);
    assert.equal(await slide.getAttribute('id'),'ogloszenie-a');
    for (const width of [320, 360, 390, 430, 768, 1280]) {
      await page.setViewportSize({width,height:844});
      for (const theme of ['light','dark']) {
        await setTheme(page, theme);
        await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(47, 136, 66)');
        assert.equal(await page.locator('#shortcut-open').evaluate(e => getComputedStyle(e).color), 'rgb(255, 255, 255)');
        assert.equal(await page.locator('#announcements-card').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 246, 175)');
        assert.equal(await page.locator('#announcements-heading').evaluate(e => getComputedStyle(e).fontWeight), '700');
        const first = page.locator('.announcement-entry').nth(0);
        assert.equal(await first.locator('.announcement-toggle').isVisible(), true);
        assert.ok(await first.locator('p').evaluate(e => Math.abs(e.clientHeight - parseFloat(getComputedStyle(e).lineHeight)*3) < 2));
        await first.locator('.announcement-toggle').click();
        assert.equal(await first.locator('.announcement-toggle').textContent(), 'Zwiń ↑');
        await nextSlide.click();
        assert.equal(await slide.locator('.announcement-toggle').getAttribute('aria-expanded'), 'false');
        await previousSlide.click();
        assert.equal(await slide.locator('.announcement-toggle').getAttribute('aria-expanded'), 'true');
        await first.locator('.announcement-toggle').click();
        assert.equal(await first.locator('.announcement-toggle').textContent(), 'Więcej ↓');
        if (process.env.SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,`mobile-${width}-${theme}.png`),fullPage:true});
      }
    }
    assert.ok(await page.locator('#announcements-card').evaluate(e => e.compareDocumentPosition(document.querySelector('.intro')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await page.locator('.announcement-date').first().textContent(), 'Opublikowano: 2 sty 2026');
    // Icon, 26px transparent circle, 44px hit target and keyboard operation.
    assert.equal(await page.locator('#shortcut-open svg').count(), 1);
    assert.equal(await page.locator('#shortcut-open svg').evaluate(e => getComputedStyle(e).stroke), 'rgb(255, 255, 255)');
    const dismiss = page.locator('.announcement-dismiss').first();
    assert.match(await dismiss.getAttribute('aria-label'), /na tym urządzeniu/);
    assert.deepEqual(await dismiss.evaluate(e => ({width:e.offsetWidth,height:e.offsetHeight,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color,svg:e.querySelector('svg').getBoundingClientRect().width})), {width:44,height:44,bg:'rgba(0, 0, 0, 0)',color:'rgb(51, 51, 51)',svg:26});
    await page.locator('#announcements-open').click();
    assert.equal(await page.locator('#hidden-announcements-list button').count(),3);
    await page.getByRole('button', { name: 'Zamknij ogłoszenia' }).click();
    await dismiss.focus();
    await page.keyboard.press('Enter');
    assert.equal(await slide.getAttribute('id'),'ogloszenie-b');
    assert.equal(await position.textContent(),'1 / 2');
    assert.equal(await page.locator('.announcement-dismiss').first().evaluate(e => e === document.activeElement), true);
    await page.reload();
    await page.locator('#ogloszenie-b').waitFor();
    await page.goto(url + '#ogloszenie-a');
    await page.locator('#ogloszenie-a').waitFor();
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('goleszan19-hidden-announcements-v2'))),['a']);
    await nextSlide.click();
    assert.equal(await slide.getAttribute('id'),'ogloszenie-b');
    // Separate device/browser context still sees all announcements; JSON is unchanged.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(url);
    await otherPage.locator('#ogloszenie-a').waitFor();
    await other.close();
    assert.equal(data.length, 6);
    await page.locator('.announcement-dismiss').first().click();
    await page.locator('.announcement-dismiss').first().click();
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    assert.equal(await page.locator('#announcements-card').evaluate(e => e.getBoundingClientRect().height), 0);
    const restore = page.locator('#announcements-open');
    assert.equal(await restore.evaluate(e => e === document.activeElement), true);
    await page.reload();
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await restore.click();
    const hidden = page.locator('#hidden-announcements-list button');
    await hidden.first().waitFor();
    assert.equal(await hidden.count(), 3);
    if (process.env.AXE_PATH) {
      await page.addScriptTag({path:process.env.AXE_PATH});
      const violations = await page.evaluate(async () => (await axe.run({include:['#announcements-panel']})).violations);
      assert.deepEqual(violations.map(v => v.id), []);
    }
    await hidden.filter({hasText:'Informacja a'}).click();
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(), ['Informacja a']);
    await page.reload();
    await page.locator('#ogloszenie-a').waitFor();
    assert.equal(await page.locator('.announcement-entry').count(), 1);
    for (const title of ['Informacja b', 'Informacja short']) {
      await restore.click();
      await hidden.filter({hasText:title}).click();
    }
    // Editing keeps the same ID hidden; a different ID does not inherit its state.
    await dismiss.click();
    data[1] = {...data[1], title:'Zmieniony tytuł', version:2};
    await page.reload();
    await page.locator('#ogloszenie-a').waitFor();
    assert.equal(await position.textContent(),'1 / 2');
    data[1] = {...data[1], id:'new-id', publishedAt:'2026-02-01T12:00:00Z'};
    await page.reload();
    await page.locator('#ogloszenie-new-id').waitFor();
    assert.equal(await position.textContent(),'1 / 3');
    await page.evaluate(() => localStorage.setItem('goleszan19-hidden-announcements-v2', '{bad json'));
    await page.reload();
    await page.locator('#ogloszenie-new-id').waitFor();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }; });
    await dismiss.click();
    assert.equal(await position.textContent(),'1 / 2');
    await restore.click();
    await hidden.filter({hasText:'Zmieniony tytuł'}).click();
    assert.equal(await slide.getAttribute('id'),'ogloszenie-new-id');
    assert.equal(await position.textContent(),'1 / 3');
    // System theme follows OS changes.
    await page.reload();
    await setTheme(page, 'system');
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
    assert.ok(await page.locator('#announcements-card .announcement-body').evaluate(e => Math.abs(e.clientHeight - parseFloat(getComputedStyle(e).lineHeight)*3) < 2));
    if (process.env.SCREENSHOT_DIR) {
      for (const width of [360,1280]) {
        await page.setViewportSize({width,height:900});
        for (const theme of ['light','dark']) {
          await setTheme(page, theme);
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
      const c = await caches.open('goleszan19-shell-v13-10-2');
      await c.put('./announcements.json',new Response('[{"stale":true}]'));
    });
    assert.deepEqual(await page.evaluate(async () => (await fetch('/rest/v1/rpc/g19_public_announcements', {method:'POST'})).json()), data);
    assert.ok(requests.some(headers => headers['cache-control']?.includes('no-cache')));
    await page.locator('#shortcut-open').click();
    assert.equal(await page.locator('#shortcut-help').isVisible(), true);
    await page.locator('#shortcut-close').click();
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#calendar-days .calendar-day').length >= 28);
    assert.equal(await page.locator('#announcements-card').isVisible(), false);
    await page.getByRole('button',{name:'Pokój nr 2',exact:true}).click();
    await page.getByRole('button', {name:'Potwierdź pokój'}).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cleaning-room')), '2');
    assert.equal(await page.locator('#room-setup').isVisible(), false);
    assert.ok(await page.locator('#calendar-days .calendar-own').count() >= 2);
    await page.locator('#calendar-next-month').click();
    assert.ok(await page.locator('#calendar-days .calendar-day').count() >= 28);
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
    if (file === '/dyskusje/config.js') {
      res.setHeader('Content-Type','text/javascript');
      return res.end(testConfig);
    }
    if (file === publicRpc) {
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
      await page.locator('#ogloszenie-permanent').waitFor();
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
    await page.getByRole('button',{name:'Następne ogłoszenie'}).click();
    await hide('instant');
    assert.equal(await page.locator('.announcement-entry').count(),1);
    assert.equal(await other.locator('#announcement-position').textContent(),'1 / 3');
    // Dokładnie o północy w Warszawie ogłoszenie z samą datą znika na obu urządzeniach.
    for (const p of pages) await p.clock.runFor(1000);
    assert.equal(await page.locator('#announcements-card').isVisible(),false);
    assert.equal(await page.locator('#announcements-card').evaluate(e => e.getBoundingClientRect().height),0);
    assert.equal(await other.locator('#announcement-position').textContent(),'1 / 2');
    for (const id of ['permanent','instant']) {
      await page.locator('#announcements-open').click();
      await page.locator('#hidden-announcements-list button').filter({hasText:'Informacja '+id}).click();
    }
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja instant']);
    await hide('instant');
    for (const p of pages) await p.clock.runFor(2000);
    await page.locator('#announcements-open').click();
    assert.equal(await page.locator('#hidden-announcements-list button').count(),1);
    await page.getByRole('button', {name:'Zamknij ogłoszenia'}).click();
    assert.deepEqual(await other.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    // Termin nie usuwa wpisu z JSON i nie można go przywrócić lokalną funkcją.
    await hide('permanent');
    await page.locator('#announcements-open').click();
    await page.locator('#hidden-announcements-list button').first().click();
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    assert.deepEqual(await page.evaluate(async () => (await fetch('/rest/v1/rpc/g19_public_announcements', {method:'POST'})).json()),data);
    // Zaplanowana publikacja również uwzględnia Warsaw i działa bez przeładowania.
    for (const p of pages) await p.clock.runFor(1000);
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    await page.locator('#announcements-open').click();
    assert.equal(await page.locator('#hidden-announcements-list button').count(),2);
    await page.getByRole('button', {name:'Zamknij ogłoszenia'}).click();
    // Wpisy bez expiresAt pozostają aktywne także po miesiącu.
    for (const p of pages) {
      await p.clock.fastForward(16 * 86400000);
      await p.clock.fastForward(16 * 86400000);
    }
    assert.deepEqual(await page.locator('.announcement-entry h3').allTextContents(),['Informacja permanent']);
    // Zmiana terminu nie zmienia trwałego ID ani lokalnego ukrycia.
    data[2].expiresAt = '2099-12-31';
    await page.goto(new URL(page.url()).origin + '/');
    await page.reload();
    await page.locator('#ogloszenie-future').waitFor();
    assert.equal(await page.locator('#announcement-position').textContent(),'1 / 2');
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
