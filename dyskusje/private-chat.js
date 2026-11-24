(() => {
  const config=window.goleszanDiscussionsConfig;
  const ready=/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config?.url)&&/^sb_publishable_[A-Za-z0-9_-]+$/.test(config?.publishableKey);
  const token=()=>localStorage.getItem('goleszan19-discussion-device');
  const $=id=>document.getElementById(id);
  const prefix='#dyskusje/prywatne';
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const format=new Intl.DateTimeFormat('pl-PL',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Warsaw'});
  const drafts=new Map(),pending=new Set();
  let summaryPending=null,activityQueue=Promise.resolve(),lastInteraction=Date.now();
  for(const event of ["pointerdown","keydown","wheel","touchstart"])window.addEventListener(event,()=>{lastInteraction=Date.now();},{passive:true});
  let capabilitiesAt=0,capabilitiesLoading=false;
  let capabilities={},summary=null,current=null,routeVersion=0,summaryVersion=0,polling=false,archiveItems=[],archiveHasOlder=false,contextToken=token();
  const tabId=crypto.randomUUID();
  async function rpc(name,args={}) {
    const r=await fetch(config.url.replace(/\/$/,'')+'/rest/v1/rpc/g19_'+name,{method:'POST',headers:{apikey:config.publishableKey,'Content-Type':'application/json'},body:JSON.stringify(args),cache:'no-store',keepalive:name==='private_activity'&&!args.p_active,signal:AbortSignal.timeout(10000)});
    const data=await r.json().catch(()=>null);
    if(!r.ok)throw Object.assign(new Error('RPC failed'),{code:data?.message});
    return data;
  }
  function activity(args){
    const key=args.p_token;const call=activityQueue.catch(()=>{}).then(()=>key===token()?rpc('private_activity',args):null);activityQueue=call;return call;
  }
  const isPrivate=()=>location.hash.startsWith(prefix)&&!$('discussion-view').hidden;
  const notice=text=>{$('private-status').textContent=text;};
  function fail(error,key) {
    if(key!==token())return;
    if(error.code==='device_invalid') {reset();window.dispatchEvent(new Event('g19-device-revoked'));return;}
    notice(({private_context_changed:'Mieszkaniec pokoju się zmienił. Wróć do listy rozmów.',private_conversation_archived:'Rozmowa archiwalna — tylko do odczytu.',private_conversation_unavailable:'Rozmowa jest niedostępna.',private_chat_unavailable:'Prywatne rozmowy są obecnie niedostępne.',reply_unavailable:'Wiadomość jest niedostępna.',message_rate_limit:'Odczekaj chwilę i spróbuj ponownie.'})[error.code]||'Nie udało się odświeżyć rozmowy. Spróbuj ponownie.');
    if(current&&['private_context_changed','private_conversation_archived','private_conversation_unavailable'].includes(error.code)){
      current.readOnly=true;current.contextChanged=error.code==='private_context_changed';updateComposer();
      if(error.code==='private_conversation_unavailable')$('private-history').replaceChildren();
    }
  }
  function saveDraft(){if(current) drafts.set(current.key,{text:$('private-body').value,reply:current.reply,request:current.request});}
  function updateComposer(){
    const readOnly=!!current?.readOnly;
    $('private-compose').hidden=!current||readOnly;
    $('private-readonly').hidden=!current||!readOnly;
    $('private-readonly').textContent=current?.contextChanged?'Okres pokoju się zmienił. Otwórz nową rozmowę z listy.':current?.id?'Rozmowa archiwalna — tylko do odczytu.':'Pokój nie jest obecnie połączony. Wysyłanie wiadomości jest niedostępne.';
    $('private-send').disabled=!current||readOnly||pending.has(current.key)||!$('private-body').value.trim();
    $('private-reply-target').hidden=!current?.reply||readOnly;
    window.g19FitComposer?.($('private-body'));
  }
  function setReply(message){if(!current||current.readOnly)return;current.reply=message;current.request=null;
    $('private-reply-target').querySelector('span').textContent=message?'Odpowiedź · Pokój nr '+message.room+': '+message.body.slice(0,160):'';
    updateComposer();saveDraft();
  }
  function reset(){
    routeVersion++;summaryVersion++;summaryPending=null;current=null;summary=null;drafts.clear();pending.clear();archiveItems=[];
    $('private-history').replaceChildren();$('private-list').replaceChildren();$('private-archive-list').replaceChildren();$('private-body').value='';
    $('discussion-tabs').hidden=true;$('private-view').hidden=true;$('discussion-general').hidden=false;
    window.dispatchEvent(new CustomEvent('g19-private-count',{detail:0}));
  }
  function roomAvatar(room){const e=document.createElement('span');e.className='private-avatar';e.textContent=room;e.setAttribute('aria-hidden','true');return e;}
  function renderList(target,items,archive=false){
    target.replaceChildren(...items.map(item=>{
      const row=document.createElement('li'),link=document.createElement('a');
      link.href=prefix+'/'+(archive?item.id:item.conversation||'pokoj/'+item.room+'/'+item.peerPeriod);
      const content=document.createElement('span');content.className='private-list-content';
      const title=document.createElement('strong');title.textContent='Pokój nr '+item.room;
      const preview=document.createElement('span');preview.textContent=item.lastMessage||(item.canSend===false?'Pokój nie jest obecnie połączony.':'Rozpocznij rozmowę');
      content.append(title,preview);
      const at=archive?item.closedAt:item.lastAt;
      if(at){const time=document.createElement('time');time.dateTime=at;time.textContent=(archive?'Zamknięto: ':'')+format.format(new Date(at));content.append(time);}
      link.append(roomAvatar(item.room),content);
      if(item.unread){const badge=document.createElement('span');badge.className='private-unread';badge.textContent=item.unread>99?'99+':item.unread;badge.setAttribute('aria-label','Nieprzeczytane: '+item.unread);link.append(badge);}
      row.append(link);return row;
    }));
    if(!items.length){const row=document.createElement('li');row.textContent='Brak archiwalnych rozmów.';target.append(row);}
  }
  async function refreshSummary(){
    const key=token();if(summaryPending?.key===key)return summaryPending.promise;
    const promise=fetchSummary();summaryPending={key,promise};
    try{return await promise;}finally{if(summaryPending?.promise===promise)summaryPending=null;}
  }
  async function fetchSummary(){
    const key=token(),request=++summaryVersion;if(!key||!capabilities.privateChat)return;
    try{
      const data=await rpc('private_list',{p_token:key});
      if(key!==token()||request!==summaryVersion||!Array.isArray(data?.items))return;
      if(summary?.period&&summary.period!==data.period){reset();}
      summary=data;$('discussion-tabs').hidden=false;
      const count=$('private-tab-count');count.hidden=!data.unread;count.textContent=data.unread>99?'99+':data.unread;
      $('private-archive-open').hidden=!data.archiveCount;
      $('private-archive-count').textContent='('+data.archiveCount+')'+(data.archiveUnread?' · Nieprzeczytane: '+data.archiveUnread:'');
      renderList($('private-list'),data.items);
      window.dispatchEvent(new CustomEvent('g19-private-count',{detail:data.unread||0}));
    }catch(error){fail(error,key);}
  }
  async function loadArchive(more=false){
    const key=token(),version=routeVersion;
    try{
      const data=await rpc('private_archive',{p_token:key,p_before:more?archiveItems.at(-1)?.id:null});
      if(version!==routeVersion||key!==token())return;
      archiveItems=more?[...archiveItems,...data.items]:data.items;archiveHasOlder=data.hasOlder;
      renderList($('private-archive-list'),archiveItems,true);$('private-archive-more').hidden=!archiveHasOlder;
    }catch(error){fail(error,key);}
  }
  function renderMessages(items,bottom=false){
    const history=$('private-history'),bounds=history.getBoundingClientRect();
    const anchor=[...history.children].find(e=>e.dataset.message&&e.getBoundingClientRect().bottom>bounds.top);
    const offset=anchor?anchor.getBoundingClientRect().top-bounds.top:0;
    const active=document.activeElement?.closest('[data-message]');
    const focusedId=active?.dataset.message;
    const focusedAction=document.activeElement?.dataset.original?'[data-original]':document.activeElement?.dataset.reply?'[data-reply]':document.activeElement?.matches('.message-author-link')?'.message-author-link':null;
    history.replaceChildren(...items.map(message=>{
      const row=document.createElement('li');row.className='discussion-message private-message';row.dataset.message=message.id;row.dataset.mine=message.mine;
      const meta=document.createElement('div');meta.className='discussion-meta';
      const title=document.createElement('strong');
      title.textContent='Pokój nr '+message.room+(message.mine?' · Ty':'');
      const peer=summary?.items.find(item=>item.room===message.room);
      if(!current.readOnly&&!message.mine&&peer?.canSend&&peer.peerPeriod===current.expectedPeerPeriod){
        const link=document.createElement('a');
        link.className='message-author-link';
        link.href=prefix+'/'+(peer.conversation||'pokoj/'+peer.room+'/'+peer.peerPeriod);
        link.textContent=title.textContent;
        title.replaceChildren(link);
      }
      const time=document.createElement('time');time.dateTime=message.createdAt;time.textContent=format.format(new Date(message.createdAt));meta.append(title,time);
      const avatar=roomAvatar(message.room);
      avatar.innerHTML='<svg viewBox="0 0 24 24"><use href="#g19-person-icon"/></svg>';
      const card=document.createElement('div');card.className='discussion-card-content';card.append(meta);
      if(message.reply){
        const quote=document.createElement('button');quote.type='button';quote.className='message-quote';
        quote.dataset.original=message.reply.id;quote.textContent='Pokój nr '+message.reply.room+': '+message.reply.body;card.append(quote);
      }
      const body=document.createElement('p');body.textContent=message.body;card.append(body);
      if(!current.readOnly){
        const actions=document.createElement('div');actions.className='discussion-reactions';
        const reply=document.createElement('button');reply.type='button';reply.className='message-reply-action';
        reply.dataset.reply=message.id;reply.textContent='Odpowiedz';actions.append(reply);card.append(actions);
      }
      row.append(avatar,card);
      return row;
    }));
    if(!items.length){const row=document.createElement('li');row.textContent='Nie ma jeszcze wiadomości.';history.append(row);}
    if(bottom)history.scrollTop=history.scrollHeight;
    else if(anchor){const restored=[...history.children].find(e=>e.dataset.message===anchor.dataset.message);if(restored)history.scrollTop+=restored.getBoundingClientRect().top-bounds.top-offset;}
    if(focusedId&&focusedAction)history.querySelector('[data-message="'+focusedId+'"] '+focusedAction)?.focus({preventScroll:true});
  }
  async function reportSeen(force=false){
    const ctx=current,key=token();if(!ctx?.id||!key||!isPrivate())return;
    const history=$('private-history');
    const active=!document.hidden&&document.hasFocus()&&Date.now()-lastInteraction<120000&&!ctx.before&&history.scrollHeight-history.scrollTop-history.clientHeight<55;
    const seen=active?ctx.items.at(-1)?.seq:null;
    if(!force&&ctx.lastSeen===seen&&ctx.wasActive===active)return;
    ctx.lastSeen=seen;ctx.wasActive=active;
    try{
      await activity({p_token:key,p_tab:tabId,p_conversation:ctx.id,p_seen_seq:seen||null,p_active:active});
      if(key===token()&&ctx===current&&active){window.dispatchEvent(new Event('g19-private-read'));await refreshSummary();}
    }catch(error){if(ctx===current){ctx.lastSeen=null;fail(error,key);}}
  }
  function describePrivateDialog(archived) {
    $('private-back').setAttribute('aria-label', archived ? 'Wróć do archiwum' : 'Wróć do listy rozmów');
    $('private-peer-context').textContent = archived ? 'Rozmowa archiwalna' : 'Rozmowa prywatna';
  }
  function applyRead(data,bottom){
    current.id=data.conversation;current.room=data.peerRoom;current.readOnly=data.readOnly;current.items=data.messages;
    $('private-peer-title').textContent='Pokój nr '+data.peerRoom;
    $('private-back').href=data.readOnly?prefix+'/archiwum':prefix;
    describePrivateDialog(data.readOnly);
    $('private-older').hidden=!data.hasOlder;$('private-latest').hidden=!current.before;
    renderMessages(data.messages,bottom);updateComposer();
  }
  async function refreshDialog(bottom=false){
    const ctx=current,key=token(),version=routeVersion;if(!ctx||ctx.navigating)return;
    const readRequest=ctx.readVersion=(ctx.readVersion||0)+1;
    if(!ctx.id){
      const peer=summary?.items.find(p=>p.room===ctx.room);
      if(peer?.peerPeriod!==ctx.expectedPeerPeriod){ctx.readOnly=true;ctx.contextChanged=true;notice('Mieszkaniec pokoju się zmienił. Wróć do listy rozmów.');updateComposer();return;}
      ctx.readOnly=!peer?.canSend;updateComposer();
      if(peer?.conversation){ctx.id=peer.conversation;window.history.replaceState(window.history.state,'',prefix+'/'+ctx.id);}else return;
    }
    const history=$('private-history'),nearEnd=history.scrollHeight-history.scrollTop-history.clientHeight<55;
    const previousNewest=ctx.items.at(-1)?.seq;
    try{
      const data=await rpc('private_read',{p_token:key,p_conversation:ctx.id,p_before_seq:ctx.before,p_revision:null});
      if(version!==routeVersion||key!==token()||ctx!==current||readRequest!==ctx.readVersion)return;
      if(!bottom&&!ctx.before&&!nearEnd&&previousNewest&&ctx.items.length&&!data.messages.some(m=>m.id===ctx.items[0].id)){
        ctx.before=(BigInt(previousNewest)+1n).toString();$('private-latest').hidden=false;return;
      }
      applyRead(data,bottom||(!ctx.before&&nearEnd));
      if(!nearEnd&&previousNewest!==data.messages.at(-1)?.seq)$('private-latest').hidden=false;
      await reportSeen();
    }catch(error){if(ctx===current)fail(error,key);}
  }
  async function route(){
    saveDraft();const old=current;current=null;const version=++routeVersion;
    if(old?.id&&token())activity({p_token:token(),p_tab:tabId,p_conversation:old.id,p_seen_seq:null,p_active:false}).catch(()=>{});
    const mode=isPrivate();$('discussion-general').hidden=mode;$('private-view').hidden=!mode;
    for(const [id,selected]of[['general-tab',!mode],['private-tab',mode]]){if(selected)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
    if(!mode)return;
    $('private-list-view').hidden=true;$('private-archive-view').hidden=true;$('private-dialog-view').hidden=true;notice('');
    if(!capabilities.privateChat||!token()){notice('Prywatne rozmowy są obecnie niedostępne. Otwórz Ogólne, aby sprawdzić połączenie.');return;}
    await refreshSummary();if(version!==routeVersion||!summary)return;
    $('discussion-chat').hidden=false;window.dispatchEvent(new Event('g19-chat-connected'));
    const tail=location.hash.slice(prefix.length).replace(/^\//,'');
    if(!tail){$('private-list-view').hidden=false;return;}
    if(tail==='archiwum'){$('private-archive-view').hidden=false;archiveItems=[];await loadArchive();return;}
    const roomMatch=/^pokoj\/([1-4])(?:\/([0-9a-f-]{36}))?$/i.exec(tail),peer=roomMatch?summary.items.find(p=>p.room===Number(roomMatch[1])):summary.items.find(p=>p.conversation===tail);
    if((!roomMatch&&!uuid.test(tail))||(roomMatch&&!peer)){notice('Rozmowa jest niedostępna.');return;}
    if(roomMatch?.[2]&&(!uuid.test(roomMatch[2])||roomMatch[2]!==peer.peerPeriod)){notice('Okres pokoju się zmienił. Otwórz nową rozmowę z listy.');return;}
    current={id:roomMatch?(peer.conversation||null):tail,room:peer?.room,expectedPeerPeriod:peer?.peerPeriod,readOnly:peer?.canSend===false,before:null,items:[],reply:null,request:null,key:null};
    const ctx=current,key=token();
    if(!ctx.room){
      try{const data=await rpc('private_read',{p_token:key,p_conversation:ctx.id,p_before_seq:null,p_revision:null});if(version!==routeVersion||key!==token())return;ctx.room=data.peerRoom;ctx.readOnly=data.readOnly;ctx.expectedPeerPeriod=summary.items.find(p=>p.room===ctx.room)?.peerPeriod;ctx.items=data.messages;}
      catch(error){fail(error,key);return;}
    }
    ctx.key=summary.period+':'+ctx.room+':'+(ctx.readOnly?ctx.id:ctx.expectedPeerPeriod);
    const draft=drafts.get(ctx.key);$('private-body').value=draft?.text||'';ctx.reply=draft?.reply||null;ctx.request=draft?.request||null;
    $('private-reply-target').querySelector('span').textContent=ctx.reply?'Odpowiedź · Pokój nr '+ctx.reply.room+': '+ctx.reply.body.slice(0,160):'';
    $('private-back').href=ctx.readOnly&&ctx.id?prefix+'/archiwum':prefix;
    describePrivateDialog(ctx.readOnly && ctx.id);
    $('private-peer-title').textContent='Pokój nr '+ctx.room;
    $('private-dialog-view').hidden=false;renderMessages(ctx.items,true);updateComposer();
    if(ctx.id&&roomMatch)window.history.replaceState(window.history.state,'',prefix+'/'+ctx.id);
    await refreshDialog(true);
    if(version===routeVersion)$('private-peer-title').focus({preventScroll:true});
  }
  $('private-compose').addEventListener('submit',async event=>{
    event.preventDefault();const ctx=current,key=token(),text=$('private-body').value.trim();
    if(!ctx||ctx.readOnly||!text||text.length>1500||pending.has(ctx.key))return;
    ctx.request||=crypto.randomUUID();const request=ctx.request,reply=ctx.reply?.id||null;saveDraft();pending.add(ctx.key);updateComposer();
    try{
      const result=await rpc('private_send',{p_token:key,p_peer:ctx.room,p_expected_peer_period:ctx.expectedPeerPeriod,p_request:request,p_body:text,p_reply:reply});
      if(key!==token())return;
      const stored=drafts.get(ctx.key);if(stored?.request===request)drafts.delete(ctx.key);
      if(ctx!==current)return;
      if($('private-body').value.trim()===text){$('private-body').value='';setReply(null);}
      ctx.request=null;ctx.id=result.conversation;ctx.before=null;notice('');window.history.replaceState(window.history.state,'',prefix+'/'+ctx.id);
      await refreshSummary();await refreshDialog(true);
    }catch(error){if(ctx===current)fail(error,key);}
    finally{pending.delete(ctx.key);if(ctx===current)updateComposer();}
  });
  $('private-body').addEventListener('input',()=>{if(current){current.request=null;saveDraft();updateComposer();}});
  $('private-reply-target').querySelector('button').addEventListener('click',()=>{setReply(null);$('private-body').focus();});
  $('private-history').addEventListener('click',async event=>{
    const reply=event.target.closest('[data-reply]');if(reply&&current&&!current.readOnly){setReply(current.items.find(m=>m.id===reply.dataset.reply));$('private-body').focus();return;}
    const original=event.target.closest('[data-original]');if(!original||!current)return;
    const ctx=current,key=token(),version=routeVersion;
    ctx.navigating=true;ctx.readVersion=(ctx.readVersion||0)+1;
    try{
      let row=$('private-history').querySelector('[data-message="'+original.dataset.original+'"]');
      if(!row){const data=await rpc('private_message',{p_token:key,p_conversation:ctx.id,p_message:original.dataset.original});if(ctx!==current||key!==token()||version!==routeVersion)return;ctx.before=data.before;applyRead(data,false);row=$('private-history').querySelector('[data-message="'+data.focusId+'"]');}
      if(row){row.tabIndex=-1;row.focus({preventScroll:true});row.scrollIntoView({block:'center'});row.classList.add('message-highlight');setTimeout(()=>row.classList.remove('message-highlight'),1800);}
    }catch(error){if(ctx===current)fail(error,key);}
    finally{ctx.navigating=false;}
  });
  $('private-older').addEventListener('click',()=>{if(current?.items.length){current.before=current.items[0].seq;refreshDialog(true);}});
  $('private-latest').addEventListener('click',()=>{if(current){current.before=null;refreshDialog(true);}});
  $('private-archive-more').addEventListener('click',()=>loadArchive(true));
  $('private-history').addEventListener('scroll',()=>reportSeen());
  window.addEventListener('hashchange',()=>route());
  window.addEventListener('g19-inbox-read',()=>refreshSummary());
  window.addEventListener('g19-device-changed',()=>{contextToken=token();reset();refreshSummary().then(route);});
  window.addEventListener('g19-device-revoked',reset);
  window.addEventListener('storage',event=>{if(event.key==='goleszan19-discussion-device'||event.key===null){contextToken=token();reset();refreshSummary().then(route);}});
  window.addEventListener('focus',()=>reportSeen(true));
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&current?.id)activity({p_token:token(),p_tab:tabId,p_conversation:current.id,p_seen_seq:null,p_active:false}).catch(()=>{});else poll();});
  async function poll(){
    if(polling||document.hidden||!ready)return;polling=true;
    try{if(Date.now()-capabilitiesAt>30000)await loadCapabilities();
      if(!capabilities.privateChat)return;
      if(token()!==contextToken){contextToken=token();reset();}
      await refreshSummary();if(isPrivate()){if(current)await refreshDialog();else if(location.hash===prefix+'/archiwum'&&!archiveHasOlder)await loadArchive();}
    }finally{polling=false;}
  }
  async function loadCapabilities(){
    if(!ready||capabilitiesLoading)return;capabilitiesLoading=true;capabilitiesAt=Date.now();
    try {
      const data=await rpc('chat_capabilities');if(data?.version!==1)return;
      const changed=data.privateChat!==capabilities.privateChat||data.replies!==capabilities.replies;
      if(capabilities.privateChat&&!data.privateChat)reset();
      capabilities=data;window.g19ChatCapabilities=data;
      window.dispatchEvent(new CustomEvent('g19-chat-capabilities',{detail:data}));
      if(changed){await refreshSummary();await route();}
    }catch{/* Retry on reconnect and through the bounded background poll. */}
    finally{capabilitiesLoading=false;}
  }
  window.addEventListener('online',()=>loadCapabilities().then(poll));
  if(ready)loadCapabilities();
  setInterval(poll,5000);setInterval(()=>{if(current&&isPrivate()&&!document.hidden)reportSeen(true);},20000);
})();
