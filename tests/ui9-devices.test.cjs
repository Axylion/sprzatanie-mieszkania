const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, firefox } = require('playwright');

const root = path.join(__dirname, '..');
const origin = 'http://localhost:41789';
const tokenKey = 'goleszan19-discussion-device';
const mime = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json'};
const screenshotDir = process.env.UI9_SCREENSHOT_DIR;

async function fixture(browser, viewport, rpc, options = {}) {
  const context = await browser.newContext({ serviceWorkers:'block', viewport, userAgent: options.userAgent });
  const errors = [];
  const calls = [];
  if (options.token) await context.addInitScript(([key, value]) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, value);
  }, [tokenKey, options.token]);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'fixture.supabase.co') {
      const name = url.pathname.split('/').at(-1).replace(/^g19_/, '');
      calls.push(name);
      const result = await rpc(name, request.postDataJSON());
      return route.fulfill({status:result?.status || 200, json:result?.body ?? result ?? []});
    }
    if (url.origin !== origin) return route.abort();
    const file = url.pathname.slice(1) || 'index.html';
    if (file === 'dyskusje/config.js') return route.fulfill({
      contentType:'text/javascript',
      body:'window.goleszanDiscussionsConfig={url:"https://fixture.supabase.co", publishableKey:"sb_publishable_fixture"};'
    });
    try {
      await route.fulfill({body:await fs.readFile(path.join(root, file)),contentType:mime[path.extname(file)]});
    } catch { await route.fulfill({status:404}); }
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, calls, errors };
}

const rooms = occupied => [1, 2, 3, 4].map(room => ({room, occupied:room === 1 && occupied}));
const read = count => ({room:1, messages:[], version:'1', deviceCount:count});
const device = (kind, current, id) => ({id, kind, current, createdAt:'2026-11-25T12:00:00Z'});
const unavailable = (message, status = 409) => ({status,body:{message}});
const desktop = {width:1280,height:900};
const phone = {width:390,height:844};

async function capture(locator, name) {
  if (screenshotDir) await locator.screenshot({path:path.join(screenshotDir, name + '.png')});
}

async function openFromDiscussion(page) {
  await page.locator('#chat-open').click();
  await page.getByRole('heading',{name:'Dołącz do dyskusji mieszkańców'}).waitFor();
  assert.equal(await page.locator('#discussion-chat').isVisible(), false);
  assert.equal(await page.locator('#discussion-view [data-room]').count(), 0);
  await page.getByRole('link',{name:'Podłącz urządzenie'}).click();
  await page.waitForURL('**/#ustawienia');
  await page.waitForFunction(() => document.activeElement.id === 'settings-title');
  const bounds = await page.locator('#settings-title').boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y < page.viewportSize().height);
}

