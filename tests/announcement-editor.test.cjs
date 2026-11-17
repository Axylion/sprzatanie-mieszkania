const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join, resolve, extname } = require('node:path');
const { chromium } = require('playwright');

test('Announcement editor formats the current block, previews, publishes, hides edits and withdraws', async t => {
  const root = resolve(__dirname, '..');
  const config = 'window.goleszanDiscussionsConfig={url:"https://g19test.supabase.co",publishableKey:"sb_publishable_test",adminEmail:"admin@example.test"};';
  const types = {'.css':'text/css','.js':'application/javascript','.html':'text/html'};
  const server = createServer(async (req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    try {
      const body = name === 'dyskusje/config.js' ? config : await readFile(join(root, name));
      res.writeHead(200, {'Content-Type':types[extname(name)] || 'application/octet-stream'}).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args:['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:1280,height:900} });
  let record;
  let filterFixtures = [];
  await context.route('https://g19test.supabase.co/**', async route => {
    const url = new URL(route.request().url());
    const method = url.pathname.split('/').at(-1);
    const args = route.request().postDataJSON() || {};
    let json = [];
    if (url.pathname === '/auth/v1/token') json = {access_token:'test-admin',expires_in:3600};
    if (method === 'g19_web_admin_announcements') json = record ? [record, ...filterFixtures] : filterFixtures;
    if (method === 'g19_web_admin_save_announcement') {
      record = {
        id:args.p_id, title:args.p_title, summary:'Treść ogłoszenia', content:args.p_content, endsOn:args.p_ends_on,
        revision:(record?.revision || 0)+1, status:args.p_publish || record?.status === 'published' ? 'published' : 'draft',
        publishedAt:args.p_publish ? new Date(Date.now()-5000).toISOString() : record?.publishedAt,
        expiresAt:args.p_publish ? new Date(Date.now()+86400000).toISOString() : record?.expiresAt
      };
      json = record.id;
    }
    if (method === 'g19_public_announcements' && record?.status === 'published') {
      json = [{...record, version:record.revision, body:'Treść ogłoszenia'}];
    }
    if (method === 'g19_web_admin_withdraw_announcement') record.status = 'withdrawn';
    if (method === 'g19_web_admin_delete_announcement') record = undefined;
    return route.fulfill({json, headers:{'Access-Control-Allow-Origin':'*'}});
  });
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(base + '#administracja');
  await page.getByLabel('Hasło').fill('password');
  await page.getByRole('button',{name:'Zaloguj się'}).click();
  await page.locator('#admin-sections [data-section="announcements"]').click();
  const filters = page.locator('#admin-announcement-filter');
  assert.deepEqual(await filters.locator('button').evaluateAll(buttons => buttons.map(b => b.dataset.filter)),
    ['published','draft','expired','withdrawn','all']);
  assert.equal(await filters.locator('[aria-pressed=true]').getAttribute('data-filter'),'published');
  await page.locator('#announcement-new').click();
  await page.locator('#admin-announcement-form input[name="title"]').fill('Przerwa w dostawie wody');
  const editor=page.locator('#announcement-editor');
  await editor.fill('Nagłówek');
  for (const line of ['Termin','Szczegóły','Przygotuj zapas wody']) {
    await editor.press('End');
    await editor.press('Enter');
    await page.keyboard.insertText(line);
  }
  const selectLine = (label, all = false) => editor.evaluate((element,{label,all})=>{
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node=walker.nextNode()) && node.textContent !== label) {}
    if (!node) throw new Error('Missing editor line: ' + label + ' in ' + element.innerHTML);
    const selection = document.getSelection();
    selection.setBaseAndExtent(node, all ? 0 : label.length, node, label.length);
    document.dispatchEvent(new Event('selectionchange'));
  },{label,all});
  await selectLine('Nagłówek');
  await page.locator('#announcement-paragraph').selectOption('h2');
  await selectLine('Termin');
  await page.locator('#announcement-paragraph').selectOption('h3');
  await selectLine('Szczegóły',true);
  await page.getByRole('button',{name:'Pogrubienie'}).click();
  await editor.press('Control+z');
  assert.equal(await editor.locator('b,strong').count(),0);
  await editor.press('Control+y');
  assert.equal(await editor.locator('b,strong').count(),1);
  page.once('dialog',dialog=>dialog.accept('https://example.org/harmonogram'));
  await page.getByRole('button',{name:'Link',exact:true}).click();
  assert.equal(await page.locator('#admin-announcement-preview h2').textContent(),'Nagłówek');
  assert.equal(await page.locator('#admin-announcement-preview .announcement-body h3').textContent(),'Termin');
  assert.equal(await page.locator('#admin-announcement-preview a').getAttribute('href'),'https://example.org/harmonogram');
  assert.equal(await page.locator('#admin-announcement-preview strong').textContent(),'Szczegóły');
  await selectLine('Przygotuj zapas wody');
  await page.getByRole('button',{name:'Lista punktowana'}).click();
  assert.equal(await page.locator('#admin-announcement-preview ul li').textContent(),'Przygotuj zapas wody');
  const paragraphs = '<div>Pierwszy akapit<div><br></div><div>Drugi akapit</div></div>';
  await editor.evaluate((element, html) => {
    element.insertAdjacentHTML('beforeend', html);
    element.dispatchEvent(new InputEvent('input', {bubbles:true}));
  }, paragraphs);
  const paragraphsIn = locator => locator.evaluate(element => [...element.querySelectorAll(':scope > p')].slice(-3).map(p => p.textContent));
  const previewBody = page.locator('#admin-announcement-preview .announcement-body');
  assert.deepEqual(await paragraphsIn(previewBody), ['Pierwszy akapit','','Drugi akapit']);
  assert.equal(await page.getByRole('button',{name:'Zapisz zmiany'}).count(),0);
  const positions = () => page.locator('#admin-announcement-form').evaluate(form=>[...form.children].map(item=>{
    const {x,y}=item.getBoundingClientRect();
    return {x,y};
  }));
  const [wideForm, widePreview] = await positions();
  assert.ok(widePreview.x > wideForm.x && widePreview.y === wideForm.y);
  await page.setViewportSize({width:390,height:850});
  const [mobileForm, mobilePreview] = await positions();
  assert.ok(mobilePreview.y > mobileForm.y && mobilePreview.x === mobileForm.x);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));

  if (process.env.G19_V138_SCREENSHOTS) {
    await page.setViewportSize({width:1280,height:900});
    await page.locator('#theme-toggle').click();
    await page.locator('#theme-menu label:has(input[value="dark"])').click();
    await page.screenshot({path:join(process.env.G19_V138_SCREENSHOTS,'goleszan-v13-8-editor.png'),fullPage:true,animations:'disabled'});
  }

  await page.getByRole('button',{name:'Zapisz szkic'}).click();
  const list=page.locator('#admin-announcement-list');
  await filters.getByRole('button',{name:'Szkice (1)',exact:true}).click();
  await list.getByText('Szkic',{exact:true}).waitFor();
  assert.ok(!record.publishedAt);
  await list.getByRole('button',{name:'Edytuj'}).click();
  assert.deepEqual(await paragraphsIn(editor), ['Pierwszy akapit','','Drugi akapit']);
  const publish = page.getByRole('button',{name:'Opublikuj',exact:true});
  const confirmation = page.getByRole('dialog',{name:'Opublikować ogłoszenie?'});
  for (const theme of ['light', 'dark']) {
    await page.locator('#theme-toggle').click();
    await page.locator('#theme-menu label:has(input[value="' + theme + '"])').click();
    for (const width of [390,1280]) {
      await page.setViewportSize({width,height:850});
      assert.equal(await page.locator('#admin-title').textContent(),'Ważne ogłoszenia');
      assert.equal(await page.locator('#admin-announcement-preview .announcement-date').textContent(),'Podgląd — nieopublikowane');
      const h = await page.locator('#admin-announcement-preview .announcement-body').evaluate(body=>
        [body.querySelector('h2'),body.querySelector('h3'),body].map(el=>parseFloat(getComputedStyle(el).fontSize)));
      assert.ok(h[0]>h[1] && h[1]>h[2]);
      assert.equal(await editor.locator('h2').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),h[0]);
      assert.equal(await editor.locator('h3').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)),h[1]);
      await page.locator('#announcement-date-open').click();
      const picker=page.locator('#announcement-date-dialog');
      await picker.locator('[aria-current="date"]').waitFor();
      const today = await picker.locator('[aria-current="date"]').textContent();
      if (Number(today) > 1) assert.equal(await picker.locator('#announcement-date-days button').first().isDisabled(),true);
      await picker.getByRole('button',{name:'Następny miesiąc'}).click();
      await picker.getByRole('button',{name:'Poprzedni miesiąc'}).click();
      const currentMonth=await picker.locator('#announcement-date-month').textContent();
      await picker.getByRole('button',{name:'Następny rok'}).click();
      assert.notEqual(await picker.locator('#announcement-date-month').textContent(),currentMonth);
      await picker.getByRole('button',{name:'Poprzedni rok'}).click();
      await picker.locator('[aria-current="date"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      assert.match(await page.locator('#announcement-end-date').inputValue(),/^\d{4}-\d\d-\d\d$/);
      await page.locator('#announcement-date-clear').click();
      assert.equal(await page.locator('#announcement-end-date').inputValue(),'');
      const active = page.locator('#admin-sections [aria-pressed="true"]');
      await page.mouse.move(0,0);
      const before=await active.evaluate(e=>getComputedStyle(e).boxShadow);
      await active.hover();
      assert.notEqual(await active.evaluate(e=>getComputedStyle(e).boxShadow),before);
      assert.equal(await active.getAttribute('aria-pressed'),'true');
      await publish.click();
      await confirmation.getByRole('button',{name:'Anuluj'}).waitFor();
      assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Anuluj');
      await page.keyboard.press('Escape');
      await confirmation.waitFor({state:'hidden'});
      assert.equal(await publish.evaluate(e=>e===document.activeElement),true);
      assert.equal(record.status,'draft');
    }
  }
  await publish.click();
  await confirmation.getByRole('button',{name:'Opublikuj i wyślij powiadomienia'}).click();
  await filters.getByRole('button',{name:'Opublikowane (1)',exact:true}).click();
  await list.getByText('Opublikowane',{exact:true}).waitFor();
  await list.getByRole('button',{name:'Edytuj'}).click();
  const firstPublication = new Intl.DateTimeFormat('pl-PL',{dateStyle:'medium',timeZone:'Europe/Warsaw'}).format(new Date(record.publishedAt));
  assert.equal(await page.locator('#admin-announcement-preview .announcement-date').textContent(),'Opublikowano: '+firstPublication);
  await page.locator('#announcement-cancel').click();
  const resident=await context.newPage();
  await resident.goto(base + '#ogloszenie-' + record.id);
  const card=resident.locator('#announcements-card .announcement-entry');
  await card.waitFor();
  assert.deepEqual(await paragraphsIn(card.locator('.announcement-body')), ['Pierwszy akapit','','Drugi akapit']);
  await card.locator('.announcement-toggle').click();
  assert.equal(await card.locator('.announcement-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1),true);
  assert.equal(await card.locator('.announcement-body h2').textContent(),'Nagłówek');
  assert.equal(await card.locator('.announcement-body a').getAttribute('href'),'https://example.org/harmonogram');
  await card.locator('.announcement-dismiss').click();
  assert.equal(await card.count(),0);
  await list.getByRole('button',{name:'Edytuj'}).click();
  await page.locator('#admin-announcement-form input[name="title"]').fill('Przerwa w dostawie wody · aktualizacja');
  await page.getByRole('button',{name:'Zapisz zmiany'}).click();
  await list.getByRole('heading',{name:/aktualizacja/}).waitFor();
  await resident.reload();
  await card.waitFor({state:'hidden'});
  await resident.locator('#announcements-open').click();
  await resident.getByRole('button',{name:/aktualizacja/}).click();
  await card.getByRole('heading',{name:/aktualizacja/}).waitFor();
  page.once('dialog',dialog=>dialog.accept());
  await list.getByRole('button',{name:'Wycofaj z publikacji'}).click();
  await page.getByRole('button',{name:'Wycofane (1)',exact:true}).waitFor();
  assert.equal(await list.locator('article').count(),0);
  await page.getByRole('button',{name:'Szkice (0)',exact:true}).click();
  assert.equal(await list.locator('article').count(),0);
  await page.getByRole('button',{name:'Wycofane (1)',exact:true}).click();
  assert.equal(await list.locator('article').count(),1);
  const adminHeading = page.locator('#admin-title');
  const headingStyle = () => adminHeading.evaluate(el=>{
    const s=getComputedStyle(el);
    return [s.fontSize,s.lineHeight,el.offsetLeft];
  });
  const announcementHeading = await headingStyle();
  await page.getByRole('button',{name:'Pokoje',exact:true}).click();
  assert.equal(await adminHeading.textContent(),'Zarządzanie pokojami');
  assert.deepEqual(await headingStyle(),announcementHeading);
  await page.locator('#admin-sections [data-section="announcements"]').click();
  await resident.reload();
  assert.deepEqual(await resident.locator('#announcements-card').getAttribute('hidden'),'');
  await list.getByRole('button',{name:'Edytuj'}).click();
  assert.match(await page.locator('#admin-announcement-preview .announcement-date').textContent(), /^Wycofane · Opublikowano:/);
  await page.locator('#announcement-cancel').click();
  const deletion = page.locator('#announcement-delete-dialog');
  await list.getByRole('button',{name:'Usuń',exact:true}).click();
  await deletion.getByRole('button',{name:'Anuluj'}).click();
  assert.equal(await list.locator('article').count(),1);
  await list.getByRole('button',{name:'Usuń',exact:true}).click();
  await deletion.getByRole('button',{name:'Usuń',exact:true}).click();
  await page.getByRole('button',{name:'Wycofane (0)',exact:true}).waitFor();
  assert.equal(await list.locator('article').count(),0);
  filterFixtures = ['published','draft','expired','withdrawn'].map(status => ({
    id:status, status, title:'Ogłoszenie ' + status, summary:'Tekst', revision:1
  }));
  await page.getByRole('button',{name:'Odśwież',exact:true}).click();
  await filters.getByRole('button',{name:'Wszystkie (4)',exact:true}).click();
  assert.deepEqual(await list.locator('article').evaluateAll(rows => rows.map(row => row.dataset.state)),
    ['published','draft','expired','withdrawn']);
  for (const [label,status] of [['Opublikowane','published'],['Szkice','draft'],['Wygasłe','expired'],['Wycofane','withdrawn']]) {
    await filters.getByRole('button',{name:label+' (1)',exact:true}).click();
    assert.deepEqual(await list.locator('article').evaluateAll(rows => rows.map(row => row.dataset.state)), [status]);
  }
  await page.getByRole('button',{name:'Wyloguj'}).click();
  await page.getByRole('button',{name:'Zaloguj się'}).waitFor();
  assert.equal(await editor.textContent(),'');
  assert.equal(await page.locator('#admin-announcement-preview .announcement-body').textContent(),'');
  assert.deepEqual(errors,[]);
});
