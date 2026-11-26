const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { extname, join } = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

const root = join(__dirname, '..');
const ui9 = '87e2ee10e8e69195919adbde196ea72ef52c7eb0';
const mime = {'.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json'};
const registration = 'local-ui10-test-device';

test('UI9 to UI10 on one origin activates the new shell and retains local registration', async t => {
  let serveUi10 = false;
  const missing = [];
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = pathname.slice(1) || 'index.html';
    const rpc = pathname.split('/').at(-1);
    if (pathname.startsWith('/rest/v1/rpc/')) {
      const results = {
        g19_rooms: [],
        g19_missed_duties: [],
        g19_public_announcements: [],
        g19_my_devices: [{current:true,kind:'phone'}],
        g19_chat_capabilities: {privateChat:false},
        g19_read: {room:1,version:1,deviceCount:1,messages:[]},
        g19_notifications: {items:[],unread:0}
      };
      response.writeHead(200, {'Content-Type':'application/json'});
      return response.end(JSON.stringify(results[rpc] ?? {}));
    }
    try {
      const contents = file === 'dyskusje/config.js'
        ? 'window.goleszanDiscussionsConfig={url:"https://fixture.supabase.co",publishableKey:"sb_publishable_fixture"};'
        : serveUi10 ? await readFile(join(root, file))
          : execFileSync('git', ['show', ui9 + ':' + file], {cwd:root, stdio:['ignore','pipe','ignore']});
      response.writeHead(200, {'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-store'});
      response.end(contents);
    } catch {
      missing.push(file);
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (address, options) => {
      const url = new URL(address, location.href);
      return fetchOriginal(url.hostname === 'fixture.supabase.co' ? url.pathname : address, options);
    };
  });
  const page = await context.newPage();
  const origin = 'http://127.0.0.1:' + server.address().port;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/');
  const activeCache = name => page.waitForFunction(async cacheName =>
    navigator.serviceWorker.controller?.state === 'activated' &&
    JSON.stringify(await caches.keys()) === JSON.stringify([cacheName]), name);
  await activeCache('goleszan19-shell-v13-11-0-f1-ui9');
  await page.evaluate(value => {
    localStorage.setItem('goleszan19-discussion-device', value);
    localStorage.setItem('cleaning-room', '1');
    localStorage.setItem('cleaning-theme', 'light');
    localStorage.setItem('goleszan19-guide-supplies-v1', '{}');
  }, registration);
  serveUi10 = true;
  await page.evaluate(async () => (await navigator.serviceWorker.ready).update().then(() => undefined));
  await activeCache('goleszan19-shell-v13-11-0-f1-ui10-r2-no-ornament');
  await page.reload();
  await page.locator('#chat-open').click();
  await page.locator('#discussion-room').waitFor();
  assert.equal(await page.locator('#discussion-room').textContent(), 'Pokój nr 1');
  assert.deepEqual(await page.evaluate(() => [
    localStorage.getItem('goleszan19-discussion-device'), localStorage.getItem('cleaning-room'),
    localStorage.getItem('cleaning-theme'), localStorage.getItem('goleszan19-guide-supplies-v1')
  ]), [registration, '1', 'light', '{}']);
  assert.equal(await page.evaluate(async () => {
    const cache = await caches.open('goleszan19-shell-v13-11-0-f1-ui10-r2-no-ornament');
    return Boolean(await cache.match('./dyskusje/ui-components.js?v=ui10-r2')) &&
      !await cache.match('./dyskusje/dyskusje.css?v=ui9');
  }), true);
  await context.setOffline(true);
  await page.goto(origin + '/#harmonogram');
  await page.reload();
  await page.locator('#calendar-days .calendar-day').first().waitFor();
  await page.goto(origin + '/#poradnik');
  await page.locator('#poradnik-view h1').waitFor();
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
});