for (const [name, engine, executablePath] of [
  ['Chromium', chromium, process.env.CHROME_PATH],
  ['Firefox', firefox, process.env.PLAYWRIGHT_FIREFOX_PATH],
]) {
  test(name + ' gates discussion, opens home settings and returns after confirmed registration', { timeout:60000 }, async () => {
    const browser = await engine.launch({executablePath});
    try {
      let verified = false, reads = 0, bindCalls = 0;
      const {page, calls, errors} = await fixture(browser, phone, async (name, args) => {
        if (name === 'rooms') return rooms(false);
        if (name === 'bind') {
          assert.equal(args.p_room, 1);
          assert.equal(args.p_proof.length,64);
          bindCalls++;
          verified = true;
          return {token:'fixture-connected', room:1};
        }
        if (name === 'my_devices') return [device('phone',true,'a')];
        if (name === 'read') { assert.ok(verified); reads++; return read(1); }
      });
      await page.goto(origin + '/');
      await page.locator('#chat-open').click();
      await page.getByRole('heading',{name:'Dołącz do dyskusji mieszkańców'}).waitFor();
      for (const theme of ['light','dark']) {
        await page.evaluate(mode => document.documentElement.dataset.theme = mode, theme);
        for (const width of [320,360,390,768,1280]) {
          await page.setViewportSize({width,height:844});
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
          if (name === 'Chromium' && [390,1280].includes(width)) {
            await capture(page.locator('.discussion-panel'), 'dyskusje-' + theme + '-' + width);
          }
        }
      }
      assert.ok(!calls.includes('read') && !calls.includes('private_read'));
      await page.setViewportSize(phone);
      await page.getByRole('link',{name:'Podłącz urządzenie'}).click();
      await page.waitForURL('**/#ustawienia');
      await page.waitForFunction(() => document.activeElement.id === 'settings-title');
      await page.getByRole('button',{name:/Pokój nr 1 Wolny/}).waitFor();
      assert.equal(await page.locator('#room-confirm').isDisabled(),true);
      await page.getByRole('button',{name:/Pokój nr 1 Wolny/}).click();
      await page.locator('#room-confirm').click();
      await page.waitForURL('**/#dyskusje');
      await page.locator('#discussion-chat').waitFor();
      assert.equal(await page.locator('#discussion-join').isVisible(),false);
      assert.equal(bindCalls,1);
      assert.ok(reads > 0);
      assert.ok(!calls.includes('push_subscribe'));
      await page.goto(origin + '/#ustawienia');
      await page.getByText('Podłączone urządzenia: 1 z 2').waitFor();
      await page.reload();
      await page.getByText('Podłączone urządzenia: 1 z 2').waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key),tokenKey),'fixture-connected');
      assert.deepEqual(errors,[]);
    } finally { await browser.close(); }
  });
}

