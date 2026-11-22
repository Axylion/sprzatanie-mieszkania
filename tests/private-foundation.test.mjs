// Foundation-only probes; full API and browser integration are tested separately.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
const {PGlite}=await import(process.env.G19_PGLITE || '@electric-sql/pglite');
const directory=new URL('../supabase/migrations/',import.meta.url);
const proposal=await readFile(new URL('../supabase/migrations/202611220020_private_chat_foundation.sql',import.meta.url),'utf8');
const proof=()=>randomBytes(32).toString('hex');
async function setup(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users,created_at timestamptz not null default now());
    create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql') && n<'202611220020').sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  const rpc=(name,args=[],role='anon',claims={})=>db.transaction(async tx=>{
    await tx.exec('set local role '+role);
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
    return (await tx.query('select public.g19_'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as v',args)).rows[0].v;
  });
  const bind=async room=>(await rpc('bind',[room,proof(),proof()])).token;
  const state=async room=>(await db.query(`select r.room,r.generation,r.occupied,c.period_id from g19_private.rooms r
    join g19_private.private_current_period c using(room) where r.room=$1`,[room])).rows[0];
  const device=async token=>(await rpc('my_devices',[token,null,null])).find(d=>d.current).id;
  return {db,rpc,bind,state,device};
}
test('Private foundation preserves all existing data, public RPC definitions and subscriptions',async t=>{
  const {db,rpc,bind}=await setup(t);const one=await bind(1),two=await bind(2);
  await rpc('send',[one,randomUUID(),'Wiadomość wyłącznie w izolowanej bazie']);
  await rpc('push_subscription',[two,'https://fcm.googleapis.com/fcm/send/proposal','A'.repeat(87),'B'.repeat(22),['messages']]);
  const snapshot=async()=>{
    const result={};
    for(const table of ['rooms','devices','messages','reactions','pairings','notification_inbox','push_delivery','push_subscriptions']){
      const omit=table==='messages' ? "-'reply_to'-'sender_period'" : table==='notification_inbox' ? "-'private_conversation_id'-'private_message_id'" : '';
      result[table]=(await db.query(`select to_jsonb(t)${omit} as v from g19_private.${table} t order by to_jsonb(t)::text`)).rows;
    }
    result.rpc=(await db.query(`select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'g19_%' order by p.proname`)).rows;
    return result;
  };
  const before=await snapshot();await db.exec(proposal);assert.deepEqual(await snapshot(),before);
  assert.equal((await rpc('read',[two,null,null])).messages.length,1);
  assert.equal((await rpc('push_status',[two,'https://fcm.googleapis.com/fcm/send/proposal'])).includes('messages'),true);
  assert.equal((await db.query('select count(*)::int n from g19_private.private_messages')).rows[0].n,0);
});
test('Existing last-device release reuses auth generation; independent private period rotates independently',async t=>{
  const {db,rpc,bind,state,device}=await setup(t);const one=await bind(1);await db.exec(proposal);
  const pair=await rpc('pair_start',[1,proof()]);await rpc('pair_decide',[one,pair.code,true]);
  const second=(await rpc('pair_claim',[pair.secret])).token;
  const initial=await state(1),peer=await state(2);
  await rpc('revoke_device',[one,await device(second)]);assert.deepEqual(await state(1),initial);
  await rpc('revoke_device',[one,await device(one)]);
  const released=await state(1);assert.equal(released.generation,initial.generation);assert.equal(released.occupied,false);
  assert.notEqual(released.period_id,initial.period_id);assert.deepEqual(await state(2),peer);
  const next=await bind(1);const rebound=await state(1);
  assert.equal(rebound.generation,initial.generation);assert.equal(rebound.period_id,released.period_id);
  await assert.rejects(rpc('read',[one,null,null]),{code:'PT401'});
  assert.equal((await rpc('read',[next,null,null])).room,1);
  assert.ok((await db.query('select ended_at from g19_private.private_periods where id=$1',[initial.period_id])).rows[0].ended_at);
  const active=await device(next);
  await rpc('admin_change_resident',[1,rebound.generation,1],'service_role').then(()=>assert.fail('Service role must not reset rooms'),e=>assert.equal(e.code,'42501'));
  // The SQL-owner maintenance path is exercised only inside this isolated DB.
  await db.query('select public.g19_admin_change_resident(1,$1,1)',[rebound.generation]);
  const reset=await state(1);assert.equal(reset.generation,rebound.generation+1);assert.notEqual(reset.period_id,rebound.period_id);
  assert.ok(active);assert.deepEqual(await state(2),peer);
});
test('Private tables deny every API role, including a valid web-admin session; RLS fails closed',async t=>{
  const {db,rpc}=await setup(t);await db.exec(proposal);
  const user=randomUUID(),session=randomUUID();
  await db.query('insert into auth.users values($1)',[user]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[session,user]);
  await db.query('insert into g19_private.web_admin(user_id) values($1)',[user]);
  assert.equal((await rpc('web_admin_rooms',[],'authenticated',{sub:user,session_id:session})).length,4);
  const tables=['private_periods','private_current_period','private_conversations','private_members','private_messages','private_read_cursors','private_presence'];
  for(const role of ['anon','authenticated','service_role','g19_room_admin'])for(const table of tables){
    await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query('select count(*) from g19_private.'+table);}),{code:'42501'});
  }
  assert.equal((await db.query(`select count(*)::int n from pg_publication_tables where schemaname='g19_private' and tablename like 'private_%'`)).rows[0].n,0);
  // Even accidental table/schema grants must not expose rows through RLS.
  await db.exec('grant usage on schema g19_private to anon,authenticated; grant select,insert,update,delete on g19_private.private_periods to anon,authenticated');
  for(const role of ['anon','authenticated'])await db.transaction(async tx=>{
    await tx.exec('set local role '+role);
    assert.deepEqual((await tx.query('select * from g19_private.private_periods')).rows,[]);
    assert.equal((await tx.query('update g19_private.private_periods set ended_at=now() where room=1 returning id')).rows.length,0);
    assert.equal((await tx.query('delete from g19_private.private_periods where room=1 returning id')).rows.length,0);
  });
  await assert.rejects(db.transaction(async tx=>{await tx.exec('set local role anon');await tx.exec('insert into g19_private.private_periods(room) values(1)');}),{code:'42501'});
});
test('Private constraints separate pair identities, replies and read cursors; closed history is retained',async t=>{
  const {db,rpc,bind,state,device}=await setup(t);const tokens=[];for(let r=1;r<=4;r++)tokens[r]=await bind(r);
  await db.exec(proposal);const periods=[];for(let r=1;r<=4;r++)periods[r]=(await state(r)).period_id;
  const conversation=async(a,b)=>(await db.query(`insert into g19_private.private_conversations(room_low,period_low,room_high,period_high)
    values($1,$2,$3,$4) returning id`,[a,periods[a],b,periods[b]])).rows[0].id;
  const first=await conversation(1,2),other=await conversation(2,4);
  // A wrapper exists only in this in-memory fixture; foundation 020 alone exposes no RPC.
  await db.exec(`create function public.probe_private_context(text,uuid) returns uuid language sql security definer set search_path='' as
    $$select (g19_private.require_private_conversation($1,$2)).id$$;
    revoke all on function public.probe_private_context(text,uuid) from public;
    grant execute on function public.probe_private_context(text,uuid) to anon,authenticated;`);
  const access=(token,id,claims={})=>db.transaction(async tx=>{
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
    return (await tx.query('select public.probe_private_context($1,$2) id',[token,id])).rows[0].id;
  });
  assert.equal(await access(tokens[1],first),first);assert.equal(await access(tokens[2],first),first);
  await assert.rejects(access(tokens[3],first),{code:'PT404'});
  const admin=randomUUID(),adminSession=randomUUID();
  await db.query('insert into auth.users values($1)',[admin]);await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[adminSession,admin]);
  await db.query('insert into g19_private.web_admin(user_id) values($1)',[admin]);
  const claims={sub:admin,session_id:adminSession};
  assert.equal((await rpc('web_admin_rooms',[],'authenticated',claims)).length,4);
  await assert.rejects(access(tokens[1],other,claims),{code:'PT404'});
  await assert.rejects(access(tokens[1],randomUUID(),claims),{code:'PT404'});
  await assert.rejects(conversation(1,2),{code:'23505'});
  await assert.rejects(conversation(2,1),{code:'23514'});
  const insert=async(c,r,seq,reply=null)=>(await db.query(`insert into g19_private.private_messages(conversation_id,seq,device_id,sender_room,sender_period,request_id,body,reply_to)
    values($1,$2,$3,$4,$5,$6,'Izolowany test',$7) returning id`,[c,seq,await device(tokens[r]),r,periods[r],randomUUID(),reply])).rows[0].id;
  const original=await insert(first,1,1);await insert(first,2,2,original);await insert(other,2,1);
  await assert.rejects(insert(other,4,2,original),{code:'23503'});
  await assert.rejects(insert(first,3,3),{code:'23503'});
  await assert.rejects(db.query(`insert into g19_private.private_read_cursors(conversation_id,room,period_id,last_read_seq) values($1,3,$2,1)`,[first,periods[3]]),{code:'23503'});
  await assert.rejects(db.query(`insert into g19_private.private_read_cursors(conversation_id,room,period_id,last_read_seq) values($1,2,$2,2)`,[other,periods[2]]),{code:'23503'});
  const recipient=await device(tokens[2]);
  await db.query(`insert into g19_private.notification_inbox(device_id,category,event_key,title,description,target,created_at,private_conversation_id,private_message_id)
    values($1,'messages',$2,'Nowa wiadomość prywatna','Pokój nr 1',$3,now(),$4,$5)`,[recipient,'private:'+original,'#dyskusje/prywatne/'+first,first,original]);
  await assert.rejects(db.query(`update g19_private.notification_inbox set description='Message body must not enter notification metadata' where private_message_id=$1`,[original]),{code:'23514'});
  await rpc('revoke_device',[tokens[1],await device(tokens[1])]);
  assert.notEqual((await state(1)).period_id,periods[1]);
  const newcomer=await bind(1);
  await assert.rejects(access(newcomer,first),{code:'PT404'});
  assert.equal(await access(tokens[2],first),first);
  await assert.rejects(db.query('select g19_private.require_writable_private_conversation($1,$2)',[tokens[2],first]),{code:'PT409'});
  await rpc('revoke_device',[tokens[2],await device(tokens[2])]);
  const secondNewcomer=await bind(2);
  await assert.rejects(access(secondNewcomer,first),{code:'PT404'});
  assert.equal((await db.query('select count(*)::int n from g19_private.private_messages where conversation_id=$1',[first])).rows[0].n,2);
  assert.equal((await db.query(`select count(*)::int n from g19_private.private_conversations c
    join g19_private.private_current_period l on (l.room,l.period_id)=(c.room_low,c.period_low)
    join g19_private.private_current_period h on (h.room,h.period_id)=(c.room_high,c.period_high) where c.id=$1`,[first])).rows[0].n,0);
});

test('Foundation migration aborts atomically if an ALL TABLES publication could expose new tables',async t=>{
  const {db}=await setup(t);
  await db.exec('create publication g19_proposal_guard for all tables');
  await assert.rejects(db.exec(proposal),/Review ALL TABLES publications/);
  await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int n from pg_tables where schemaname='g19_private' and tablename like 'private_%'")).rows[0].n,0);
});
