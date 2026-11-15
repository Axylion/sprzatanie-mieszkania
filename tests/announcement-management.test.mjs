import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pushPayload } from '../supabase/functions/g19-deliver/events.mjs';

test('Announcement permissions, immutable push identity, Warsaw expiry and legacy import', async t => {
  const { PGlite } = await import(process.env.G19_PGLITE || '@electric-sql/pglite');
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table auth.sessions (id uuid primary key, user_id uuid references auth.users, created_at timestamptz not null default now());
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;`);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(name, directory), 'utf8'));
  }
  const admin = randomUUID(), session = randomUUID(), expired = randomUUID();
  await db.query('insert into auth.users values ($1)', [admin]);
  await db.query("insert into auth.sessions values ($1,$2,now()),($3,$2,now() - interval '2 hours')", [session, admin, expired]);
  await db.query('insert into g19_private.web_admin (user_id) values ($1)', [admin]);
  const rpc = async (name, args = [], role = 'authenticated', claims = { sub: admin, session_id: session }) => db.transaction(async tx => {
    await tx.exec('set local role ' + role);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const placeholders = args.map((_, index) => '$' + (index + 1)).join(',');
    return (await tx.query('select public.g19_' + name + '(' + placeholders + ') v', args)).rows[0].v;
  });
  const adminList = () => rpc('web_admin_announcements');
  const publicList = () => rpc('public_announcements', [], 'anon');
  const save = (id, revision, title, nodes, end = null, publish = false) =>
    rpc('web_admin_save_announcement', [id, revision, title, JSON.stringify(nodes), end, publish]);
  const active = id => rpc('announcement_delivery_active', [id], 'service_role');
  const tick = () => rpc('db_notification_tick', [false], 'service_role');
  const take = () => rpc('push_take', [], 'service_role');
  await assert.rejects(rpc('web_admin_announcements', [], 'anon'), { code: '42501' });
  await assert.rejects(rpc('web_admin_save_announcement', [null, null, 'Tytuł', '[]', null, false],
    'authenticated', {}), {code:'PT403'});
  await assert.rejects(rpc('web_admin_announcements', [], 'authenticated', {}), { code: 'PT403' });
  await assert.rejects(rpc('web_admin_announcements', [], 'authenticated', { sub: admin, session_id: expired }), { code: 'PT403' });
  await assert.rejects(rpc('db_notification_tick', [false], 'authenticated'), { code: '42501' });
  await assert.rejects(rpc('announcement_delivery_active', [1], 'anon'), { code: '42501' });
  const imported = (await adminList()).find(item => item.id === 'test-wazna-informacja-2026-11-04');
  assert.ok(imported);
  const legacy = JSON.parse(await readFile(new URL('../announcements.json', import.meta.url), 'utf8'))[0];
  const { rows: [savedLegacy] } = await db.query('select legacy_hide_key, push_title from g19_private.announcements where id = $1', [legacy.id]);
  assert.equal(savedLegacy.legacy_hide_key, JSON.stringify([legacy.id, legacy.publishedAt,
    legacy.updatedAt, legacy.title, legacy.body, legacy.expiresAt]));
  assert.equal(savedLegacy.push_title, null);
  assert.deepEqual(imported.content, [legacy.body]);
  const { token } = await rpc('bind', [1, '1'.repeat(64), 'a'.repeat(64)], 'anon');
  await rpc('push_subscription', [token, 'https://fcm.googleapis.com/fcm/send/demo',
    'A'.repeat(87), 'B'.repeat(22), ['announcements']], 'anon');
  await tick();
  assert.deepEqual(await take(), []);

  for (const nodes of [
    [{tag:'img', children:[]}], [{tag:'p', style:'color:red', children:['Tekst']}],
    [{tag:'a', href:'javascript:alert(1)', children:['Link']}],
    [{tag:'a', href:'https://example.org', onclick:'demo', children:['Link']}]
  ]) await assert.rejects(save(null, null, 'Treść', nodes), { code:'PT400' });

  const rich = [
    {tag:'h2', children:['Przerwa w dostawie wody']},
    {tag:'p', children:[{tag:'strong', children:['W środę']}, ' od 9:00. ', {tag:'a', href:'https://example.org/', children:['Szczegóły']}]},
    {tag:'ul', children:[{tag:'li', children:['Pamiętaj o zapasie.']}]}
  ];
  const clientID = randomUUID();
  const id = await save(clientID, null, 'Komunikat', rich);
  assert.equal(id, clientID);
  assert.equal(await save(clientID, null, 'Komunikat', rich), id);
  await assert.rejects(save(clientID, null, 'Inny szkic', rich), {code:'PT409'});
  assert.equal((await adminList()).find(item => item.id === id).status, 'draft');
  assert.equal((await adminList()).find(item => item.id === id).expiresAt, null);
  assert.ok(!(await publicList()).some(item => item.id === id));
  await save(id, 1, 'Informacja dla mieszkańców', rich);
  await assert.rejects(save(id, 1, 'Stara karta', rich), {code:'PT409'});
  await save(id, 2, 'Informacja dla mieszkańców', rich, null, true);
  await assert.rejects(save(id, 3, 'Powtórka', rich, null, true), {code:'PT409'});
  const published = (await publicList()).find(item => item.id === id);
  assert.deepEqual(published.content, rich);
  assert.ok(!('changedBy' in published));
  const dateResult = await db.query(`select
    g19_private.announcement_default_expiry('2026-03-01 12:00+01') = '2026-03-31 12:00+02'::timestamptz as spring,
    g19_private.announcement_default_expiry('2026-10-01 12:00+02') = '2026-10-31 12:00+01'::timestamptz as autumn`);
  assert.deepEqual(dateResult.rows[0], { spring:true, autumn:true });
  await tick();
  await tick();
  const [push] = await take();
  assert.equal(push.target, '#ogloszenie-' + id);
  assert.equal(pushPayload(push).title, 'Informacja dla mieszkańców');
  assert.equal(pushPayload(push).body, 'Przerwa w dostawie wody W środę od 9:00. Szczegóły Pamiętaj o zapasie.');
  assert.equal(await active(push.id), true);
  await save(id, 3, 'Poprawiona informacja', ['Poprawiony tekst']);
  const edited = (await publicList()).find(item => item.id === id);
  assert.equal(edited.expiresAt, published.expiresAt);
  assert.equal(edited.publishedAt, published.publishedAt);
  assert.equal(edited.version, published.version + 1);
  await tick();
  assert.deepEqual(await take(), []);
  await rpc('web_admin_withdraw_announcement', [id, 4]);
  assert.equal(await active(push.id), false);
  assert.ok(!(await publicList()).some(item => item.id === id));
  assert.equal((await adminList()).find(item => item.id === id).status, 'withdrawn');
  const endDate = (await db.query("select ((now() at time zone 'Europe/Warsaw')::date + 5)::text as v")).rows[0].v;
  const custom = await save(null, null, 'Termin własny', ['Treść'], endDate, true);
  const date = (await db.query("select (expires_at at time zone 'Europe/Warsaw')::date = ends_on + 1 as correct from g19_private.announcements where id = $1", [custom])).rows[0];
  assert.equal(date.correct, true);
  await tick();
  const [expiring] = await take();
  assert.equal(await active(expiring.id), true);
  await db.query("update g19_private.announcements set expires_at = now() where id = $1", [custom]);
  assert.equal(await active(expiring.id), false);
  assert.equal((await adminList()).find(item => item.id === custom).status, 'expired');
  const bell = await rpc('notifications', [token, ['announcements']], 'anon');
  assert.deepEqual(bell, { items:[], unread:0 });
  await db.query('update g19_private.push_delivery set next_attempt_at = now() where notification_id = $1', [expiring.id]);
  assert.deepEqual(await take(), []);
});
