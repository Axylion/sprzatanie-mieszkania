const assert=require('node:assert/strict');
const {test}=require('node:test');
const {createServer}=require('node:http');
const {readFile,mkdir}=require('node:fs/promises');
const {join,resolve,extname}=require('node:path');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
test('Private UI uses real SQL: replies, drafts, scoped counts, archive and both themes on desktop/mobile',async t=>{
 const {setupPrivateDatabase}=await import('./helpers/private-database.mjs');
 const {db,rpc,token,freeRate,bind,send}=await setupPrivateDatabase(t);
 const root=resolve(__dirname,'..');
 const server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
  try{const body=name==='dyskusje/config.js'?'window.goleszanDiscussionsConfig={url:"https://g19private.supabase.co",publishableKey:"sb_publishable_testing"};':await readFile(join(root,name));
   res.writeHead(200,{'Content-Type':({'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json'})[extname(name)]||'application/octet-stream'}).end(body);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--no-sandbox']});t.after(()=>browser.close());
 const base='http://127.0.0.1:'+server.address().port+'/';
 const errors=[];let losePrivateSendResponse=true;
 const output=process.env.G19_PRIVATE_SCREENSHOTS;
 if(output)await mkdir(output,{recursive:true});
 async function pageFor(key){
  const ctx=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  await ctx.addInitScript(value=>{localStorage.setItem('goleszan19-discussion-device',value);localStorage.setItem('cleaning-theme','dark');},key);
  await ctx.route('https://g19private.supabase.co/**',async route=>{
   const method=new URL(route.request().url()).pathname.split('/').at(-1).replace(/^g19_/,'');const args=route.request().postDataJSON()||{};
   try{
    let data;
    if(method==='rooms')data=await db.transaction(async tx=>{await tx.exec('set local role anon');return(await tx.query('select * from public.g19_rooms()')).rows;});
    else {
     assert.match(method,/^[a-z_][a-z0-9_]*$/);
     const definitions=(await db.query("select proargnames from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1",['g19_'+method])).rows;
     if(definitions.length!==1)throw Object.assign(new Error('Unknown RPC'),{code:'function_unavailable'});
     const names=definitions[0].proargnames||[];assert.ok(Object.keys(args).every(k=>names.includes(k)),method);
     data=await rpc(method,names.map(k=>args[k]??null));
    }
    if(method==='private_send'&&losePrivateSendResponse){losePrivateSendResponse=false;await route.abort('failed');return;}
    await route.fulfill({json:data});
   }catch(error){await route.fulfill({status:400,json:{message:error.message==='Unknown RPC'?error.code:error.message,code:error.code}});}
  });
  const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));return page;
 }
 async function submitPrivate(page){
  const [request]=await Promise.all([
   page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/rest/v1/rpc/g19_private_send'),
   page.locator('#private-send').click()
  ]);
  const {p_body,p_reply}=request.postDataJSON();
  return {body:p_body,replyTo:p_reply};
 }
 const a=await pageFor(token[1]),b=await pageFor(token[2]);
 await a.goto(base+'#dyskusje');await a.locator('#discussion-tabs').waitFor();
 await a.locator('#discussion-body').fill('Niedokończony tekst ogólny');
 await a.locator('#private-tab').click();await a.locator('#private-list a').nth(2).waitFor();
 assert.equal(await a.locator('#private-list a').count(),3);
 await a.locator('#private-list a').filter({hasText:'Pokój nr 2'}).click();
 const originalBody='Tylko pokoje 1 i 2';
 await a.locator('#private-body').fill(originalBody);
 assert.deepEqual(await submitPrivate(a),{body:originalBody,replyTo:null});
 await a.locator('#private-status').filter({hasText:'Nie udało się odświeżyć rozmowy.'}).waitFor();
 assert.equal(await a.locator('#private-body').inputValue(),originalBody);
 assert.deepEqual(await submitPrivate(a),{body:originalBody,replyTo:null});
 await a.locator('.private-message p').getByText(originalBody,{exact:true}).waitFor();
 assert.equal((await db.query('select count(*)::int n from g19_private.private_messages')).rows[0].n,1);
 const conversation=new URL(a.url()).hash.split('/').at(-1);assert.match(conversation,/^[a-f0-9-]{36}$/);
 await freeRate();
 await rpc('send',[token[3],randomUUID(),'Historia ogólna po zmianie karty']);
 await a.locator('#general-tab').click();assert.equal(await a.locator('#discussion-body').inputValue(),'Niedokończony tekst ogólny');
 const generalMessage=a.locator('#discussion-history p').getByText('Historia ogólna po zmianie karty',{exact:true});
 await generalMessage.waitFor();
 const generalCard = generalMessage.locator('xpath=ancestor::li');
 assert.equal(await generalCard.locator('.discussion-meta strong a').count(), 0);
 assert.equal(await generalCard.getByRole('link', {name:'Napisz prywatnie'}).count(), 1);
 assert.equal(await a.locator('#discussion-room').textContent(), 'Pokój nr 1');
 await generalCard.getByRole('link', {name:'Napisz prywatnie'}).click();
 await a.locator('#private-dialog-view').waitFor();
 assert.equal(await a.locator('#private-peer-title').textContent(), 'Pokój nr 3');
 const privacy = a.locator('#private-dialog-view .private-privacy summary');
 await privacy.focus();
 await a.keyboard.press('Enter');
 await a.locator('#private-dialog-view .private-privacy summary[aria-expanded=true]').waitFor();
 await a.keyboard.press('Enter');
 await a.locator('#private-dialog-view .private-privacy summary[aria-expanded=false]').waitFor();
 await a.locator('#general-tab').click();
 await generalMessage.waitFor();
 const generalRead='**/rest/v1/rpc/g19_read';
 async function openGeneral() {
  await Promise.all([
   a.waitForResponse(r=>new URL(r.url()).pathname==='/rest/v1/rpc/g19_read'),
   a.locator('#general-tab').click()
  ]);
  await generalMessage.waitFor();
 }
 for(let i=0;i<10;i++){
  await a.locator('#private-tab').click();
  await a.locator('#private-list-view').waitFor();
  await openGeneral();
  assert.equal(await a.locator('#discussion-status').textContent(),'');
 }
 let releaseRead;
 const heldRead=new Promise(resolve=>{releaseRead=resolve;});
 let readStarted;
 const readInFlight=new Promise(resolve=>{readStarted=resolve;});
 let delayed=true;
 const delayRead=async route=>{
  if(!delayed)return route.fallback();
  delayed=false;
  readStarted();
  await heldRead;
  await route.fulfill({status:503,json:{message:'synthetic_delayed_failure'}});
 };
 await a.route(generalRead,delayRead);
 await a.locator('#private-tab').click();
 await a.locator('#general-tab').click();
 await readInFlight;
 await a.locator('#private-tab').click();
 await a.locator('#private-list-view').waitFor();
 await openGeneral();
 const lateResponse=a.waitForResponse(r=>r.status()===503&&new URL(r.url()).pathname==='/rest/v1/rpc/g19_read');
 releaseRead();
 await lateResponse;
 await a.unroute(generalRead,delayRead);
 assert.equal(await a.locator('#discussion-status').textContent(),'');
 await a.route(generalRead,r=>r.fulfill({status:503,json:{message:'synthetic_retry_failure'}}),{times:1});
 await a.locator('#private-tab').click();
 await a.locator('#general-tab').click();
 await a.locator('#discussion-status').filter({hasText:'Nie udało się odświeżyć rozmowy.'}).waitFor();
 await a.locator('#discussion-retry').click();
 await a.locator('#discussion-retry').waitFor({state:'hidden'});
 await a.waitForFunction(()=>document.getElementById('discussion-status').textContent==='');
 await generalMessage.waitFor();
 await b.goto(base+'#dyskusje');await b.locator('#private-tab-count:not([hidden])').waitFor();assert.equal(await b.locator('#private-tab-count').innerText(),'1');
 // A separate history entry must stay out of the reply, too.
 const historyBody='Wcześniejsza wiadomość\nDrugi wiersz historii';
 await send(token[1],2,historyBody);
 await b.locator('#private-tab').click();await b.locator('#private-list a').filter({hasText:'Pokój nr 1'}).click();
 await b.locator('.private-message').nth(1).waitFor();await b.waitForFunction(()=>document.getElementById('private-tab-count').hidden);
 const firstCard=b.locator('.private-message').first();
 const originalId=await firstCard.getAttribute('data-message');
 assert.equal(await firstCard.locator('p').textContent(),originalBody);
 assert.equal(await b.locator('.private-message p').nth(1).textContent(),historyBody);
 const replyBody='Odpowiedź prywatna\nDrugi wiersz odpowiedzi';
 await b.locator('#private-body').fill('  '+replyBody+'  ');
 await firstCard.locator('[data-reply]').click();
 assert.equal(await b.locator('#private-reply-target').isVisible(),true);
 assert.equal(await b.locator('#private-body').inputValue(),'  '+replyBody+'  ');
 await freeRate();
 assert.deepEqual(await submitPrivate(b),{body:replyBody,replyTo:originalId});
 const replyCard=b.locator('.private-message').nth(2);
 await replyCard.waitFor();
 const persisted=(await db.query(
  'select body, reply_to from g19_private.private_messages where conversation_id=$1 order by seq',
  [conversation]
 )).rows;
 assert.deepEqual(persisted,[
  {body:originalBody,reply_to:null},
  {body:historyBody,reply_to:null},
  {body:replyBody,reply_to:originalId}
 ]);
 assert.equal(await replyCard.locator('p').textContent(),replyBody);
 assert.equal(await replyCard.locator('.message-quote').getAttribute('data-original'),originalId);
 await replyCard.locator('.message-quote').click();
 assert.equal(await b.locator('.private-message.message-highlight').count(),1);
 // The quote, body and reply action must belong to one row and stay inside its bounds.
 for(const width of [320,375,390,768,1280]){
  await b.setViewportSize({width,height:900});
  const cards=await b.locator('#private-history > li[data-message]').evaluateAll(rows=>rows.map(row=>{
   const content=row.querySelector(':scope > .discussion-card-content');
   const box=row.getBoundingClientRect();
   const children=Array.from(content.children, element=>element.getBoundingClientRect());
   return {
    nested:row.querySelectorAll('[data-message]').length,
    quote:content.querySelector(':scope > .message-quote')?.nextElementSibling?.localName||null,
    contained:children.every(child=>child.left>=box.left&&child.right<=box.right&&child.top>=box.top&&child.bottom<=box.bottom)
   };
  }));
  assert.deepEqual(cards,[
   {nested:0,quote:null,contained:true},
   {nested:0,quote:null,contained:true},
   {nested:0,quote:'p',contained:true}
  ]);
 }

 const plainBody='Nowa wiadomość bez cytatu\nDrugi wiersz';
 await b.locator('#private-body').fill(plainBody);
 await freeRate();
 assert.deepEqual(await submitPrivate(b),{body:plainBody,replyTo:null});
 const plainCard=b.locator('.private-message').nth(3);
 await plainCard.waitFor();
 await b.reload();
 await plainCard.waitFor();
 assert.equal(await plainCard.locator('p').textContent(),plainBody);
 assert.equal(await plainCard.locator('.message-quote').count(),0);
 const plainId=await plainCard.getAttribute('data-message');
 assert.deepEqual((await db.query(
  'select body, reply_to from g19_private.private_messages where id=$1',[plainId]
 )).rows,[{body:plainBody,reply_to:null}]);
 await b.locator('#private-body').fill('Szkic dla pokoju 1');await b.locator('#private-back').click();
 await b.locator('#private-list a').filter({hasText:'Pokój nr 3'}).click();await b.locator('#private-body').fill('Inny szkic');
 await b.locator('#private-back').click();await b.locator('#private-list a').filter({hasText:'Pokój nr 1'}).click();
 await b.waitForFunction(()=>document.getElementById('private-body').value==='Szkic dla pokoju 1'&&!document.getElementById('private-dialog-view').hidden);
 assert.equal(await b.locator('#private-body').inputValue(),'Szkic dla pokoju 1');
 // General quote navigation also loads an original outside the latest 40 rows.
 await freeRate();const original=await rpc('send',[token[3],randomUUID(),'Oryginał poza bieżącą stroną']);
 for(let i=0;i<42;i++){await freeRate();await rpc('send',[token[1],randomUUID(),'Ogólna '+i]);}
 await freeRate();await rpc('send_reply',[token[3],randomUUID(),'Odpowiedź do starego oryginału',original]);
 await a.goto(base+'#dyskusje');await a.locator('#discussion-history .message-quote').waitFor();
 assert.equal(await a.locator('#discussion-history [data-message="'+original+'"]').count(),0);
 await a.locator('#discussion-history .message-quote').first().click();
 await a.locator('#discussion-history [data-message="'+original+'"].message-highlight').waitFor();
 await a.locator('#discussion-history [data-message="'+original+'"] [data-reply]').click();await a.locator('#discussion-body').fill('Ответ через интерфейс');
 await freeRate();await a.locator('#discussion-send').click();await a.locator('#discussion-history p').getByText('Ответ через интерфейс',{exact:true}).waitFor();
 if(output) {
  await a.locator('#discussion-view').screenshot({path:join(output,'general-reply-dark-desktop.png')});
  await b.locator('#discussion-view').screenshot({path:join(output,'private-dialog-dark-desktop.png')});
  await b.setViewportSize({width:390,height:900});
  assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await b.locator('#discussion-view').screenshot({path:join(output,'private-dialog-dark-mobile.png')});
  await b.setViewportSize({width:1280,height:900});
 }
 // A stale author link must not silently target the next resident of that room.
 await a.locator('#discussion-history .message-quote').first().click();
 const staleAuthor=await a.locator('#discussion-history [data-message="'+original+'"] .message-private-link').getAttribute('href');
 const thirdGeneration=(await db.query('select generation from g19_private.rooms where room=3')).rows[0].generation;
 await db.query('select public.g19_admin_change_resident(3,$1,1)',[thirdGeneration]);await bind(3);
 await a.goto(base+staleAuthor);
 await a.locator('#private-status').filter({hasText:'Okres pokoju się zmienił.'}).waitFor();
 assert.equal(await a.locator('#private-dialog-view').isVisible(),false);
 await a.goto(base+'#dyskusje');
 await a.reload();
 await a.locator('#discussion-history .message-quote[data-original="'+original+'"]').last().click();
 const oldCard = a.locator('#discussion-history [data-message="'+original+'"]');
 await oldCard.locator('strong').getByText(/poprzedni mieszkaniec/).waitFor();
 assert.equal(await oldCard.locator('.message-private-link').count(), 0);
 // Closing room 1 keeps room 2's archive but removes every write control.
 const generation=(await db.query('select generation from g19_private.rooms where room=1')).rows[0].generation;
 await db.query('select public.g19_admin_change_resident(1,$1,1)',[generation]);
 await b.locator('#private-readonly').waitFor();assert.equal(await b.locator('#private-compose').isVisible(),false);assert.equal(await b.locator('.private-message [data-reply]').count(),0);
 await b.locator('#private-back').click();await b.locator('#private-archive-list a').waitFor();assert.equal(await b.locator('#private-archive-list a').count(),1);
 for(const theme of['dark','light'])for(const width of[1280,390]){
  await b.setViewportSize({width,height:900});await b.locator('#theme-toggle').click();await b.locator('#theme-menu label:has(input[value="'+theme+'"])').click();await b.keyboard.press('Escape');
  assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(output)await b.locator('#discussion-view').screenshot({path:join(output,'archive-'+theme+'-'+width+'.png')});
  await b.locator('#private-archive-list a').click();await b.locator('.private-message').nth(1).waitFor();
  assert.equal(await b.locator('#private-compose').isVisible(),false);
  if(output)await b.locator('#discussion-view').screenshot({path:join(output,'archive-dialog-'+theme+'-'+width+'.png')});
  await b.locator('#private-back').click();await b.locator('#private-archive-list a').waitFor();
 }
 const newToken=await bind(1),newcomer=await pageFor(newToken);
 await newcomer.goto(base+'#dyskusje/prywatne/'+conversation);
 await newcomer.locator('#private-status').filter({hasText:'Rozmowa jest niedostępna.'}).waitFor();
 assert.equal(await newcomer.locator('.private-message').count(),0);
 await newcomer.locator('#private-tab').click();await newcomer.locator('#private-list a').filter({hasText:'Pokój nr 2'}).waitFor();
 assert.equal(await newcomer.locator('#private-list').textContent().then(s=>s.includes('Tylko pokoje')),false);
 assert.deepEqual(errors,[]);
});
