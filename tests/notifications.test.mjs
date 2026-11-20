import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { announcementsForInbox, deliveryOutcome, pushPayload } from '../supabase/functions/g19-deliver/events.mjs';

test('Announcement format and push retry classifications', () => {
  const item = { id: 'news', title: 'Informacja', body: 'Tekst', publishedAt: '2026-11-13T14:00' };
  assert.equal(announcementsForInbox([item])[0].published, '2026-11-13T13:00:00.000Z');
  const body = 'Krótka informacja dla mieszkańców. '.repeat(9);
  const { summary } = announcementsForInbox([{ ...item, body }])[0];
  assert.ok(summary.length <= 161);
  assert.equal(body[summary.length - 1], ' ');
  assert.ok(summary.endsWith('…'));
  assert.deepEqual(announcementsForInbox([{ ...item, expiresAt: '2026-11-13T24:00' }]), []);
  assert.deepEqual([410, 404, 429, 503, 403, undefined].map(deliveryOutcome), ['gone','gone','retry','retry','failed','retry']);
});

test('Current database adds push content without rewriting old inbox entries or changing delivery', async t => {
  const { PGlite } = await import(process.env.G19_PGLITE || '@electric-sql/pglite');
  const { readdir } = await import('node:fs/promises');
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users, created_at timestamptz not null default now());
    create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const migration = '202611150014_push_notification_content.sql';
  const apply = async name => db.exec(await readFile(new URL(name, directory), 'utf8'));
  for (const name of (await readdir(directory)).sort().filter(name => name.endsWith('.sql') && name < migration)) {
    await apply(name);
  }
  const rpc = async (name, args = [], role = 'service_role') => db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    const placeholders = args.map((_, index) => '$' + (index + 1)).join(',');
    return (await tx.query('select public.g19_' + name + '(' + placeholders + ') as value', args)).rows[0].value;
  });
  const { token } = await rpc('bind', [1, '1'.repeat(64), 'a'.repeat(64)], 'anon');
  await rpc('push_subscription', [token, 'https://fcm.googleapis.com/fcm/send/demo',
    'A'.repeat(87), 'B'.repeat(22), ['duties', 'announcements']], 'anon');
  const published = new Date().toISOString();
  await rpc('notification_tick', [JSON.stringify([{ id: 'old', title: 'Starszy wpis', published }]), false]);
  const inbox = () => rpc('notifications', [token, ['announcements', 'duties']], 'anon');
  const before = (await inbox()).items.map(({ id, title, description, target }) => ({ id, title, description, target }));
  assert.equal(before.length, 1);
  await apply(migration);
  assert.deepEqual((await inbox()).items.map(({ id, title, description, target }) => ({ id, title, description, target })), before);
  await assert.rejects(rpc('push_take', [], 'anon'), {code:'42501'});
  const news = announcementsForInbox([{ id: 'news', title: 'Przerwa w dostawie wody',
    body: 'W środę od 9:00 do 11:00.', publishedAt: new Date().toISOString() }]);
  await rpc('notification_tick', [JSON.stringify(news), false]);
  await db.exec(`insert into g19_private.notification_inbox (device_id, category, event_key, title, description, target, created_at)
    select id, 'duties', duty.saturday::text, 'Twój dyżur sprzątania', 'Pokój nr 1 · najbliższy weekend',
      '#calendar-title', duty.due_at
    from g19_private.devices cross join g19_private.duty_reminder('2026-11-13T13:00:00Z') duty
    where room = duty.duty_room`);
  const batch = await rpc('push_take');
  assert.equal(batch.length, 3);
  const duty = batch.find(item => item.category === 'duties');
  assert.equal(pushPayload(duty).body, 'Twój dyżur: 14–15 listopada 2026 (sobota–niedziela).');
  assert.equal(pushPayload(batch.find(item => item.target === '#ogloszenie-old')).body, '');
  const announcement = pushPayload(batch.find(item => item.target === '#ogloszenie-news'));
  assert.equal(announcement.title, 'Przerwa w dostawie wody');
  assert.equal(announcement.body, 'W środę od 9:00 do 11:00.');
  await rpc('push_finish', [duty.id, duty.lease, 'retry']);
  await db.query('update g19_private.push_delivery set next_attempt_at = now() where notification_id = $1', [duty.id]);
  const [retry] = await rpc('push_take');
  assert.notEqual(retry.lease, duty.lease);
  assert.deepEqual(pushPayload(retry), pushPayload(duty));
});

