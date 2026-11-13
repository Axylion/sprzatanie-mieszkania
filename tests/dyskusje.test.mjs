import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PGlite } = await import(process.env.G19_PGLITE || '@electric-sql/pglite');
const root = fileURLToPath(new URL('../', import.meta.url));
const migration = await readFile(new URL('../supabase/migrations/202611130001_dyskusje.sql', import.meta.url), 'utf8');
const numericMigration = await readFile(new URL('../supabase/migrations/202611130002_pairing_codes.sql', import.meta.url), 'utf8');
const signatures = {
  rooms: [],
  bind: ['p_room', 'p_proof'],
  pair_start: ['p_room'],
  pair_decide: ['p_token', 'p_code', 'p_approve'],
  pair_claim: ['p_secret'],
  pair_cancel: ['p_secret'],
  read: ['p_token', 'p_before', 'p_version'],
  send: ['p_token', 'p_request', 'p_body'],
  react: ['p_token', 'p_message', 'p_vote']
};

async function database(t, legacy = false) {
  const db = new PGlite();
  t?.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(migration);
  if (!legacy) await db.exec(numericMigration);
  const rpc = (method, args) => db.transaction(async tx => {
    await tx.exec('set local role anon');
    const values = signatures[method].map(key => args[key] ?? null);
    const placeholders = values.map((_, index) => '$' + (index + 1)).join(',');
    if (method === 'rooms') return (await tx.query('select * from public.g19_rooms()')).rows;
    const result = await tx.query(`select public.g19_${method}(${placeholders}) as value`, values);
    return result.rows[0].value;
  });
  return { db, rpc };
}

