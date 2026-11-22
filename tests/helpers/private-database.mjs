import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
const {PGlite}=await import(process.env.G19_PGLITE||'@electric-sql/pglite');
export async function setupPrivateDatabase(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);create table auth.sessions(id uuid primary key,user_id uuid references auth.users,created_at timestamptz not null default now());
 create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid() returns uuid language sql as $$select (auth.jwt()->>'sub')::uuid$$;`);
 const dir=new URL('../../supabase/migrations/',import.meta.url);
 for(const name of(await readdir(dir)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
 const rpc=(name,args=[],role='anon',claims={})=>db.transaction(async tx=>{
  await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
  return(await tx.query('select public.g19_'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') v',args)).rows[0].v;
 });
 assert.equal((await rpc('chat_capabilities')).privateChat,false);
 await assert.rejects(rpc('private_list',['0'.repeat(64)]),{code:'PT503'});
 await db.exec('update g19_private.private_chat_settings set enabled=true where singleton');
 const proof=()=>randomBytes(32).toString('hex');
 const bind=async room=>(await rpc('bind',[room,proof(),proof()])).token;
 const pair=async(token,room)=>{const p=await rpc('pair_start',[room,proof()]);await rpc('pair_decide',[token,p.code,true]);return(await rpc('pair_claim',[p.secret])).token;};
 const token=[];for(let i=1;i<=4;i++)token[i]=await bind(i);
 const freeRate=()=>db.exec('update g19_private.devices set next_message_at=null where next_message_at is not null');
 const peer=async(from,to)=>(await rpc('private_list',[from])).items.find(x=>x.room===to);
 const send=async(from,to,body,reply=null,key=randomUUID(),expected=null)=>{await freeRate();return rpc('private_send',[from,to,expected||(await peer(from,to)).peerPeriod,key,body,reply]);};
 const devices=token=>rpc('my_devices',[token,null,null]);
 return{db,rpc,bind,pair,token,freeRate,peer,send,devices};
}
