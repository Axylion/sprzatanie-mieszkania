const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createServer} = require('node:http');
const {readFile, mkdir} = require('node:fs/promises');
const {join, resolve, extname} = require('node:path');
const {chromium} = require('playwright');

test('Dark desktop presentation preserves notification reading, field focus and light/mobile layouts', async t => {
  const root = resolve(__dirname, '..');
  const config = 'window.goleszanDiscussionsConfig={url:"https://g19test.supabase.co",publishableKey:"sb_publishable_test",adminEmail:"admin@example.test"};';
  const types = {'.html':'text/html','.js':'application/javascript','.css':'text/css'};
  const server = createServer(async (req,res) => {
    const name = new URL(req.url,'http://localhost').pathname.slice(1) || 'index.html';
    try {
      const data = name === 'dyskusje/config.js' ? config : await readFile(join(root,name));
      res.writeHead(200, {'Content-Type': types[extname(name)] || 'application/octet-stream'}).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--no-sandbox']});
  t.after(() => browser.close());
  const context = await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  const events = ['messages','announcements','duties'].map((category,index) => ({
    id:String(index+1),category,title:['Nowa wiadomość','Ważne ogłoszenie','Przypomnienie o sprzątaniu'][index],
    description:['Pokój nr 3 · Dyskusje','Test powiadomienia Android','Pokój nr 2 · 21–22 listopada'][index],target:category === 'messages' ? '#dyskusje' : '#calendar-title',
    createdAt:['2026-11-19T06:51:00Z','2026-11-16T07:41:00Z','2026-11-16T07:00:00Z'][index],read:index===2
  }));
  const reads = [];
  let devices = [{id:'fixture-pc',kind:'computer',current:true,createdAt:'2026-11-21T12:00:00Z'}, {id:'fixture-phone',kind:'phone',current:false,createdAt:'2026-11-21T12:00:00Z'}];
  await context.addInitScript(() => localStorage.setItem('goleszan19-discussion-device','fixture-device'));
  await context.route('https://g19test.supabase.co/**', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1);
    const args = route.request().postDataJSON() || {};
    let json = null;
    if (method === 'g19_notifications') json = {items:events,unread:events.filter(e=>!e.read).length};
    if (method === 'g19_notification_read') {
      reads.push(args);
      events.filter(e => args.p_categories.includes(e.category) && (args.p_id===null || e.id===args.p_id)).forEach(e=>{e.read=true;});
    }
    if (method === 'g19_chat_navigation_count') json={latest:'1',unread:0};
    if (method === 'g19_notification_preferences') json=['messages','announcements','duties'];
    if (method === 'g19_push_status') json={categories:[],registered:false};
    if (method === 'g19_my_devices') json=devices;
    if (method === 'g19_public_announcements') json=[{id:'fixture-announcement',title:'Informacja testowa',body:'Dłuższa treść ogłoszenia. '.repeat(30),publishedAt:'2026-01-01T12:00:00Z',expiresAt:null}];
    if (method === 'g19_read') json={room:2,deviceCount:1,hasOlder:false,version:'1',messages:[
      {id:'1',room:1,mine:false,vote:1,up:2,down:0,body:'Dziękujemy za posprzątanie kuchni.\nPamiętajmy o porządku w częściach wspólnych.',createdAt:'2026-11-21T12:00:00Z'},
      {id:'2',room:3,mine:false,vote:0,up:0,down:1,body:'Proszę pamiętać o opróżnieniu kosza i przetarciu blatu po gotowaniu.',createdAt:'2026-11-21T12:05:00Z'},
      {id:'3',room:2,mine:true,vote:0,up:1,down:0,body:'Zrobione, dziękujemy za przypomnienie.',createdAt:'2026-11-21T12:10:00Z'}
    ]};
    if (method === 'g19_rooms') json=[];
    return route.fulfill({json});
  });
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const base = 'http://127.0.0.1:'+server.address().port+'/';
  await page.goto(base);
  const theme = async value => {
    await page.locator('#theme-toggle').click();
    await page.locator('#theme-menu label:has(input[value="'+value+'"])').click();
    await page.keyboard.press('Escape');
  };
  await theme('dark');
  const summary=page.locator('.cleaning-rules summary').first();
  await summary.hover();
  await page.waitForTimeout(170);
  assert.deepEqual(await summary.evaluate(el=>({
    color:getComputedStyle(el).color,arrow:getComputedStyle(el,'::before').borderTopColor,shadow:getComputedStyle(el).boxShadow
  })),{color:'rgb(99, 229, 239)',arrow:'rgb(99, 229, 239)',shadow:'none'});
  await summary.click();
  assert.equal(await summary.evaluate(el=>el.parentElement.open),true);
  assert.equal(await page.locator('#calendar-title').evaluate(el=>el.getBoundingClientRect().width),1);
  assert.equal(await page.locator('.dashboard-calendar').getAttribute('aria-labelledby'),'calendar-title');
  await page.locator('#calendar-next-date').waitFor();
  assert.equal(await page.locator('#calendar-next-room').innerText(),'Pokój nr 2');
  const output = process.env.G19_DARK_SCREENSHOTS;
  if (output) {
    await mkdir(output,{recursive:true});
    await page.locator('.dashboard-calendar').screenshot({path:join(output,'calendar-dark-desktop.png')});
  }
  await page.evaluate(()=>localStorage.setItem('cleaning-room',document.querySelector('#next-room').textContent.match(/\d+/)[0]));
  await page.reload();
  await page.locator('#calendar-next-date').waitFor();
  assert.equal(await page.locator('#calendar-next-room').innerText(),'Pokój nr 2');
  assert.equal(await page.locator('#calendar-upcoming').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(21, 61, 70)');
  assert.ok(await page.locator('#calendar-days .calendar-own').count()>=2);
  await page.evaluate(()=>localStorage.removeItem('cleaning-room'));
  await page.reload();
  assert.equal(await page.locator('#duty-push-warning').isVisible(),true);
  assert.match(await page.locator('#duty-push-warning').innerText(),/Powiadomienia są wyłączone/);
  if(output) await page.locator('.dashboard-calendar').screenshot({path:join(output,'calendar-reminder-warning.png')});
  for(const selector of ['#theme-toggle','[data-push-category="duties"]','.cleaning-rules summary','#announcements-open']) {
    const control=page.locator(selector).first();
    await control.hover();
    assert.equal(await control.evaluate(el=>getComputedStyle(el).boxShadow),'none',selector);
  }
  await page.locator('#device-list [data-kind="phone"][data-connected]').waitFor();
  const phonePath=await page.locator('#device-list [data-kind="phone"] path').getAttribute('d');
  const computerPath=await page.locator('#device-list [data-kind="computer"] path').getAttribute('d');
  devices=devices.filter(d=>d.kind==='computer');
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.locator('#device-list [data-kind="phone"]:not([data-connected])').waitFor();
  assert.equal(await page.locator('#device-list [data-kind="phone"] path').getAttribute('d'),phonePath);
  assert.equal(await page.locator('#device-list [data-kind="phone"] svg').evaluate(el=>getComputedStyle(el).color),'rgb(142, 174, 181)');
  await page.reload();
  await page.locator('#device-list [data-kind="phone"]:not([data-connected])').waitFor();
  assert.equal(await page.locator('#device-list [data-kind="phone"] path').getAttribute('d'),phonePath);
  devices=[{id:'fixture-pc',kind:'computer',current:false,createdAt:'2026-11-21T12:00:00Z'},{id:'fixture-phone',kind:'phone',current:true,createdAt:'2026-11-21T12:00:00Z'}];
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.locator('#device-list [data-kind="phone"][data-connected]').waitFor();
  devices=devices.filter(d=>d.kind==='phone');
  await page.evaluate(()=>dispatchEvent(new Event('online')));
  await page.locator('#device-list [data-kind="computer"]:not([data-connected])').waitFor();
  assert.equal(await page.locator('#device-list [data-kind="computer"] path').getAttribute('d'),computerPath);
  if(output) await page.locator('#device-list').screenshot({path:join(output,'devices-dark-desktop.png')});
  await page.locator('#announcements-open').click();
  await page.locator('#hidden-announcements-list button').waitFor();
  assert.equal(await page.locator('.announcement-list-icon').evaluate(el=>el.getBoundingClientRect().width),38);
  if(output) await page.locator('#announcements-panel').screenshot({path:join(output,'announcements-dark-desktop.png')});
  await page.locator('#hidden-announcements-list button').click();
  assert.equal(await page.locator('#ogloszenie-fixture-announcement').isVisible(),true);
  await page.goto(base);
  await page.locator('#notification-open').click();
  const panel = page.locator('#notification-panel');
  await panel.locator('#notification-list li').nth(2).waitFor();
  assert.equal(await panel.locator('.notification-category-icon').count(),3);
  assert.equal(await panel.evaluate(el=>Math.round(el.getBoundingClientRect().width)),736);
  const headerPositions = () => panel.evaluate(el => ['#notification-title','#notification-list','.notification-heading form'].map(s=>{const r=el.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.height];}));
  const beforeRead = await headerPositions();
  assert.ok(await panel.locator('#notification-read-all').evaluate(el=>{
    const r=el.getBoundingClientRect(),h=document.querySelector('#notification-title').getBoundingClientRect();
    return Math.abs((r.top+r.bottom)/2-(h.top+h.bottom)/2)<2;
  }));
  assert.ok(await panel.locator('a[data-unread] .notification-unread-dot').first().evaluate(el=>{
    const dot=el.getBoundingClientRect(),icon=el.parentElement.getBoundingClientRect();
    return dot.right>icon.right && dot.bottom>icon.bottom && dot.left>icon.left+20 && dot.top>icon.top+20;
  }));
  assert.equal(await panel.locator('.notification-category-icon').first().evaluate(el=>el.getBoundingClientRect().width),38);
  assert.equal(await panel.locator('#notification-list a').first().evaluate(el=>getComputedStyle(el).paddingTop),'15px');
  await panel.locator('#notification-list a').first().hover();
  assert.equal(await panel.locator('#notification-list a').first().evaluate(el=>getComputedStyle(el).boxShadow),'none');
  assert.equal(await panel.locator('a[data-unread]').count(),2);
  assert.equal(await panel.locator('.notification-unread-dot').evaluateAll(dots=>dots.filter(e=>getComputedStyle(e).display!=='none').length),2);
  assert.equal(await panel.locator('a[data-unread]').first().evaluate(el=>getComputedStyle(el).borderInlineStartWidth),'0px');
  if (output) await panel.screenshot({path:join(output,'notifications-dark-desktop.png')});
  await panel.locator('#notification-read-all').click();
  await page.waitForFunction(()=>document.querySelector('#notification-count').hidden);
  assert.equal(reads.length,1);
  assert.deepEqual(await headerPositions(), beforeRead);
  if(output) await panel.screenshot({path:join(output,'notifications-all-read.png')});
  assert.equal(await panel.locator('.notification-unread-dot').evaluateAll(dots=>dots.filter(e=>getComputedStyle(e).display!=='none').length),0);
  await panel.getByRole('button',{name:'Zamknij powiadomienia'}).click();
  await page.locator('#chat-open').click();
  await page.locator('.discussion-message').first().waitFor();
  assert.equal(await page.locator('#discussion-view').evaluate(el=>Math.round(el.getBoundingClientRect().width)),736);
  assert.equal(await page.locator('.discussion-avatar').first().innerText(),'1');
  assert.equal(await page.locator('.discussion-message').first().evaluate(el=>getComputedStyle(el).borderRadius),'10px');
  assert.equal(await page.locator('[data-reaction="1"]').first().evaluate(el=>getComputedStyle(el).color),'rgb(99, 229, 239)');
  await page.locator('#discussion-body').focus();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#discussion-body')).borderColor==='rgb(99, 229, 239)');
  assert.equal(await page.locator('#discussion-body').evaluate(el=>getComputedStyle(el).borderColor),'rgb(99, 229, 239)');
  assert.equal(await page.locator('.discussion-send-icon').isVisible(),true);
  assert.equal(await page.locator('#discussion-send').isDisabled(),true);
  assert.equal(await page.locator('#discussion-send').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(49, 87, 92)');
  await page.locator('#discussion-body').fill('Tekst wyłącznie lokalnego testu');
  assert.equal(await page.locator('#discussion-send').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(36, 127, 136)');
  assert.equal(await page.locator('#discussion-compose').evaluate(el=>getComputedStyle(el).borderRadius),'12px');
  assert.equal(await page.locator('#discussion-body').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  await page.locator('.discussion-subtitle').click();
  if (output) await page.locator('#discussion-view').screenshot({path:join(output,'discussion-dark-desktop.png')});
  for (const [width,mode] of [[1280,'light'],[390,'dark']]) {
    await page.setViewportSize({width,height:900});
    await theme(mode);
    assert.equal(await page.locator('.discussion-avatar').first().isVisible(),true);
    assert.equal(await page.locator('.discussion-send-label').isVisible(),true);
    assert.equal(await page.locator('.discussion-message').first().evaluate(el=>getComputedStyle(el).borderRadius),'10px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto(base);
    await page.locator('#calendar-next-date').waitFor();
    assert.equal(await page.locator('#calendar-next-room').innerText(),'Pokój nr 2');
    await page.locator('#chat-open').click();
    await page.locator('.discussion-message').first().waitFor();
  }
  assert.deepEqual(errors,[]);
});