test('PostgreSQL enforces binding, history, idempotency, reactions, rate limits and resident change', async t => {
  const { db, rpc } = await database(t);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const query of [
      'select * from g19_private.messages',
      'select * from public.g19_admin_rooms()',
      'select public.g19_admin_change_resident(1,1,0)'
    ]) {
      await assert.rejects(db.transaction(async tx => {
        await tx.exec('set local role ' + role);
        await tx.query(query);
      }), { code: '42501' });
    }
  }
  await assert.rejects(rpc('read', { p_token: 'wrong' }), { code: 'PT401' });
  const proof = () => randomBytes(32).toString('hex');
  const bind = (p_room, p_proof = proof()) => rpc('bind', { p_room, p_proof });
  const start = p_room => rpc('pair_start', { p_room });
  const decide = (p_token, p_code, p_approve = true) => rpc('pair_decide', { p_token, p_code, p_approve });
  const claim = p_secret => rpc('pair_claim', { p_secret });
  assert.deepEqual((await rpc('rooms', {})).map(room => room.occupied), [false, false, false, false]);
  await assert.rejects(bind(5), { code: 'PT400' });
  const firstProof = proof();
  const attempts = await Promise.allSettled([bind(1, firstProof), bind(1)]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].reason.code, 'PT409');
  const first = attempts[0].value;
  assert.deepEqual(await bind(1, firstProof), first);
  await assert.rejects(bind(1), { code: 'PT409' });
  const second = await bind(2);
  const request2 = await start(1);
  assert.match(request2.code, /^[0-9]{6}$/);
  assert.ok(Date.parse(request2.expiresAt) - Date.parse(request2.serverNow) <= 120000);
  assert.equal((await claim(request2.secret)).state, 'pending');
  await assert.rejects(rpc('read', { p_token: request2.secret }), { code: 'PT401' });
  assert.equal((await claim(request2.code)).state, 'expired');
  assert.equal((await decide(second.token, request2.code)).state, 'unavailable');
  const decisions = await Promise.all([decide(first.token, request2.code), decide(first.token, request2.code)]);
  assert.deepEqual(decisions.map(result => result.state).sort(), ['approved', 'unavailable']);
  const otherDevice = await claim(request2.secret);
  assert.equal(otherDevice.state, 'claimed');
  assert.deepEqual(await claim(request2.secret), otherDevice);
  assert.equal((await decide(first.token, request2.code)).state, 'unavailable');
  const request3 = await start(1);
  await decide(otherDevice.token, request3.code);
  const third = await claim(request3.secret);
  assert.equal(third.state, 'claimed');
  assert.notEqual(third.token, otherDevice.token);
  const expired = await start(1);
  await db.query("update g19_private.pairings set expires_at = now() - interval '1 second' where numeric_code = $1", [expired.code]);
  assert.equal((await claim(expired.secret)).state, 'expired');
  assert.equal((await decide(first.token, expired.code)).state, 'unavailable');
  const rejected = await start(1);
  await decide(first.token, rejected.code, false);
  assert.equal((await claim(rejected.secret)).state, 'rejected');
  const cancelled = await start(1);
  assert.equal((await rpc('pair_cancel', { p_secret: cancelled.code })).state, 'expired');
  assert.equal((await rpc('pair_cancel', { p_secret: cancelled.secret })).state, 'cancelled');
  assert.equal((await claim(cancelled.secret)).state, 'cancelled');
  assert.equal((await decide(first.token, cancelled.code)).state, 'rate_limited');
  await db.exec("update g19_private.pair_attempts set window_start = now() - interval '1 minute'");
  assert.equal((await decide(first.token, cancelled.code)).state, 'unavailable');
  const pending = await start(1);
  const approved = await start(1);
  await decide(first.token, approved.code);
  for (let i = 0; i < 5; i++) await start(1);
  await assert.rejects(start(1), { code: 'PT429' });
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.notEqual(first.token, otherDevice.token);
  const hash = (await db.query('select encode(token_hash, $$hex$$) as hash from g19_private.devices')).rows;
  assert.ok(hash.every(row => row.hash !== first.token));
  const text = 'Zażółć gęślą jaźń <img src=x onerror=alert(1)>';
  const request = randomUUID();
  const send = { p_token: first.token, p_request: request, p_body: text, p_room: 4 };
  for (const invalid of [null, '\t \n\u00a0', 'a'.repeat(1501)]) {
    await assert.rejects(rpc('send', { ...send, p_body: invalid }), { code: 'PT400' });
  }
  const [id, duplicate] = await Promise.all([rpc('send', send), rpc('send', send)]);
  assert.equal(id, duplicate);
  await assert.rejects(rpc('send', { ...send, p_body: 'inny tekst' }), { code: 'PT409' });
  await assert.rejects(rpc('send', { ...send, p_request: randomUUID() }), { code: 'PT429' });
  const read = await rpc('read', { p_token: second.token });
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].room, 1);
  assert.equal(read.messages[0].body, text);
  assert.deepEqual(await rpc('read', { p_token: second.token, p_version: read.version }),
    { unchanged: true, version: read.version });
  const vote = { p_token: second.token, p_message: id };
  await rpc('react', { ...vote, p_vote: 1 });
  await rpc('react', { ...vote, p_vote: 1 });
  await assert.rejects(rpc('react', { ...vote, p_vote: -1 }), { code: 'PT429' });
  await rpc('react', { ...vote, p_token: otherDevice.token, p_vote: 1 });
  await rpc('react', { ...vote, p_token: third.token, p_vote: 1 });
  assert.deepEqual((await rpc('read', { p_token: first.token })).messages.map(m => [m.up, m.vote]), [[2, 1]]);
  assert.equal((await rpc('read', { p_token: third.token })).messages[0].mine, true);
  await rpc('react', { ...vote, p_token: third.token, p_vote: -1 });
  assert.deepEqual((await rpc('read', { p_token: otherDevice.token })).messages.map(m => [m.up, m.down, m.vote]), [[1, 1, -1]]);
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_token: third.token, p_vote: 1 });
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_vote: -1 });
  let message = (await rpc('read', { p_token: second.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [1, 1, -1]);
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_vote: 0 });
  message = (await rpc('read', { p_token: second.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [1, 0, 0]);
  assert.equal((await db.query('select active_devices from public.g19_admin_rooms() where room=1')).rows[0].active_devices, 3);
  await assert.rejects(db.query('select public.g19_admin_change_resident(1,1,1)'), { code: 'PT409' });
  assert.equal((await db.query('select public.g19_admin_change_resident(1,1,3) as count')).rows[0].count, 3);
  assert.equal((await rpc('rooms', {}))[0].occupied, false);
  assert.equal((await claim(pending.secret)).state, 'cancelled');
  assert.equal((await claim(approved.secret)).state, 'cancelled');
  await assert.rejects(bind(1, firstProof), { code: 'PT401' });
  for (const token of [first.token, otherDevice.token, third.token]) {
    await assert.rejects(rpc('read', { p_token: token, p_version: read.version }), { code: 'PT401' });
    await assert.rejects(rpc('send', { ...send, p_token: token }), { code: 'PT401' });
    await assert.rejects(rpc('react', { ...vote, p_token: token, p_vote: 1 }), { code: 'PT401' });
  }
  const newcomer = await bind(1);
  message = (await rpc('read', { p_token: newcomer.token })).messages[0];
  assert.deepEqual([message.room, message.former, message.mine], [1, true, false]);
  await rpc('send', { p_token: newcomer.token, p_request: randomUUID(), p_body: 'Nowy mieszkaniec' });
  assert.deepEqual((await rpc('read', { p_token: second.token })).messages.map(m => m.former), [true, false]);
});

