const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'textdrop-categories-'));
  const captures = path.join(os.tmpdir(),'textdrop-categories-review'); fs.mkdirSync(captures,{recursive:true});
  let server, browser, logs='';
  try {
    server = spawn('python3',['server.py'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,TEXTDROP_HOST:'127.0.0.1',TEXTDROP_PORT:'0',TEXTDROP_DATA:temp,TEXTDROP_PASSWORD:'test-password',TEXTDROP_SECRET:'categories-test-secret-'.repeat(3)},stdio:['ignore','pipe','pipe']});
    server.stderr.on('data',chunk=>logs+=chunk);
    const port = await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.once('exit',()=>reject(Error(logs)));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
    const base='http://127.0.0.1:'+port;
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:850}}), other=await browser.newContext({viewport:{width:390,height:844}});
    const page=await context.newPage(), second=await other.newPage(), errors=[];
    for(const p of [page,second])p.on('pageerror',e=>errors.push(e.message));
    const idle=async p=>p.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);
    const sync=async p=>{await p.evaluate(()=>sync());await idle(p);};
    const login=async(p,user='admin')=>{await p.goto(base);await p.locator('#username').fill(user);await p.locator('#password').fill('test-password');await p.locator('#login-form button[type=submit]').click();await idle(p);};
    await login(page);await login(second);
    const categories=await (await context.request.get(base+'/api/categories')).json();
    const work=categories.find(c=>c.name==='Работа'),ideas=categories.find(c=>c.name==='Идеи'),done=categories.find(c=>c.name==='Сделано');
    const create=async text=>(await context.request.post(base+'/api/notes',{data:{text}})).json();
    const a=await create('Рабочий план <img src=x>'), b=await create('Прочитать статью'), c=await create('Отложенное');
    const metadata=Buffer.from(JSON.stringify({name:'рабочий-план.txt',text:'Файл с подписью',request_id:'categories-file-request'}));
    const file=await (await context.request.post(base+'/api/files',{data:Buffer.concat([metadata,Buffer.from('private bytes')]),headers:{'Content-Type':'application/octet-stream','X-Textdrop-Metadata-Length':String(metadata.length)}})).json();
    await sync(page);
    const article=(p,id)=>p.locator('.note[data-id="'+id+'"]');
    const choice=(p,id)=>p.locator('#category-choices [data-category-id="'+id+'"]');
    const mark=async(p,id,cat)=>{await article(p,id).locator('[data-action=categories]').click();await choice(p,cat.id).click();await p.waitForFunction(()=>!categoryUI.pending);};
    const filter=async(p,cat)=>{await p.locator('#category-filter').click();if(cat)await choice(p,cat.id).click();else await p.locator('#category-choices').getByRole('button',{name:'Все сообщения',exact:true}).click();await idle(p);};
    await mark(page,a.id,work);await choice(page,ideas.id).click();await page.waitForFunction(()=>!categoryUI.pending);
    assert.equal(await article(page,a.id).locator('.category-reaction').count(),2);
    await page.keyboard.press('Escape');await mark(page,file.id,work);await page.keyboard.press('Escape');
    await sync(second);assert.equal(await article(second,a.id).locator('.category-reaction').count(),2);
    assert.equal(await page.locator('#notes img[src=x]').count(),0);
    await filter(page,work);assert.equal(await page.locator('.note').count(),2);assert.equal(await page.locator('#count').textContent(),'2');
    await page.locator('#search-toggle').click();await page.locator('#search').fill('план');await page.waitForTimeout(350);await idle(page);
    assert.equal(await page.locator('.note').count(),2); // Body and filename both match.
    await page.locator('#search').fill('статью');await page.waitForTimeout(350);await idle(page);await page.locator('#no-results').waitFor();
    await context.request.patch(base+'/api/notes/'+b.id+'/categories/'+work.id,{data:{active:true}});await sync(page);
    assert.equal(await page.locator('.note').count(),1);assert.equal(await article(page,b.id).count(),1);
    await page.locator('#search').fill('');await page.waitForTimeout(350);await idle(page);await page.locator('#search-toggle').click();
    // Independent changes from two devices never replace the full set of categories.
    await Promise.all([context.request.patch(base+'/api/notes/'+c.id+'/categories/'+work.id,{data:{active:true}}),other.request.patch(base+'/api/notes/'+c.id+'/categories/'+done.id,{data:{active:true}})]);
    await sync(page);assert.equal(await article(page,c.id).locator('.category-reaction').count(),2);
    await article(page,a.id).locator('[data-action=edit]').click();await page.locator('#message-edit-text').fill('Правка с сохранением категорий');
    await context.request.patch(base+'/api/notes/'+a.id+'/categories/'+done.id,{data:{active:true}});await sync(page);
    assert.equal(await page.locator('#message-edit-text').inputValue(),'Правка с сохранением категорий');assert.equal(await page.locator('.edit-conflict:visible').count(),0);
    await page.locator('.edit-save').click();await idle(page);assert.equal(await article(page,a.id).locator('.category-reaction').count(),3);
    await context.request.delete(base+'/api/notes/'+a.id);await sync(page);await page.locator('#view-trash').click();await idle(page);
    assert.equal(await article(page,a.id).locator('.category-reaction').count(),3);
    await article(page,a.id).locator('[data-action=restore]').click();await article(page,a.id).waitFor({state:'detached'});await idle(page);await page.locator('#view-chat').click();await idle(page);
    assert.equal(await article(page,a.id).locator('.category-reaction').count(),3);
    await filter(page,null);
    // A lost acknowledgement recovers committed state; repeated desired state is idempotent.
    let failed=false;
    await page.route('**/api/notes/'+b.id+'/categories/'+ideas.id,async route=>{if(!failed){failed=true;await route.fetch();await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Попробуй снова'})});}else await route.continue();});
    await mark(page,b.id,ideas);await sync(page);
    await context.request.patch(base+'/api/notes/'+b.id+'/categories/'+ideas.id,{data:{active:true}});await sync(page);
    assert.equal(await article(page,b.id).locator('.category-reaction[data-category-id="'+ideas.id+'"]').count(),1);await page.keyboard.press('Escape');
    // Reload uses server state; categories are not browser-local data.
    await page.reload();await idle(page);assert.equal(await article(page,a.id).locator('.category-reaction').count(),3);
    for(const theme of ['light','dark'])for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:850});await page.evaluate(t=>{document.documentElement.dataset.theme=t;localStorage.setItem('textdrop-theme',t);},theme);
      await filter(page,work);await article(page,a.id).locator('[data-action=categories]').click();
      const bounds=await page.locator('#category-picker').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width+1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:path.join(captures,width+'-'+theme+'-picker.png'),animations:'disabled'});await page.keyboard.press('Escape');
      await page.screenshot({path:path.join(captures,width+'-'+theme+'-reactions.png'),animations:'disabled'});
    }
    await page.locator('#text').fill('Отправлено из фильтра');await page.locator('#send').click();
    await page.waitForFunction(()=>!document.getElementById('send').classList.contains('sending'));await idle(page);
    assert.equal(await page.locator('#category-filter').getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('.note-text').filter({hasText:'Отправлено из фильтра'}).count(),1);
    await sync(page);assert.equal(await page.locator('.note-text').filter({hasText:'Отправлено из фильтра'}).count(),1);
    // Another account uses the same preset names, but owns different memberships.
    await context.request.post(base+'/api/users',{data:{username:'guest',password:'test-password'}});
    await other.clearCookies();await login(second,'guest');assert.equal(await second.locator('.note').count(),0);
    const response=await other.request.patch(base+'/api/notes/'+a.id+'/categories/'+work.id,{data:{active:true},headers:{'X-Textdrop-User':await second.evaluate(()=>currentUser.id)}});assert.equal(response.status(),410);
    const fallbackContext = await browser.newContext({viewport:{width:320,height:700}});
    await fallbackContext.addInitScript(() => {Object.defineProperty(HTMLElement.prototype,'showPopover',{value:undefined,configurable:true});});
    const fallbackPage = await fallbackContext.newPage();fallbackPage.on('pageerror',error=>errors.push(error.message));
    await login(fallbackPage);await filter(fallbackPage,work);
    assert.equal(await fallbackPage.locator('#category-filter').getAttribute('aria-pressed'),'true');
    await fallbackPage.locator('#category-filter').click();await fallbackPage.keyboard.press('Escape');
    assert(await fallbackPage.locator('#category-picker').isHidden());await fallbackContext.close();
    assert.deepEqual(errors,[]);
    console.log('PASS: preset reaction categories, multiple assignments, two-device sync, server filters with body/filename search, independent concurrent marks, editor, trash/restore, failed acknowledgement, reload, account isolation, 320/390/1280px and both themes.');
  }finally{if(browser)await browser.close();if(server)server.kill();fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
