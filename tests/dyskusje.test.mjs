import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PGlite } = await import(process.env.G19_PGLITE || '@electric-sql/pglite');
const root = fileURLToPath(new URL('../', import.meta.url));
const migration = await readFile(new URL('../supabase/migrations/202611130001_dyskusje.sql', import.meta.url), 'utf8');
const signatures = {
  bind: ['p_room'],
  read: ['p_token', 'p_before', 'p_version'],
  send: ['p_token', 'p_request', 'p_body'],
  react: ['p_token', 'p_message', 'p_vote']
};

async function database(t) {
  const db = new PGlite();
  t?.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(migration);
  const rpc = (method, args) => db.transaction(async tx => {
    await tx.exec('set local role anon');
    const values = signatures[method].map(key => args[key] ?? null);
    const placeholders = values.map((_, index) => '$' + (index + 1)).join(',');
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
  await assert.rejects(rpc('bind', { p_room: 5 }), { code: 'PT400' });
  const first = await rpc('bind', { p_room: 1 });
  const second = await rpc('bind', { p_room: 2 });
  const otherDevice = await rpc('bind', { p_room: 1 });
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
  assert.equal((await rpc('read', { p_token: first.token })).messages[0].up, 2);
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_vote: -1 });
  let message = (await rpc('read', { p_token: second.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [1, 1, -1]);
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_vote: 0 });
  message = (await rpc('read', { p_token: second.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [1, 0, 0]);
  assert.equal((await db.query('select active_devices from public.g19_admin_rooms() where room=1')).rows[0].active_devices, 2);
  await assert.rejects(db.query('select public.g19_admin_change_resident(1,1,1)'), { code: 'PT409' });
  assert.equal((await db.query('select public.g19_admin_change_resident(1,1,2) as count')).rows[0].count, 2);
  for (const token of [first.token, otherDevice.token]) {
    await assert.rejects(rpc('read', { p_token: token, p_version: read.version }), { code: 'PT401' });
    await assert.rejects(rpc('send', { ...send, p_token: token }), { code: 'PT401' });
    await assert.rejects(rpc('react', { ...vote, p_token: token, p_vote: 1 }), { code: 'PT401' });
  }
  const newcomer = await rpc('bind', { p_room: 1 });
  message = (await rpc('read', { p_token: newcomer.token })).messages[0];
  assert.deepEqual([message.room, message.former, message.mine], [1, true, false]);
  await rpc('send', { p_token: newcomer.token, p_request: randomUUID(), p_body: 'Nowy mieszkaniec' });
  assert.deepEqual((await rpc('read', { p_token: second.token })).messages.map(m => m.former), [true, false]);
});

test('Dyskusje on two browser devices uses real SQL, survives reload and handles a lost send response', { timeout: 45000 }, async t => {
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
  async function device(width, legacyRoom) {
    const context = await browser.newContext({ viewport: { width, height: 840 }, serviceWorkers: 'block' });
    await context.route('https://g19test.supabase.co/rest/v1/rpc/g19_*', async route => {
      const method = route.request().url().split('g19_').at(-1);
      try {
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
  await a.goto(base);
  assert.match(await a.locator('.brand').innerText(), /Goleszan 19/);
  assert.equal(await a.locator('#room-setup').isVisible(), false);
  assert.match(await a.locator('#room-lock').innerText(), /Pokój nr 1/);
  await a.getByRole('link', { name: /Dyskusje/ }).click();
  await a.locator('#discussion-compose').waitFor();
  await b.goto(base + '#dyskusje');
  await b.getByRole('link', { name: 'Wybierz pokój w ustawieniach' }).click();
  await b.getByRole('button', { name: 'Pokój nr 2', exact: true }).click();
  assert.equal(await b.evaluate(() => localStorage.getItem('cleaning-room')), null);
  await b.getByRole('button', { name: 'Potwierdź pokój' }).click();
  assert.match(await b.locator('#room-lock').innerText(), /Pokój nr 2/);
  await b.getByText('Ustawienia powiadomień', { exact: true }).click();
  await b.getByLabel('Nowe wiadomości').check();
  assert.equal(await b.getByLabel('Dyżury sprzątania').isChecked(), false);
  assert.equal(await b.getByLabel('Ważne ogłoszenia').isChecked(), false);
  await b.reload();
  assert.equal(await b.locator('#room-setup').isVisible(), false);
  await b.getByText('Ustawienia powiadomień', { exact: true }).click();
  assert.equal(await b.getByLabel('Nowe wiadomości').isChecked(), true);
  await b.getByRole('link', { name: /Dyskusje/ }).click();
  await b.locator('#discussion-compose').waitFor();
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
  await db.query('select public.g19_admin_change_resident(1,1,1)');
  await a.getByText('Powiązanie urządzenia wygasło.', { exact: false }).waitFor();
  await b.getByText('Pokój nr 1 · poprzedni mieszkaniec').waitFor();
  assert.equal(await a.locator('#discussion-compose').isVisible(), false);
  await a.getByRole('button', { name: 'Połącz urządzenie' }).click();
  await a.getByText('Pokój nr 1 · poprzedni mieszkaniec').waitFor();
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
  await a.locator('#discussion-body').fill('Najnowsza wiadomość');
  await a.locator('#discussion-send').click();
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