for (const [first, second] of [['phone','computer'],['computer','phone'],['phone','phone'],['computer','computer'],['other','phone']]) {
  test(first + ' → ' + second + ' uses one home pairing flow and shows server device types', { timeout:25000 }, async () => {
    const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
    try {
      let state = 'pending';
      let attempts = 0;
      const profiles = {
        phone:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        computer:'Mozilla/5.0 (X11; Linux x86_64)',
        other:'Mozilla/5.0 (iPad)',
      };
      const label = {phone:'Telefon',computer:'Komputer',other:'Urządzenie'};
      const rpc = async (name,args) => {
        if (name === 'rooms') return rooms(true);
        if (name === 'pair_start') {
          if (state === 'claimed') return unavailable('device_limit');
          return {code:'012345',secret:'fixture-secret',room:1,
            expiresAt:new Date(Date.now()+120000).toISOString(),serverNow:new Date().toISOString()};
        }
        if (name === 'pair_decide') {
          attempts++;
          if (args.p_code !== '012345' || state !== 'pending') return {state:'unavailable'};
          state = 'approved';
          return {state};
        }
        if (name === 'pair_claim') {
          if (state === 'approved') state = 'claimed';
          return state === 'claimed' ? {state,token:'second',room:1} : {state};
        }
        if (name === 'my_devices') {
          const current = args.p_token;
          return [device(first,current==='first','a'), ...(state==='claimed' ? [device(second,current==='second','b')] : [])];
        }
        if (name === 'read') return read(state==='claimed' ? 2 : 1);
      };
      const known = await fixture(browser, first === 'computer' ? desktop : phone, rpc, {token:'first',userAgent:profiles[first]});
      const next = await fixture(browser, second === 'computer' ? desktop : phone, rpc, {userAgent:profiles[second]});
      await known.page.goto(origin + '/#ustawienia');
      await known.page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await known.page.getByText('Podłączone urządzenia: 1 z 2').waitFor();
      assert.equal(await known.page.locator('#device-list strong').allTextContents().then(x=>x.join(',')),label[first]+',Drugie urządzenie');
      if (first === 'phone' && second === 'computer') await capture(known.page.locator('#ustawienia'),'devices-one-mobile');
      await next.page.goto(origin + '/');
      await openFromDiscussion(next.page);
      await next.page.getByRole('button',{name:/Pokój nr 1 Zajęty/}).click();
      await next.page.getByRole('button',{name:'Podłącz kolejne urządzenie',exact:true}).click();
      await next.page.locator('#discussion-pair-code').waitFor();
      if (first === 'computer' && second === 'phone') await capture(next.page.locator('#discussion-pair'),'pair-code-mobile');
      assert.equal(await next.page.locator('#discussion-pair-code').innerText(),'012 345');
      assert.equal(await next.page.locator('#discussion-chat').isVisible(),false);
      await known.page.getByRole('button',{name:'Podłącz',exact:true}).click();
      const modal = known.page.getByRole('dialog',{name:'Podłącz kolejne urządzenie'});
      const input = modal.getByLabel('Kod z nowego urządzenia');
      assert.equal(await input.getAttribute('inputmode'),'numeric');
      await input.fill('999999');
      await modal.getByRole('button',{name:'Potwierdź podłączenie'}).click();
      await modal.getByText(/Kod jest nieprawidłowy/).waitFor();
      await input.fill('');
      await input.evaluate((field, code) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', code);
        field.dispatchEvent(new ClipboardEvent('paste', {clipboardData,cancelable:true,bubbles:true}));
      }, first === second ? '012345' : '012 345');
      assert.equal(await input.inputValue(),'012345');
      if (first === 'phone' && second === 'computer') await capture(modal,'approval-mobile');
      if (first === 'computer' && second === 'phone') await capture(modal,'approval-desktop');
      await modal.getByRole('button',{name:'Potwierdź podłączenie'}).click();
      await next.page.waitForURL('**/#dyskusje');
      await next.page.locator('#discussion-chat').waitFor();
      await known.page.getByText('Podłączone urządzenia: 2 z 2').waitFor();
      assert.deepEqual(await known.page.locator('#device-list strong').allTextContents(),[label[first],label[second]]);
      assert.equal(await known.page.getByRole('button',{name:'Podłącz',exact:true}).count(),0);
      await known.page.getByText('Osiągnięto limit dwóch urządzeń.').waitFor();
      if (first === 'computer' && second === 'phone') await capture(known.page.locator('#ustawienia'),'devices-two-desktop');
      assert.equal(attempts,2);
      const third = await fixture(browser, desktop, rpc);
      await third.page.goto(origin + '/#ustawienia');
      await third.page.getByRole('button',{name:/Pokój nr 1 Zajęty/}).click();
      await third.page.getByRole('button',{name:'Podłącz kolejne urządzenie',exact:true}).click();
      await third.page.getByText('Osiągnięto limit urządzeń.').waitFor();
      assert.equal(await third.page.getByRole('button',{name:/Odłącz/}).count(),0);
      assert.ok(!third.calls.includes('read') && !third.calls.includes('bind'));
      if (first === 'computer' && second === 'phone') {
        await third.page.evaluate(() => document.documentElement.dataset.theme = 'dark');
        await capture(third.page.locator('#device-limit'),'limit-desktop');
      }
      assert.deepEqual([...known.errors,...next.errors,...third.errors],[]);
    } finally { await browser.close(); }
  });
}

test('pending validation is fail closed, then explicit invalid token shows public screen', {timeout:20000}, async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  try {
    let response;
    const barrier = new Promise(resolve => { response = resolve; });
    const {page} = await fixture(browser, phone, async name => {
      if (name === 'read') return barrier;
    }, {token:'fixture-revoked'});
    await page.goto(origin+'/#dyskusje');
    await page.locator('#discussion-status').filter({hasText:'Sprawdzanie połączenia urządzenia…'}).waitFor();
    assert.equal(await page.locator('#discussion-join').isVisible(),false);
    assert.equal(await page.locator('#discussion-chat').isVisible(),false);
    response(unavailable('device_invalid',401));
    await page.getByRole('heading',{name:'Dołącz do dyskusji mieszkańców'}).waitFor();
    assert.equal(await page.locator('#discussion-chat').isVisible(),false);
  } finally { await browser.close(); }
});