test('Additional migration preserves existing chat, reactions and devices', async t => {
  const { db, rpc } = await database(t, true);
  const existing = await rpc('bind', { p_room: 1, p_proof: randomBytes(32).toString('hex') });
  const id = await rpc('send', { p_token: existing.token, p_request: randomUUID(), p_body: 'Przed aktualizacją' });
  await rpc('react', { p_token: existing.token, p_message: id, p_vote: 1 });
  const old = await rpc('pair_start', { p_room: 1 });
  await db.exec(numericMigration);
  assert.equal((await rpc('pair_claim', { p_secret: old.secret })).state, 'cancelled');
  const messages = (await rpc('read', { p_token: existing.token })).messages;
  assert.deepEqual(messages.map(m => [m.id, m.body, m.vote]), [[id, 'Przed aktualizacją', 1]]);
  const next = await rpc('pair_start', { p_room: 1 });
  assert.match(next.code, /^[0-9]{6}$/);
});

test('Dyskusje across devices uses real SQL, survives reload and handles a lost send response', { timeout: 70000 }, async t => {
  const { db, rpc } = await database();
  const { chromium } = createRequire(import.meta.url)('playwright');
  const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const relative = pathname.replace(/^\/sprzatanie-mieszkania\//, '');
    try {
      const file = relative || 'index.html';
      const contents = file === 'dyskusje/config.js'
        ? 'window.goleszanDiscussionsConfig = {url:"https://g19test.supabase.co",publishableKey:"sb_publishable_testing"};'
        : await readFile(resolve(root, file));
      res.writeHead(200, { 'Content-Type': types[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
      res.end(contents);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.close();
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
  const base = `http://127.0.0.1:${server.address().port}/sprzatanie-mieszkania/`;
  const errors = [];
  let loseSendResponse = true;
  let losePairResponse = false;
  async function device(width, legacyRoom) {
    const context = await browser.newContext({ viewport: { width, height: 840 }, serviceWorkers: 'block' });
    await context.route('https://g19test.supabase.co/rest/v1/rpc/g19_*', async route => {
      const method = route.request().url().split('g19_').at(-1);
      try {
        if (method === 'pair_claim' && losePairResponse) {
          losePairResponse = false;
          return route.abort();
        }
        const result = await rpc(method, route.request().postDataJSON());
        if (method === 'send' && loseSendResponse) {
          loseSendResponse = false;
          return route.abort();
        }
        return route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': '*' } });
      } catch (error) {
        const status = error.code?.startsWith('PT') ? Number(error.code.slice(2)) : 500;
        return route.fulfill({ status, json: { message: error.message }, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    });
    if (legacyRoom) await context.addInitScript(room => localStorage.setItem('cleaning-room', room), legacyRoom);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    return page;
  }

  const a = await device(320, '1');
  const b = await device(1280);
  const c = await device(390);
  const d = await device(768);
  async function joinRoom(page, room) {
    await page.locator(`#discussion-rooms [data-room="${room}"]`).click();
    await page.getByRole('button', { name: 'Połącz pokój', exact: true }).click();
    await page.locator('#discussion-compose').waitFor();
  }
  async function pairDevice(newPage) {
    await newPage.goto(base + '#dyskusje');
    await newPage.getByRole('button', { name: /Pokój nr 1 Zajęty/ }).click();
    await newPage.getByRole('button', { name: 'Połącz kolejne urządzenie' }).click();
    await newPage.getByText('Oczekiwanie na potwierdzenie na połączonym urządzeniu.').waitFor();
    assert.equal(await newPage.locator('#discussion-compose').isVisible(), false);
    const code = await newPage.locator('#discussion-pair-code').innerText();
    assert.match(code, /^[0-9]{3} [0-9]{3}$/);
    assert.match(await newPage.getByRole('timer').innerText(), /^Kod ważny przez (02:00|01:[0-5][0-9])$/);
    if (await a.locator('#discussion-approve').getAttribute('open') === null) {
      await a.getByText('Dodaj urządzenie', { exact: true }).click();
    }
    const field = a.getByLabel('Kod z nowego urządzenia');
    const approve = a.getByRole('button', { name: 'Potwierdź podłączenie' });
    assert.equal(await field.getAttribute('inputmode'), 'numeric');
    await field.fill('a123');
    assert.equal(await field.inputValue(), '123');
    assert.equal(await approve.isDisabled(), true);
    await field.fill('');
    await field.evaluate((input, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true, bubbles: true }));
    }, code);
    assert.equal(await field.inputValue(), code.replace(' ', ''));
    await approve.click();
    await newPage.locator('#discussion-compose').waitFor();
  }
  await a.goto(base);
  assert.match(await a.locator('.brand').innerText(), /Goleszan 19/);
  assert.equal(await a.locator('#room-setup').isVisible(), false);
  assert.match(await a.locator('#room-lock').innerText(), /Pokój nr 1/);
  await a.getByRole('link', { name: /Dyskusje/ }).click();
  await a.getByRole('heading', { name: 'Dołącz do dyskusji' }).waitFor();
  assert.equal(await a.locator('#discussion-compose').isVisible(), false);
  assert.equal(await a.evaluate(() => localStorage.getItem('goleszan19-discussion-device')), null);
  await joinRoom(a, 1);
  await b.goto(base);
  await b.getByRole('link', { name: /Poradnik sprzątania/ }).click();
  await b.getByRole('heading', { name: /Szafki kuchenne/ }).waitFor();
  await b.getByRole('link', { name: '← Harmonogram' }).click();
  await b.locator('#next-room').waitFor();
  await b.getByText('Ustawienia powiadomień', { exact: true }).click();
  await b.getByLabel('Nowe wiadomości').check();
  assert.equal(await b.getByLabel('Dyżury sprzątania').isChecked(), false);
  assert.equal(await b.getByLabel('Ważne ogłoszenia').isChecked(), false);
  await b.goto(base + '#dyskusje');
  await joinRoom(b, 2);
  await c.goto(base + '#dyskusje');
  await c.getByRole('button', { name: /Pokój nr 1 Zajęty/ }).click();
  losePairResponse = true;
  await c.getByRole('button', { name: 'Połącz kolejne urządzenie' }).click();
  const retry = c.getByRole('button', { name: 'Sprawdź ponownie' });
  await retry.waitFor();
  await retry.click();
  await retry.waitFor({ state: 'hidden' });
  const oldCode = (await c.locator('#discussion-pair-code').innerText()).replace(' ', '');
  await db.query("update g19_private.pairings set expires_at = now() - interval '1 second' where numeric_code = $1", [oldCode]);
  await c.getByText('Kod wygasł.', { exact: true }).waitFor();
  await c.getByRole('button', { name: 'Wygeneruj nowy kod' }).click();
  await c.waitForFunction(old => {
    const code = document.querySelector('#discussion-pair-code');
    return !code.hidden && code.textContent.replace(' ', '') !== old;
  }, oldCode);
  const freshCode = (await c.locator('#discussion-pair-code').innerText()).replace(' ', '');
  await c.getByRole('button', { name: 'Anuluj', exact: true }).click();
  await c.getByText('Prośba o podłączenie została anulowana.').waitFor();
  assert.equal((await db.query('select state from g19_private.pairings where numeric_code = $1', [freshCode])).rows[0].state, 'cancelled');
  await pairDevice(c);
  await pairDevice(d);
  assert.equal(new Set(await Promise.all([a, b, c, d].map(page =>
    page.evaluate(() => localStorage.getItem('goleszan19-discussion-device'))))).size, 4);
  await a.locator('#discussion-body').fill('   ');
  assert.equal(await a.locator('#discussion-send').isDisabled(), true);
  const messageText = 'Zażółć gęślą <img src=x onerror=alert(1)> ' + 'długi'.repeat(160);
  await a.locator('#discussion-body').fill(messageText);
  await a.locator('#discussion-send').click();
  await a.getByText('Nie udało się wysłać wiadomości.', { exact: false }).waitFor();
  await a.locator('#discussion-send').click();
  await a.waitForFunction(() => document.querySelector('#discussion-body').value === '');
  await b.locator('.discussion-message').waitFor();
  assert.equal(await b.locator('.discussion-message p').innerText(), messageText);
  assert.equal(await b.locator('.discussion-message img').count(), 0);
  assert.equal(await a.locator('.discussion-message').count(), 1);
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.match(await b.locator('.discussion-meta strong').innerText(), /Pokój nr 1/);

  await b.locator('[data-reaction="1"]').click();
  await a.waitForFunction(() => document.querySelector('[data-reaction="1"]')?.textContent === '👍 1');
  await b.reload();
  await b.waitForFunction(() => document.querySelector('[data-reaction="1"]')?.getAttribute('aria-pressed') === 'true');
  await b.locator('[data-reaction="-1"]').click();
  await b.waitForFunction(() => document.querySelector('[data-reaction="-1"]')?.getAttribute('aria-pressed') === 'true');
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await b.locator('[data-reaction="-1"]').click();
  await b.waitForFunction(() => document.querySelector('[data-reaction="-1"]')?.getAttribute('aria-pressed') === 'false');
  await c.locator('[data-reaction="1"]').click();
  await d.waitForFunction(() => document.querySelector('[data-reaction="1"]')?.getAttribute('aria-pressed') === 'true');
  assert.equal(await d.locator('[data-reaction="1"]').textContent(), '👍 1');
  await d.locator('[data-reaction="1"]').click();
  await c.waitForFunction(() => document.querySelector('[data-reaction="1"]')?.getAttribute('aria-pressed') === 'false');
  await db.query('select public.g19_admin_change_resident(1,1,3)');
  for (const page of [a, c, d]) {
    await page.getByText('Dostęp do dyskusji został zakończony.').waitFor();
    assert.equal(await page.locator('#discussion-compose').isVisible(), false);
  }
  await a.reload();
  await a.getByText('Dostęp do dyskusji został zakończony.').waitFor();
  assert.equal(await a.locator('#discussion-join').isVisible(), false);
  await a.getByRole('link', { name: '← Harmonogram' }).click();
  await a.locator('#next-room').waitFor();
  await b.getByText('Pokój nr 1 · poprzedni mieszkaniec').waitFor();
  const newcomer = await device(360);
  await newcomer.goto(base + '#dyskusje');
  await joinRoom(newcomer, 1);
  await newcomer.getByText('Pokój nr 1 · poprzedni mieszkaniec').waitFor();
  // Fill a page with fixtures and check that automatic refresh preserves the reader's place.
  await db.exec(`
    insert into g19_private.messages (device_id, request_id, body)
    select d.id, gen_random_uuid(), 'Wiadomość ' || n
    from g19_private.devices d cross join generate_series(1, 43) n where d.room = 2;
    update g19_private.chat_revision set version = version + 1;
  `);
  await b.waitForFunction(() => document.querySelectorAll('.discussion-message').length === 40);
  await b.waitForFunction(() => {
    const h = document.querySelector('#discussion-history');
    return h.scrollHeight - h.scrollTop - h.clientHeight < 55;
  });
  await b.locator('#discussion-history').evaluate(el => { el.scrollTop = 500; });
  const initial = await b.locator('#discussion-history').evaluate(el => {
    const row = [...el.children].find(child => child.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
    return { id: row.dataset.message, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top };
  });
  await newcomer.locator('#discussion-body').fill('Najnowsza wiadomość');
  await newcomer.locator('#discussion-send').click();
  await b.getByText('Najnowsza wiadomość', { exact: true }).waitFor();
  assert.ok(await b.locator('#discussion-latest').isVisible());
  const restored = await b.locator('#discussion-history').evaluate((el, id) => {
    const row = el.querySelector(`[data-message="${id}"]`);
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, initial.id);
  assert.ok(Math.abs(restored - initial.offset) <= 2);
  await b.getByRole('button', { name: 'Starsze wiadomości' }).click();
  await b.getByText(messageText, { exact: true }).waitFor();
  await b.getByRole('button', { name: 'Najnowsze wiadomości' }).click();
  await b.getByText('Najnowsza wiadomość', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});
