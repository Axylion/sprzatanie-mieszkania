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
const revisionMigration = await readFile(new URL('../supabase/migrations/202611130003_scope_chat_revision_updates.sql', import.meta.url), 'utf8');
const devicesMigration = await readFile(new URL('../supabase/migrations/202611130004_devices_and_reactions.sql', import.meta.url), 'utf8');
const signatures = {
  rooms: [],
  bind: ['p_room', 'p_proof', 'p_browser'],
  pair_start: ['p_room', 'p_browser'],
  pair_decide: ['p_token', 'p_code', 'p_approve'],
  pair_claim: ['p_secret'],
  pair_cancel: ['p_secret'],
  read: ['p_token', 'p_before', 'p_version'],
  send: ['p_token', 'p_request', 'p_body'],
  react: ['p_token', 'p_message', 'p_vote'],
  notifications: ['p_token', 'p_categories'],
  notification_preferences: ['p_token', 'p_categories', 'p_initialize'],
  push_subscription: ['p_token', 'p_endpoint', 'p_p256dh', 'p_auth', 'p_categories'],
  notification_activity: ['p_token', 'p_tab', 'p_active', 'p_seen', 'p_presented'],
  notification_read: ['p_token', 'p_id', 'p_categories'],
  my_devices: ['p_token', 'p_kind', 'p_browser'],
  revoke_device: ['p_token', 'p_device']
};