test('Notification privacy, per-device read state, Warsaw duty and push lifecycle', async t => {
  const { PGlite } = await import(process.env.G19_PGLITE || '@electric-sql/pglite');
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated; create role service_role');
  for (const file of [
    '202611130001_dyskusje.sql', '202611130002_pairing_codes.sql', '202611130003_scope_chat_revision_updates.sql',
    '202611130004_devices_and_reactions.sql', '202611130005_notification_inbox.sql', '202611130006_web_push.sql',
    '202611130007_unified_notifications.sql', '202611130008_device_revocation_audit.sql', '202611130009_push_message_preview.sql'
  ]) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  const value = async (sql, args = [], role = 'anon') => db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    return (await tx.query(sql, args)).rows[0]?.v;
  });
  const bind = async room => (await value('select public.g19_bind($1,$2) v', [room, String(room).repeat(64)])).token;
  const author = await bind(1);
  const reader = await bind(2);
  const request = await value('select public.g19_pair_start(2) v');
  await value('select public.g19_pair_decide($1,$2,true) v', [reader, request.code]);
  const second = (await value('select public.g19_pair_claim($1) v', [request.secret])).token;
  const authorPair = await value('select public.g19_pair_start(1) v');
  await value('select public.g19_pair_decide($1,$2,true) v', [author, authorPair.code]);
  const authorSecond = (await value('select public.g19_pair_claim($1) v', [authorPair.secret])).token;
  const inbox = (token, categories = ['messages']) => value('select public.g19_notifications($1,$2) v', [token, categories]);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/demo';
  const subscribe = (token, url, categories) => value('select public.g19_push_subscription($1,$2,$3,$4,$5) v',
    [token,url,'A'.repeat(87),'B'.repeat(22),categories]);
  const take = () => value('select public.g19_push_take() v', [], 'service_role');
  await assert.rejects(subscribe(reader,'https://example.com/blocked',['messages']), {code:'PT400'});
  await subscribe(reader,endpoint,['messages']);
  await subscribe(reader,endpoint,['messages']);
  await assert.rejects(value('select public.g19_push_take() v'), {code:'42501'});
  await assert.rejects(value('select * from g19_private.push_subscriptions'), {code:'42501'});
  await assert.rejects(value('select * from g19_private.notification_inbox'), {code:'42501'});

  const messageRequest = randomUUID();
  for (let i = 0; i < 2; i++) await value('select public.g19_send($1,$2,$3) v', [author,messageRequest,'Prywatny tekst']);
  assert.equal((await inbox(author)).unread, 0);
  assert.equal((await inbox(authorSecond)).unread, 0);
  assert.equal((await inbox(second)).unread, 1);
  assert.equal((await inbox(reader, [])).unread, 0);
  const received = await inbox(reader);
  assert.equal(received.unread, 1);
  assert.ok(!JSON.stringify(received).includes('Prywatny tekst'));
  await value('select public.g19_notification_read($1,$2,$3) v', [second, received.items[0].id, ['messages']]);
  assert.equal((await inbox(reader)).unread, 1);
  assert.equal((await inbox(second)).unread, 1);
  await value('select public.g19_notification_read($1,$2,$3) v', [second, null, ['messages']]);
  assert.equal((await inbox(second)).unread, 0);
  const leased = await take();
  assert.equal(leased.length, 1);
  assert.equal(leased[0].room, 1);
  assert.equal(leased[0].message, 'Prywatny tekst');
  assert.deepEqual(await take(), []);
  const finish = (lease, outcome) => value('select public.g19_push_finish($1,$2,$3) v',
    [lease.id,lease.lease,outcome],'service_role');
  await finish(leased[0], 'retry');
  assert.deepEqual(await take(), []);
  await db.exec("update g19_private.push_delivery set next_attempt_at = now() where finished = false");
  const retried = (await take())[0];
  assert.notEqual(retried.lease, leased[0].lease);
  await finish(retried, 'gone');
  assert.equal((await db.query('select count(*) v from g19_private.push_subscriptions')).rows[0].v, 0);
  await subscribe(reader,endpoint,['announcements']);
  const news = [{ id:'fixture',title:'Nowe ogłoszenie',published:new Date().toISOString(),expires:null }];
  for (let i = 0; i < 2; i++) await value('select public.g19_notification_tick($1::jsonb,false) v', [JSON.stringify(news)], 'service_role');
  assert.equal((await inbox(reader,['announcements'])).unread, 1);
  assert.equal((await inbox(reader,['announcements'])).items[0].target,'#ogloszenie-fixture');
  const dut = async stamp => (await db.query('select duty_room, saturday::text, due_at::text from g19_private.duty_reminder($1)', [stamp])).rows;
  assert.deepEqual(await dut('2026-11-13T12:59:59Z'), []);
  assert.equal((await dut('2026-11-13T13:00:00Z'))[0].duty_room, 1);
  assert.equal((await dut('2026-07-17T12:00:00Z'))[0].saturday, '2026-07-18');
  assert.deepEqual(await dut('2026-07-17T11:59:59Z'), []);
  assert.deepEqual(await dut('2026-11-14T14:00:00Z'), []);
  const activity = (key, tab, active, seen = null, presented = []) =>
    value('select public.g19_notification_activity($1,$2,$3,$4,$5) v', [key,tab,active,seen,presented]);
  const settings = (key, categories = null) =>
    value('select public.g19_notification_preferences($1,$2,false) v', [key,categories]);
  const tab = randomUUID();
  const anotherTab = randomUUID();
  await subscribe(reader,endpoint,['announcements']);
  await subscribe(second,endpoint + '-second',['messages']);
  await settings(reader, ['messages', 'announcements']);
  assert.deepEqual(await settings(second), ['messages', 'announcements']);
  await activity(reader, tab, true);
  await activity(reader, anotherTab, true);
  await activity(reader, tab, false);
  await db.exec("update g19_private.devices set next_message_at = null where room = 1");
  const activeMessage = await value('select public.g19_send($1,$2,$3) v', [author,randomUUID(),'W aktywnym czacie']);
  const readerItems = (await inbox(reader)).items;
  assert.equal(readerItems[0].read, false);
  const foreground = await take();
  assert.ok(foreground.some(item => item.endpoint === endpoint + '-second' && item.category === 'messages'));
  assert.ok(foreground.every(item => item.endpoint !== endpoint || item.id !== readerItems[0].id));
  await activity(reader, anotherTab, true, activeMessage);
  assert.equal((await inbox(reader)).items[0].read, true);
  const duringChat = [{ id:'chat-news',title:'Ogłoszenie w czacie',published:new Date().toISOString(),expires:null }];
  await value('select public.g19_notification_tick($1::jsonb,false) v', [JSON.stringify(duringChat)], 'service_role');
  const chatNews = (await inbox(reader,['announcements'])).items.find(item => item.target === '#ogloszenie-chat-news');
  assert.equal(chatNews.read, false);
  await activity(reader, anotherTab, true, activeMessage, [chatNews.id]);
  await activity(reader, anotherTab, false);
  assert.ok((await take()).every(item => item.id !== chatNews.id));
  assert.equal((await inbox(reader,['announcements'])).items.find(item => item.id === chatNews.id).read, false);

  await activity(reader, tab, true);
  await db.exec("update g19_private.devices set next_message_at = null where room = 1");
  await value('select public.g19_send($1,$2,$3) v', [author,randomUUID(),'Zablokowany ekran']);
  assert.ok((await take()).every(item => item.endpoint !== endpoint || item.category !== 'messages'));
  await db.query("update g19_private.notification_presence set active_until = now() - interval '1 second' where tab = $1", [tab]);
  assert.ok((await take()).some(item => item.endpoint === endpoint && item.category === 'messages'));

  await settings(reader, []);
  assert.deepEqual(await settings(second), []);
  const itemCount = async () => (await db.query('select count(*) v from g19_private.notification_inbox')).rows[0].v;
  const beforeDisable = await itemCount();
  await db.exec("update g19_private.devices set next_message_at = null where room = 1");
  await value('select public.g19_send($1,$2,$3) v', [author,randomUUID(),'Wyłączona kategoria']);
  assert.equal(await itemCount(), beforeDisable);
  assert.equal((await inbox(reader)).unread, 0);
  const current = (await value('select public.g19_my_devices($1) v', [second])).find(device => device.current);
  await value('select public.g19_revoke_device($1,$2) v', [second,current.id]);
  await assert.rejects(inbox(second), { code:'PT401' });
  await assert.rejects(value('select public.g19_admin_change_resident(2,1,1) v', [], 'authenticated'), { code:'42501' });
  await value('select public.g19_admin_change_resident(2,1,1) v', [], 'g19_room_admin');
  const audit = (await db.query('select room, result, devices_revoked, administrator from g19_private.room_reset_audit')).rows[0];
  assert.equal(audit.room, 2);
  assert.equal(audit.result, 'revoked');
  assert.equal(audit.devices_revoked, 1);
  assert.ok(audit.administrator);
  assert.ok((await db.query('select count(*) from g19_private.messages')).rows[0].count >= 4);
  assert.deepEqual(await take(), []);
  assert.equal((await db.query('select count(*) v from g19_private.push_subscriptions')).rows[0].v, 0);
  await assert.rejects(inbox(reader), { code:'PT401' });
});