test('error or cancellation never opens chat or redirects to it', {timeout:20000}, async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  try {
    let status = 'fail';
    const {page,calls} = await fixture(browser, phone, async name => {
      if (name === 'rooms') return rooms(true);
      if (name === 'pair_start') {
        if (status === 'fail') return unavailable('network',503);
        return {code:'012345',room:1,secret:'fixture',
          expiresAt:new Date(Date.now()+120000).toISOString(),serverNow:new Date().toISOString()};
      }
      if (name === 'pair_claim') return {state:'pending'};
      if (name === 'pair_cancel') return {state:'cancelled'};
    });
    await page.goto(origin+'/');
    await openFromDiscussion(page);
    await page.getByRole('button',{name:/Pokój nr 1 Zajęty/}).click();
    await page.locator('#room-confirm').click();
    await page.getByText('Nie udało się połączyć urządzenia. Spróbuj ponownie.').waitFor();
    assert.ok(page.url().endsWith('#ustawienia'));
    status = 'retry';
    await page.locator('#room-confirm').click();
    await page.locator('#discussion-pair-code').waitFor();
    await page.getByRole('button',{name:'Anuluj',exact:true}).click();
    await page.getByText('Prośba o podłączenie została anulowana.').waitFor();
    assert.ok(page.url().endsWith('#ustawienia'));
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),tokenKey),null);
    assert.ok(!calls.includes('read') && !calls.includes('private_read'));
  } finally { await browser.close(); }
});

test('home retries room loading, rejects stale availability and binds once without leaving home', {timeout:20000}, async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  try {
    let state = 'error', bindCalls = 0;
    const {page,calls} = await fixture(browser,desktop, async name => {
      if (name === 'rooms') return state === 'error' ? unavailable('network',503) : rooms(state === 'occupied');
      if (name === 'bind') { bindCalls++; return {room:1,token:'desktop'}; }
      if (name === 'my_devices') return [device('computer',true,'desktop')];
    });
    await page.goto(origin+'/#ustawienia');
    await page.getByText(/Nie udało się pobrać listy pokoi/).waitFor();
    assert.equal(await page.locator('#room-confirm').isDisabled(),true);
    assert.equal(await page.locator('#room-buttons button').count(),0);
    state = 'free';
    await page.locator('#room-retry').click();
    await page.getByRole('button',{name:/Pokój nr 1 Wolny/}).click();
    state = 'occupied';
    await page.getByRole('button',{name:'Podłącz urządzenie',exact:true}).click();
    await page.getByText(/Dostępność pokoju się zmieniła/).waitFor();
    assert.ok(!calls.includes('bind') && !calls.includes('pair_start'));
    state = 'free';
    await page.getByRole('button',{name:'Podłącz kolejne urządzenie',exact:true}).click();
    await page.getByRole('button',{name:/Pokój nr 1 Wolny/}).waitFor();
    await page.getByRole('button',{name:'Podłącz urządzenie',exact:true}).click();
    await page.getByText('Podłączone urządzenia: 1 z 2').waitFor();
    assert.equal(bindCalls,1);
    assert.ok(page.url().endsWith('#ustawienia'));
  } finally { await browser.close(); }
});

test('pairing survives reload, verifies expiry and renews without opening chat', {timeout:20000}, async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  try {
    let state = 'pending', started = 0;
    const {page,calls} = await fixture(browser,phone, async name => {
      if (name === 'rooms') return rooms(true);
      if (name === 'pair_start') {
        state = 'pending';
        return {code:++started === 1 ? '012345' : '023456',room:1,secret:'fixture-'+started,
          expiresAt:new Date(Date.now()+120000).toISOString(),serverNow:new Date().toISOString()};
      }
      if (name === 'pair_claim') return {state};
    });
    await page.goto(origin+'/#ustawienia');
    await page.getByRole('button',{name:/Pokój nr 1 Zajęty/}).click();
    await page.locator('#room-confirm').click();
    await page.getByText('012 345',{exact:true}).waitFor();
    await page.reload();
    await page.getByText('012 345',{exact:true}).waitFor();
    state = 'expired';
    await page.getByText('Kod wygasł.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Wygeneruj nowy kod'}).click();
    await page.getByText('023 456',{exact:true}).waitFor();
    assert.equal(started,2);
    assert.ok(!calls.includes('read') && !calls.includes('bind'));
  } finally { await browser.close(); }
});