async function database(t, legacy = false, beforeAccess = null) {
  const db = new PGlite();
  t?.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(migration);
  if (!legacy) {
    await db.exec(numericMigration);
    await db.exec(revisionMigration);
    await db.exec(devicesMigration);
    await db.exec(await readFile(new URL('../supabase/migrations/202611130005_notification_inbox.sql', import.meta.url), 'utf8'));
    for (const file of ['202611130006_web_push.sql', '202611130007_unified_notifications.sql', '202611130008_device_revocation_audit.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
    await beforeAccess?.(db);
    await db.exec(`create schema auth;
      create table auth.users (id uuid primary key);
      create table auth.sessions (id uuid primary key, user_id uuid references auth.users, created_at timestamptz not null default now());
      create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb$$;
      create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
    for (const file of ['202611140010_room_access.sql', '202611140011_admin_panel.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
  }
  const rpc = (method, args) => db.transaction(async tx => {
    await tx.exec('set local role anon');
    const signature = legacy ? signatures[method].filter(key => key !== 'p_browser') : signatures[method];
    const values = signature.map(key => args[key] ?? null);
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
  const competing = await start(1);
  assert.match(request2.code, /^[0-9]{6}$/);
  assert.ok(Date.parse(request2.expiresAt) - Date.parse(request2.serverNow) <= 120000);
  assert.equal((await claim(request2.secret)).state, 'pending');
  await assert.rejects(rpc('read', { p_token: request2.secret }), { code: 'PT401' });
  assert.equal((await claim(request2.code)).state, 'expired');
  assert.equal((await decide(second.token, request2.code)).state, 'unavailable');
  const decisions = await Promise.all([decide(first.token, request2.code), decide(first.token, request2.code)]);
  assert.deepEqual(decisions.map(result => result.state).sort(), ['approved', 'unavailable']);
  assert.equal((await decide(first.token, competing.code)).state, 'device_limit');
  const otherDevice = await claim(request2.secret);
  assert.equal(otherDevice.state, 'claimed');
  assert.deepEqual(await claim(request2.secret), otherDevice);
  assert.equal((await decide(first.token, request2.code)).state, 'unavailable');
  await assert.rejects(start(1), { message: 'device_limit' });
  const devices = await rpc('my_devices', { p_token: first.token, p_kind: 'phone' });
  assert.equal(devices.length, 2);
  assert.equal(devices.find(d => d.current).kind, 'phone');
  const otherId = devices.find(d => !d.current).id;
  await assert.rejects(rpc('revoke_device', { p_token: second.token, p_device: otherId }), { code: 'PT404' });
  await rpc('revoke_device', { p_token: first.token, p_device: otherId });
  assert.equal((await claim(request2.secret)).state, 'cancelled');
  await assert.rejects(rpc('read', { p_token: otherDevice.token }), { code: 'PT401' });
  const expired = await start(1);
  await db.query("update g19_private.pairings set expires_at = now() - interval '1 second' where numeric_code = $1", [expired.code]);
  assert.equal((await claim(expired.secret)).state, 'expired');
  await db.exec("update g19_private.pair_attempts set window_start = now() - interval '1 minute' where room = 1");
  assert.equal((await decide(first.token, expired.code)).state, 'unavailable');
  const rejected = await start(1);
  await decide(first.token, rejected.code, false);
  assert.equal((await claim(rejected.secret)).state, 'rejected');
  const cancelled = await start(1);
  assert.equal((await rpc('pair_cancel', { p_secret: cancelled.code })).state, 'expired');
  assert.equal((await rpc('pair_cancel', { p_secret: cancelled.secret })).state, 'cancelled');
  assert.equal((await claim(cancelled.secret)).state, 'cancelled');
  for (let i = 0; i < 4; i++) await decide(first.token, cancelled.code);
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
    { unchanged: true, version: read.version, deviceCount: 1 });
  const vote = { p_token: second.token, p_message: id };
  await rpc('react', { ...vote, p_vote: 1 });
  await rpc('react', { ...vote, p_vote: 1 });
  await assert.rejects(rpc('react', { ...vote, p_vote: -1 }), { code: 'PT429' });
  await assert.rejects(rpc('react', { ...vote, p_token: first.token, p_vote: 1 }), { code: 'PT403' });
  const pair2 = await start(2);
  assert.equal((await decide(second.token, pair2.code)).state, 'approved');
  const secondExtra = await claim(pair2.secret);
  assert.equal((await rpc('read', { p_token: secondExtra.token })).messages[0].vote, 1);
  await rpc('react', { ...vote, p_token: secondExtra.token, p_vote: -1 });
  let message = (await rpc('read', { p_token: second.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [0, 1, -1]);
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await rpc('react', { ...vote, p_vote: 0 });
  message = (await rpc('read', { p_token: secondExtra.token })).messages[0];
  assert.deepEqual([message.up, message.down, message.vote], [0, 0, 0]);
  await assert.rejects(db.query('select public.g19_admin_change_resident(1,1,2)'), { code: 'PT409' });
  assert.equal((await db.query('select public.g19_admin_change_resident(1,1,1) as count')).rows[0].count, 1);
  assert.equal((await rpc('rooms', {}))[0].occupied, false);
  assert.equal((await claim(pending.secret)).state, 'cancelled');
  assert.equal((await claim(approved.secret)).state, 'cancelled');
  await assert.rejects(bind(1, firstProof), { code: 'PT401' });
  for (const token of [first.token, otherDevice.token]) {
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

test('Device migration keeps existing bindings and removes only self-reactions', async t => {
  const { db, rpc } = await database(t, true);
  await db.exec(numericMigration);
  await db.exec(revisionMigration);
  const author = await rpc('bind', { p_room: 1, p_proof: randomBytes(32).toString('hex') });
  const reader = await rpc('bind', { p_room: 2, p_proof: randomBytes(32).toString('hex') });
  const id = await rpc('send', { p_token: author.token, p_request: randomUUID(), p_body: 'Zachowana historia' });
  for (const token of [author.token, reader.token]) {
    await rpc('react', { p_token: token, p_message: id, p_vote: 1 });
  }
  const extra = [];
  for (let index = 0; index < 2; index++) {
    const pair = await rpc('pair_start', { p_room: 1 });
    await rpc('pair_decide', { p_token: author.token, p_code: pair.code, p_approve: true });
    extra.push(await rpc('pair_claim', { p_secret: pair.secret }));
  }
  await db.exec(devicesMigration);
  const history = await rpc('read', { p_token: author.token });
  assert.equal(history.deviceCount, 3);
  assert.deepEqual(history.messages.map(m => [m.id, m.up, m.vote]), [[id, 1, 0]]);
  for (const device of extra) {
    assert.equal((await rpc('read', { p_token: device.token })).deviceCount, 3);
    await assert.rejects(rpc('react', { p_token: device.token, p_message: id, p_vote: -1 }), { code: 'PT403' });
  }
  assert.equal((await rpc('read', { p_token: reader.token })).messages[0].vote, 1);
  await assert.rejects(rpc('pair_start', { p_room: 1 }), { message: 'device_limit' });
});

test('Room access repair, self-reconnection, admin session and room-specific blocks', async t => {
  const proof = () => randomBytes(32).toString('hex');
  const { db, rpc } = await database(t, false, async db => {
    await db.query('select public.g19_bind(1,$1)', [proof()]);
    await db.exec("update g19_private.devices set revoked_at = now() where room = 1");
  });
  const first = proof(), second = proof();
  const bind = (room, browser) => rpc('bind', { p_room: room, p_browser: browser, p_proof: proof() });
  assert.equal((await rpc('rooms', {}))[0].occupied, false);
  const a = await bind(1, first);
  const other = await bind(2, proof());
  const message = await rpc('send', { p_token: a.token, p_request: randomUUID(), p_body: 'Zachowana historia' });
  await rpc('react', { p_token: other.token, p_message: message, p_vote: 1 });
  async function pair() {
    const request = await rpc('pair_start', { p_room: 1, p_browser: second });
    await rpc('pair_decide', { p_token: a.token, p_code: request.code, p_approve: true });
    return rpc('pair_claim', { p_secret: request.secret });
  }
  async function detach(token) {
    const devices = await rpc('my_devices', { p_token: token });
    await rpc('revoke_device', { p_token: token, p_device: devices.find(d => d.current).id });
  }
  const b = await pair();
  await detach(b.token);
  assert.equal((await rpc('rooms', {}))[0].occupied, true);
  const b2 = await pair();
  await detach(b2.token);
  await detach(a.token);
  assert.equal((await rpc('rooms', {}))[0].occupied, false);
  const a2 = await bind(1, first);
  const history = await rpc('read', { p_token: a2.token });
  assert.deepEqual(history.messages.map(m => [m.id, m.former, m.up]), [[message, false, 1]]);
  await assert.rejects(rpc('read', { p_token: a.token }), { code: 'PT401' });

  const actor = randomUUID(), session = randomUUID(), stranger = randomUUID(), unrelated = randomUUID();
  await db.query('insert into auth.users values ($1), ($2)', [actor, stranger]);
  await db.query('insert into auth.sessions (id,user_id) values ($1,$2),($3,$4)', [session, actor, unrelated, stranger]);
  await db.query('insert into g19_private.web_admin (user_id) values ($1)', [actor]);
  const admin = (sql, params = [], sub = actor, sid = session, role = 'authenticated') => db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, session_id: sid })]);
    return (await tx.query(sql, params)).rows[0]?.v;
  });
  const roomsSql = 'select public.g19_web_admin_rooms() v';
  await assert.rejects(admin(roomsSql, [], stranger, unrelated), { code: 'PT403' });
  await assert.rejects(admin(roomsSql, [], actor, session, 'anon'), { code: '42501' });
  const rooms = await admin(roomsSql);
  assert.equal(rooms.length, 4);
  await admin('select public.g19_web_admin_detach(1,1,$1)', [rooms[0].devices[0].id]);
  await assert.rejects(bind(1, first), { message: 'browser_blocked' });
  await assert.rejects(rpc('read', { p_token: a2.token }), { code: 'PT401' });
  const fresh = await bind(1, proof());
  const current = (await admin(roomsSql))[0];
  const release = 'select public.g19_web_admin_release(1,1,$1) v';
  await assert.rejects(admin(release, [[]]), { message: 'room_changed' });
  assert.equal(await admin(release, [current.devices.map(d => d.id)]), 1);
  await assert.rejects(admin(release, [current.devices.map(d => d.id)]), { message: 'room_changed' });
  await assert.rejects(rpc('read', { p_token: fresh.token }), { code: 'PT401' });
  const historyAfter = await rpc('read', { p_token: other.token });
  assert.deepEqual(historyAfter.messages.map(m => [m.id, m.former, m.up]), [[message, true, 1]]);
  assert.ok((await bind(3, first)).token);
  const audit = (await db.query('select action, auth_user_id from g19_private.room_reset_audit order by id')).rows;
  assert.deepEqual(audit.map(r => [r.action, r.auth_user_id]), [['detach_device', actor], ['release_room', actor]]);
  await db.query("update auth.sessions set created_at = now() - interval '61 minutes' where id = $1", [session]);
  await assert.rejects(admin(roomsSql), { code: 'PT403' });
});

test('Dyskusje across devices uses real SQL, survives reload and handles a lost send response', { timeout: 90000 }, async t => {
  const { db, rpc } = await database();
  const { chromium } = createRequire(import.meta.url)('playwright');
  const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const relative = pathname.replace(/^\/sprzatanie-mieszkania\//, '');
    try {
      const file = relative || 'index.html';
      const contents = file === 'dyskusje/config.js'
        ? 'window.goleszanDiscussionsConfig = {url:"https://g19test.supabase.co",publishableKey:"sb_publishable_testing",vapidPublicKey:"test",adminEmail:"admin@example.test"};'
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

  async function screenshot(page, name) {
    if (process.env.G19_SCREENSHOTS) {
      await page.screenshot({ path: resolve(process.env.G19_SCREENSHOTS, name + '.png'), fullPage: true, animations: "disabled" });
    }
  }

  const a = await device(320, '1');
  const b = await device(1280);
  await b.addInitScript(() => {
    window.notificationTones = 0;
    window.pushPermission = "default";
    window.pushRequests = 0;
    window.rejectPush = false;
    let subscription;
    Object.defineProperty(Notification, "permission", { get: () => window.pushPermission });
    Notification.requestPermission = async () => {
      window.pushRequests++;
      window.pushPermission = "granted";
      return window.pushPermission;
    };
    navigator.serviceWorker.getRegistration = async () => ({
      active: {},
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async () => {
          if (window.rejectPush) throw new Error("No test push service");
          subscription = {
            expirationTime: null,
            toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/v12fixture",
              keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) } }),
            unsubscribe: async () => { subscription = undefined; return true; }
          };
          return subscription;
        }
      }
    });
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.notificationTones++;
      return create.call(this);
    };
  });
  const c = await device(390);
  const d = await device(768);
  async function joinRoom(page, room) {
    await page.locator(`#discussion-rooms [data-room="${room}"]`).click();
    await page.getByRole('button', { name: 'Połącz pokój', exact: true }).click();
    await page.locator('#discussion-compose').waitFor();
  }
  async function pairDevice(newPage) {
    await newPage.setViewportSize({ width: 1280, height: 900 });
    await newPage.goto(base + '#dyskusje');
    await newPage.getByRole('button', { name: /Pokój nr 1 Zajęty/ }).click();
    await newPage.getByRole('button', { name: 'Połącz kolejne urządzenie' }).click();
    await newPage.getByText('Oczekiwanie na potwierdzenie na połączonym urządzeniu.').waitFor();
    assert.equal(await newPage.locator('#discussion-compose').isVisible(), false);
    await screenshot(newPage, 'dyskusje-pair-desktop');
    const code = await newPage.locator('#discussion-pair-code').innerText();
    assert.match(code, /^[0-9]{3} [0-9]{3}$/);
    assert.match(await newPage.getByRole('timer').innerText(), /^Kod ważny przez (02:00|01:[0-5][0-9])$/);
    if (await a.locator('#discussion-approve').getAttribute('open') === null) {
      await a.getByText('Podłącz kolejne urządzenie', { exact: true }).click();
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
    await screenshot(a, 'dyskusje-approve-mobile');
    await approve.click();
    await a.getByText('Urządzenie zostało pomyślnie połączone.').waitFor();
    assert.equal(await a.locator('#discussion-approve').getAttribute('open'), null);
    assert.equal(await field.inputValue(), '');
    await newPage.locator('#discussion-compose').waitFor();
    await a.getByText('Urządzenie zostało pomyślnie połączone.').waitFor({ state: 'hidden' });
  }
  await a.clock.setFixedTime(new Date('2026-11-13T14:00:00Z'));
  await a.goto(base);
  for (const width of [360, 390, 430, 768, 1280]) {
    await a.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await a.locator('#theme-select').selectOption(theme);
      assert.equal(await a.locator('.dashboard-main').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), width < 760 ? 1 : 2);
      assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await a.locator('.calendar-legend').isVisible());
      const layout = await a.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        return {
          aligned: Math.abs(rect('.header-inner').left - rect('#harmonogram').left) < 1,
          mobileOrder: rect('.hero').top < rect('.dashboard-calendar').top && rect('.dashboard-calendar').top < rect('.dashboard-links').top,
          stacked: rect('.dashboard-links a:first-child').top < rect('.dashboard-links a:last-child').top
        };
      });
      assert.ok(layout.aligned && layout.stacked);
      if (width < 760) assert.ok(layout.mobileOrder);
      assert.equal(await a.locator('.hero p').textContent(), 'Generalne sprzątanie w weekend (±1 dzień)');
      await a.locator('#announcements-card').waitFor();
      if (width === 390 || width === 1280) {
        await screenshot(a, 'goleszan-home-' + (width === 390 ? 'mobile-' : 'desktop-') + theme);
      }
    }
  }
  await a.setViewportSize({ width: 390, height: 844 });
  for (const page of [c, d]) {
    await page.goto(base);
    await page.locator('#theme-select').selectOption('dark');
  }
  assert.match(await a.locator('.brand').innerText(), /Goleszan 19/);
  assert.equal(await a.locator('#room-setup').isVisible(), false);
  assert.ok(await a.getByRole('heading', { name: 'Moje urządzenia' }).isVisible());
  await a.getByRole('link', { name: /Dyskusje/ }).click();
  await a.getByRole('heading', { name: 'Dołącz do dyskusji' }).waitFor();
  assert.equal(await a.locator('#discussion-compose').isVisible(), false);
  assert.equal(await a.evaluate(() => localStorage.getItem('goleszan19-discussion-device')), null);
  await joinRoom(a, 1);
  await b.goto(base);
  await b.getByRole('link', { name: /Poradnik sprzątania/ }).click();
  await b.getByRole('heading', { name: /Szafki kuchenne/ }).waitFor();
  for (const width of [360, 1280]) {
    await b.setViewportSize({ width, height: 900 });
    const actual = await b.evaluate(() => {
      const header = document.querySelector('.header-inner').getBoundingClientRect();
      const page = document.querySelector('.guide-instructions').getBoundingClientRect();
      return [header.x, header.width, page.x, page.width, document.documentElement.scrollWidth];
    });
    assert.deepEqual(actual, width === 360 ? [12, 336, 12, 336, 360] : [100, 1080, 100, 1080, 1280]);
  }
  await b.getByRole('link', { name: '← Harmonogram' }).click();
  await b.locator('#next-room').waitFor();
  await b.locator('#powiadomienia summary').click();
  await b.locator('.notification-settings > label').getByLabel('Nowe wiadomości').check();
  assert.equal(await b.locator('.notification-settings > label').getByLabel('Dyżury sprzątania').isChecked(), false);
  assert.equal(await b.locator('.notification-settings > label').getByLabel('Ważne ogłoszenia').isChecked(), false);
  await b.goto(base + '#dyskusje');
  await joinRoom(b, 2);
  await b.getByRole('link', { name: '← Harmonogram' }).click();
  await b.getByRole('heading', { name: 'Moje urządzenia' }).waitFor();
  const permission = b.locator('#push-permission');
  await b.waitForFunction(() => document.querySelector('#push-permission').textContent === 'Włącz powiadomienia' &&
    !document.querySelector('#push-permission').hidden);
  assert.equal(await b.evaluate(() => window.pushRequests), 0);
  await b.evaluate(() => { window.rejectPush = true; });
  await permission.click();
  await b.getByRole('button', { name: 'Podłącz ponownie', exact: true }).waitFor();
  assert.equal(await b.evaluate(() => window.pushRequests), 1);
  await b.evaluate(() => { window.rejectPush = false; });
  await permission.click();
  await b.waitForFunction(() => document.querySelector('#push-status').textContent === 'Powiadomienia są aktywne');
  await b.evaluate(() => {
    window.pushPermission = "denied";
    window.dispatchEvent(new Event("online"));
  });
  await b.getByText('Powiadomienia są zablokowane w ustawieniach przeglądarki.').waitFor();
  await b.getByText(/Otwórz ustawienia witryny/).waitFor();
  assert.equal(await permission.isVisible(), false);
  assert.equal(await b.evaluate(() => window.pushRequests), 1);
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
  await a.locator('#discussion-approve').waitFor({ state: 'hidden' });
  await c.locator('#discussion-approve').waitFor({ state: 'hidden' });
  await d.goto(base + '#dyskusje');
  await d.getByRole('button', { name: /Pokój nr 1 Zajęty/ }).click();
  await d.getByRole('button', { name: 'Połącz kolejne urządzenie' }).click();
  await d.getByText(/Pokój ma już dwa urządzenia/).waitFor();
  assert.equal(new Set(await Promise.all([a, b, c].map(page =>
    page.evaluate(() => localStorage.getItem('goleszan19-discussion-device'))))).size, 3);
  await a.locator('#discussion-body').fill('   ');
  assert.equal(await a.locator('#discussion-send').isDisabled(), true);
  const messageText = 'Zażółć gęślą <img src=x onerror=alert(1)> ' + 'długi'.repeat(160);
  await a.locator('#discussion-body').fill(messageText);
  await a.locator('#discussion-send').click();
  await a.getByText('Nie udało się wysłać wiadomości.', { exact: false }).waitFor();
  await a.locator('#discussion-send').click();
  await a.waitForFunction(() => document.querySelector('#discussion-body').value === '');
  await b.locator('#notification-open').click();
  const bell = b.locator('#notification-panel');
  await bell.getByRole('link', { name: /Nowa wiadomość/ }).waitFor();
  assert.equal(await b.locator('#notification-count').textContent(), '1');
  await bell.getByRole('link', { name: /Nowa wiadomość/ }).click();
  await b.locator('#notification-count').waitFor({ state: 'hidden' });
  await b.locator('.discussion-message').waitFor();

  assert.equal(await b.locator('.discussion-message p').innerText(), messageText);
  assert.equal(await b.locator('.discussion-message img').count(), 0);
  assert.equal(await a.locator('.discussion-message').count(), 1);
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.match(await b.locator('.discussion-meta strong').innerText(), /Pokój nr 1/);
  await b.bringToFront();
  await b.getByRole('link', { name: '← Harmonogram' }).click();
  await b.locator('#notification-open').click();
  await bell.getByRole('link', { name: /Nowa wiadomość/ }).waitFor();
  await bell.getByRole('button', { name: 'Zamknij powiadomienia' }).click();
  await b.evaluate(() => { window.notificationTones = 0; });
  const aKey = await a.evaluate(() => localStorage.getItem('goleszan19-discussion-device'));
  await db.exec("update g19_private.devices set next_message_at = null where room = 1");
  await rpc('send', { p_token: aKey, p_request: randomUUID(), p_body: 'Sygnał na stronie głównej' });
  await b.locator('#notification-open').click();
  await b.waitForFunction(() => window.notificationTones === 1);
  await b.getByRole('button', { name: 'Zamknij powiadomienia' }).click();
  await b.locator('#notification-open').click();
  assert.equal(await b.evaluate(() => window.notificationTones), 1);
  await bell.getByRole('link', { name: /Nowa wiadomość/ }).first().click();
  await b.getByText('Sygnał na stronie głównej', { exact: true }).waitFor();
  await db.exec("update g19_private.devices set next_message_at = null where room = 1");
  await rpc('send', { p_token: aKey, p_request: randomUUID(), p_body: 'Cicha wiadomość' });
  await b.getByText('Cicha wiadomość', { exact: true }).waitFor();
  await b.locator('#notification-count').waitFor({ state: 'hidden' });
  assert.equal(await b.evaluate(() => window.notificationTones), 1);


  await a.locator('#notification-open').click();
  await a.getByText('Brak powiadomień.', { exact: true }).waitFor();
  await a.getByRole('button', { name: 'Zamknij powiadomienia' }).click();
  await b.locator('.discussion-message').first().locator('[data-reaction="1"]').click();
  await a.waitForFunction(() => document.querySelector('.reaction-count')?.textContent === '1');
  await b.reload();
  await b.waitForFunction(() => document.querySelector('[data-reaction="1"]')?.getAttribute('aria-pressed') === 'true');
  await b.locator('.discussion-message').first().locator('[data-reaction="-1"]').click();
  await b.waitForFunction(() => document.querySelector('[data-reaction="-1"]')?.getAttribute('aria-pressed') === 'true');
  await db.exec('update g19_private.devices set next_reaction_at = null');
  await b.locator('.discussion-message').first().locator('[data-reaction="-1"]').click();
  await b.waitForFunction(() => document.querySelector('[data-reaction="-1"]')?.getAttribute('aria-pressed') === 'false');
  await c.locator('.reaction-count').first().waitFor();
  assert.equal(await c.locator('[data-reaction]').count(), 0);
  assert.equal(await c.locator('.discussion-message').first().locator('.reaction-count svg').count(), 2);
  await a.getByRole('link', { name: '← Harmonogram' }).click();
  await a.getByText('To urządzenie', { exact: true }).waitFor();
  assert.equal(await a.getByRole('button', { name: 'Podłącz', exact: true }).count(), 0);
  await a.getByRole('button', { name: /^Odłącz: urządzenie połączone/ }).waitFor();
  await screenshot(a, 'dyskusje-devices-mobile');
  await a.getByRole('button', { name: /^Odłącz: urządzenie połączone/ }).click();
  await a.getByRole('button', { name: 'Odłącz urządzenie', exact: true }).click();
  await c.getByText('Dostęp do dyskusji został zakończony.').waitFor();
  await a.getByRole('button', { name: 'Podłącz', exact: true }).click();
  await a.locator('#discussion-approve-code').waitFor();
  await pairDevice(d);
  await db.query('select public.g19_admin_change_resident(1,1,2)');
  for (const page of [a, d]) {
    await page.getByText('Dostęp do dyskusji został zakończony.').waitFor();
    assert.equal(await page.locator('#discussion-compose').isVisible(), false);
  }
  await a.reload();
  await a.getByRole('button', { name: /Pokój nr 1 Wolny/ }).click();
  await a.getByRole('button', { name: 'Połącz pokój', exact: true }).click();
  await a.getByText('Administrator zablokował ponowne podłączenie tego urządzenia do pokoju.').waitFor();
  assert.equal(await a.locator('#discussion-compose').isVisible(), false);
  await a.getByRole('link', { name: '← Harmonogram' }).click();
  await a.locator('#next-room').waitFor();
  await b.getByText('Pokój nr 1 · poprzedni mieszkaniec', { exact: true }).first().waitFor();
  const newcomer = await device(360);
  await newcomer.goto(base + '#dyskusje');
  await joinRoom(newcomer, 1);
  await newcomer.getByText('Pokój nr 1 · poprzedni mieszkaniec', { exact: true }).first().waitFor();
  const operator = await device(320);
  let loggedOut = false;
  let released = false;
  await operator.context().route('https://g19test.supabase.co/auth/v1/**', async route => {
    if (route.request().url().includes('logout')) {
      loggedOut = true;
      return route.fulfill({ status: 204 });
    }
    const { password } = route.request().postDataJSON();
    if (password !== 'only-a-test-fixture') return route.fulfill({ status: 400, json: {} });
    return route.fulfill({ json: { access_token: 'fixture-session', expires_in: 3600 } });
  });
  await operator.context().route('https://g19test.supabase.co/rest/v1/rpc/g19_web_admin_*', async route => {
    assert.equal(route.request().headers().authorization, 'Bearer fixture-session');
    if (route.request().url().endsWith('_release')) {
      const args = route.request().postDataJSON();
      assert.equal(args.p_room, 1);
      released = true;
      return route.fulfill({ json: 1 });
    }
    return route.fulfill({ json: [1, 2, 3, 4].map(room => ({
      room, generation: 1, occupied: room === 1 && !released,
      devices: room === 1 && !released ? [{ id: 'fixture-device', kind: 'phone' }] : []
    })) });
  });
  await operator.goto(base);
  await operator.getByRole('link', { name: 'Administracja' }).click();
  await operator.getByLabel('Hasło').fill('wrong-fixture');
  await operator.getByRole('button', { name: 'Zaloguj się' }).click();
  await operator.getByText('Nie udało się zalogować.').waitFor();
  await operator.getByLabel('Hasło').fill('only-a-test-fixture');
  await operator.getByRole('button', { name: 'Zaloguj się' }).click();
  await operator.getByRole('heading', { name: 'Pokój nr 4' }).waitFor();
  assert.equal(await operator.locator('.admin-room').count(), 4);
  assert.ok(await operator.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await operator.getByRole('button', { name: 'Zarządzaj' }).click();
  await operator.getByRole('button', { name: 'Zwolnij pokój', exact: true }).click();
  const confirm = operator.locator('#admin-confirm');
  await confirm.getByRole('button', { name: 'Anuluj' }).click();
  assert.equal(released, false);
  await operator.getByRole('button', { name: 'Zwolnij pokój', exact: true }).click();
  await confirm.getByRole('button', { name: 'Zwolnij pokój', exact: true }).click();
  await operator.getByText('Wolny · 0 urządzeń', { exact: true }).waitFor();
  await operator.getByRole('button', { name: 'Wyloguj' }).click();
  await operator.getByLabel('Hasło').waitFor();
  await operator.waitForFunction(() => !document.querySelector('#admin-login').hidden);
  assert.ok(loggedOut);
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