test('Service worker displays scoped push events and opens the target route', async () => {
  const { runInNewContext } = await import('node:vm');
  const handlers = new Map();
  const shown = [];
  const opened = [];
  const scope = 'https://example.test/sprzatanie-mieszkania/';
  let existing;
  const self = {
    registration: { scope, showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => existing ? [existing] : [], openWindow: async url => opened.push(url) },
    addEventListener: (type, callback) => handlers.set(type, callback)
  };
  runInNewContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), { self, URL });
  async function dispatch(type, details) {
    let done;
    handlers.get(type)({ ...details, waitUntil: promise => { done = promise; } });
    await done;
  }
  await dispatch('push', { data: { json: () => ({ id: '7', category: 'messages', target: '#dyskusje', room: 2, preview: 'Czy <b>ktoś</b> posprząta? 😊' }) } });
  assert.equal(shown[0][0], 'Goleszan 19 · Nowa wiadomość');
  assert.equal(shown[0][1].body, 'Pokój nr 2: Czy <b>ktoś</b> posprząta? 😊');
  const item = { id: '7', category: 'messages', target: '#dyskusje', room: 2 };
  assert.equal(pushPayload({ ...item, message: '  Zażółć\r\n<b>😊</b>  ' }).preview, 'Zażółć <b>😊</b>');
  assert.equal(pushPayload({ ...item, message: 'x'.repeat(139) + '👩‍🔬' + 'abc' }).preview, 'x'.repeat(139) + '👩‍🔬…');
  assert.equal(pushPayload({ ...item, category: 'duties', message: 'ignored' }).preview, undefined);
  assert.equal(shown[0][1].tag, 'g19-7');
  assert.equal(shown[0][1].renotify, false);
  await dispatch('push', { data: { json: () => ({ id: '8', category: 'messages', target: 'https://elsewhere.test/' }) } });
  assert.equal(shown.length, 1);
  let closed = false;
  const duty = { id: '9', category: 'duties', target: '#calendar-title', duty_saturday: '2026-11-14' };
  await dispatch('push', { data: { json: () => pushPayload(duty) } });
  assert.equal(shown[1][0], 'Przypomnienie o sprzątaniu');
  assert.equal(shown[1][1].body, 'Twój dyżur: 14–15 listopada 2026 (sobota–niedziela).');
  assert.equal(pushPayload({ ...duty, duty_saturday: '2026-10-31' }).body,
    'Twój dyżur: 31 października 2026 – 1 listopada 2026 (sobota–niedziela).');
  assert.equal(pushPayload({ ...duty, duty_saturday: '2026-02-30' }).body, 'Sprawdź harmonogram sprzątania.');
  await dispatch('notificationclick', { notification: { data: shown[1][1].data, close: () => { closed = true; } } });
  assert.ok(closed);
  assert.deepEqual(opened, [scope + '#calendar-title']);
  let focused = false;
  existing = {
    url: scope,
    navigate: async url => {
      assert.equal(url, scope + '#dyskusje');
      return { focus: async () => { focused = true; } };
    }
  };
  await dispatch('notificationclick', { notification: { data: shown[0][1].data, close() {} } });
  assert.ok(focused);
  const news = { id: '10', category: 'announcements', target: '#ogloszenie-news',
    announcement_title: 'Przerwa w dostawie wody', announcement_summary: 'W środę od 9:00.' };
  await dispatch('push', { data: { json: () => pushPayload(news) } });
  assert.equal(shown[2][0], news.announcement_title);
  assert.equal(shown[2][1].body, news.announcement_summary);
  existing = undefined;
  await dispatch('notificationclick', { notification: { data: shown[2][1].data, close() {} } });
  assert.equal(opened.at(-1), scope + '#ogloszenie-news');
  await dispatch('push', { data: { json: () => ({ id: '11', category: 'announcements', target: '#ogloszenie-old' }) } });
  assert.equal(shown[3][0], 'Ważne ogłoszenie');
  assert.equal(shown[3][1].body, 'Otwórz ogłoszenie w Goleszan 19.');
});
