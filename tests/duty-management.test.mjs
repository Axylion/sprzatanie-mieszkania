import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { setupPrivateDatabase } from './helpers/private-database.mjs';
import { pushPayload } from '../supabase/functions/g19-deliver/events.mjs';

test('Polish statutory holidays, movable dates and Christmas Eve boundary', async () => {
  const sandbox = {};
  runInNewContext(await readFile(new URL('../kalendarz/kalendarz.js', import.meta.url), 'utf8'), sandbox);
  const holidays = sandbox.g19CalendarDetails.holidays;
  const dates = year => [...holidays(year).keys()].map(date => new Date(date).toISOString().slice(0, 10)).sort();
  assert.equal(dates(2024).length, 13);
  assert.ok(!holidays(2024).has(Date.UTC(2024, 11, 24)));
  assert.ok(holidays(2025).has(Date.UTC(2025, 11, 24)));
  assert.deepEqual(dates(2026), ['01-01','01-06','04-05','04-06','05-01','05-03','05-24','06-04','08-15','11-01','11-11','12-24','12-25','12-26'].map(date => '2026-' + date));
  for (const [year, expected] of [[2024,'03-31'],[2025,'04-20'],[2038,'04-25'],[2099,'04-12']]) {
    const actual = [...holidays(year)].find(([, name]) => name === 'Niedziela Wielkanocna');
    assert.equal(new Date(actual[0]).toISOString().slice(0,10), year + '-' + expected);
  }
});

test('Duty writes require the current administrator and preserve the four-room rotation', async t => {
  const { db, rpc } = await setupPrivateDatabase(t);
  const admin = await createAdmin(db);
  const save = (room, start, missed) => admin('web_admin_save_duty', [room, start, missed]);
  const [start, next] = await roomPeriods(db);
  assert.deepEqual(await rpc('missed_duties'), []);
  await assert.rejects(rpc('web_admin_save_duty', [1,start,true]), { code:'42501' });
  await assert.rejects(rpc('web_admin_save_duty', [1,start,true], 'authenticated'), { code:'PT403' });
  await assert.rejects(save(2,start,true), { code:'PT400' });
  await assert.rejects(save(1,next,true), { code:'PT400' });
  await assert.rejects(save(1,'infinity',true), { code:'PT400' });
  assert.equal(await save(1,start,true), true);
  assert.equal(await save(1,start,true), true);
  assert.deepEqual(await rpc('missed_duties'), [{ room:1, startsOn:start }]);
  assert.deepEqual(await (await setupSecondReader(db,rpc))(), [{ room:1, startsOn:start }]);
  assert.equal(await save(1,start,false), false);
  assert.deepEqual(await rpc('missed_duties'), []);
  assert.deepEqual(await rpc('push_take', [], 'service_role'), []);
  for (const name of ['202611240022_duty_status.sql','202611240023_manual_duty_push.sql']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
  }
});

test('Manual push is scoped to active duty subscribers, records real outcomes and permits explicit resend', async t => {
  const { db, rpc, token, pair } = await setupPrivateDatabase(t);
  const admin = await createAdmin(db);
  const [start, next] = await roomPeriods(db);
  const send = (room, period, id = randomUUID()) => admin('web_admin_send_duty', [room, period, id]);
  const result = () => admin('web_admin_duty_push_result', [1,start]);
  const exact = id => admin('web_admin_duty_push_request', [id]);
  const summary = ({ expiresAt, ...value }) => {
    assert.ok(Number.isFinite(Date.parse(expiresAt)));
    return value;
  };
  await assert.rejects(rpc('web_admin_send_duty', [1,start,randomUUID()], 'authenticated'), { code:'PT403' });
  assert.equal((await send(1,next)).status, 'none');
  const subscribe = (key, path, categories) => rpc('push_subscription', [key, 'https://fcm.googleapis.com/fcm/send/' + path, 'A'.repeat(87), 'B'.repeat(22), categories]);
  await subscribe(token[1], 'room-1-a', ['duties']);
  await subscribe(await pair(token[1],1), 'room-1-b', ['duties']);
  await subscribe(token[3], 'room-3-no-duty-push', ['messages']);
  await subscribe(token[2], 'room-2-a', ['duties']);
  const id = randomUUID();
  assert.deepEqual(summary(await send(1,start,id)), { requestId:id, status:'pending', total:2, sent:0 });
  assert.equal((await send(1,start,id)).requestId,id);
  const coalesced = randomUUID();
  assert.equal((await send(1,start,coalesced)).requestId,id);
  assert.equal((await exact(coalesced)).requestId,id);
  await assert.rejects(rpc('web_admin_duty_push_request', [id], 'authenticated'), { code:'PT403' });
  assert.equal((await result()).status,'pending');
  assert.deepEqual(await rpc('missed_duties'), []);
  const batch = await rpc('push_take', [], 'service_role');
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map(item => item.endpoint.split('/').at(-1)).sort(), ['room-1-a','room-1-b']);
  assert.ok(batch.every(item => item.kind === 'manual_duty' && item.manual_duty_room === 1 && item.manual_duty_missed === false));
  const [first, second] = batch;
  const payload = pushPayload(first);
  assert.equal(payload.title, 'Przypomnienie o dyżurze');
  assert.match(payload.body, /^Pokój nr 1 — przypomnienie o sprzątaniu/);
  assert.equal(await rpc('manual_duty_delivery_active',[first.id],'service_role'),true);
  await rpc('push_finish',[first.id, first.lease, 'sent'],'service_role');
  await rpc('push_finish',[second.id, second.lease, 'retry'],'service_role');
  assert.deepEqual(summary(await result()), { requestId:id, status:'partial', total:2, sent:1 });
  assert.deepEqual(await rpc('push_take', [], 'service_role'), []);
  assert.equal((await send(1,start,coalesced)).status,'partial');
  assert.deepEqual(await rpc('push_take', [], 'service_role'), []);
  await admin('web_admin_save_duty', [1,start,true]);
  const again = await send(1,start);
  assert.notEqual(again.requestId,id);
  assert.equal((await exact(coalesced)).status,'partial');
  const repeated = await rpc('push_take', [], 'service_role');
  assert.equal(repeated.length, 2);
  assert.match(pushPayload(repeated[0]).title, /niewykonanym/);
  for (const item of repeated) await rpc('push_finish',[item.id,item.lease,'failed'],'service_role');
  assert.equal((await result()).status,'failed');
  assert.deepEqual(await rpc('missed_duties'), [{ room:1, startsOn:start }]);
  const complete = await send(1,start);
  for (const item of await rpc('push_take', [], 'service_role')) {
    await rpc('push_finish',[item.id,item.lease,'sent'],'service_role');
  }
  assert.deepEqual(summary(await result()), { requestId:complete.requestId, status:'sent', total:2, sent:2 });
  const expired = await send(1,start);
  await db.query("update g19_private.manual_duty_push set created_at=now()-interval '5 minutes' where request_id=$1", [expired.requestId]);
  assert.equal((await exact(expired.requestId)).status,'failed');
  assert.deepEqual(await rpc('push_take', [], 'service_role'), []);
  const interrupted = await send(1,start);
  assert.equal(interrupted.status,'pending');
  await db.exec(await readFile(new URL('../supabase/maintenance/rollback-f1.sql', import.meta.url), 'utf8'));
  assert.equal((await result()).status,'failed');
  assert.deepEqual(await rpc('push_take', [], 'service_role'), []);
  assert.deepEqual(await rpc('missed_duties'), [{ room:1, startsOn:start }]);
  await assert.rejects(send(1,start), { code:'42501' });
});

async function createAdmin(db) {
  const user = randomUUID();
  const session = randomUUID();
  await db.query('insert into auth.users values ($1)',[user]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,user]);
  await db.query('insert into g19_private.web_admin(user_id) values($1)',[user]);
  return (name, args) => db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:user,session_id:session})]);
    const sql = 'select public.g19_' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') as value';
    return (await tx.query(sql,args)).rows[0].value;
  });
}

async function roomPeriods(db) {
  const { rows } = await db.query(`select max(day) filter (where day <= now()::date)::text as start,
    min(day) filter (where day > now()::date + 1)::text as next
    from generate_series(current_date-35,current_date+40,'1 day') days(day)
    where g19_private.valid_duty(1, day::date)`);
  return ['start','next'].map(key => rows[0][key].slice(0,10));
}

async function setupSecondReader(db, rpc) {
  const user = randomUUID();
  await db.query('insert into auth.users values ($1)',[user]);
  return () => rpc('missed_duties', [], 'authenticated', {sub:user});
}
