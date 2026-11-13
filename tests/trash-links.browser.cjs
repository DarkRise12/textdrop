// Real temporary server/database and two independent browser sessions.
const {chromium}=require('playwright');const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'textdrop-trash-'));
 const server=spawn('python3',['server.py'],{cwd:root,env:{...process.env,TEXTDROP_HOST:'127.0.0.1',TEXTDROP_PORT:'0',TEXTDROP_DATA:data,TEXTDROP_PASSWORD:'trash-test-password-123',TEXTDROP_SECRET:'test-trash-secret-'.repeat(3),TEXTDROP_SECURE:'0'},stdio:['ignore','pipe','pipe']});let browser;
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),10000);server.once('exit',()=>reject(Error('Server exited')));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  const base='http://127.0.0.1:'+port;browser=await chromium.launch({headless:true});
  const ca=await browser.newContext({viewport:{width:1280,height:850}}),cb=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'});
  const a=await ca.newPage(),b=await cb.newPage();const errors=[];
  for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.locator('#username').fill('admin');await p.locator('#password').fill('trash-test-password-123');await p.locator('#login-form button[type=submit]').click();await p.locator('#workspace').waitFor();await p.waitForFunction(()=>!loading);}
  async function sync(p){await p.waitForFunction(()=>!loading);await p.evaluate(()=>sync());await p.waitForFunction(()=>!loading);}
  async function select(p,name){await p.getByRole('button',{name,exact:true}).click();await p.waitForFunction(()=>!loading);}
  const text='Текст <img src=x onerror=alert(1)>\n(https://example.test/a(b)).\nhttps://example.test/?a=1&b=2\njavascript:alert(1) https://user:pass@example.test/';
  const original=await (await ca.request.post(base+'/api/notes',{data:{text,request_id:'test-request-123456'}})).json();
  const item=p=>p.locator(`.note[data-id="${original.id}"]`);
  await sync(a);await sync(b);
  assert.equal(await item(a).locator('.note-text').textContent(),text);assert.equal(await item(a).locator('.note-text a').count(),2);assert.equal(await item(a).locator('img,script').count(),0);
  for(const link of await item(a).locator('.note-text a').all()){assert.equal(await link.getAttribute('target'),'_blank');assert.equal(await link.getAttribute('rel'),'noopener noreferrer');}
  let referer;await ca.route('https://example.test/**',r=>{referer=r.request().headers()['referer'];return r.fulfill({contentType:'text/html',body:'<title>Test destination</title>'});});
  const popupPromise=a.waitForEvent('popup');await item(a).locator('a').first().click();const popup=await popupPromise;await popup.waitForLoadState();assert(await popup.evaluate(()=>window.opener===null));assert.equal(referer,undefined);await popup.close();
  await a.locator('#text').fill('Черновик не должен потеряться');
  // Cancel first, then confirm moving to trash.
  await item(a).getByRole('button',{name:'Удалить',exact:true}).click();assert((await a.locator('#delete-dialog p').textContent()).includes('30 дней'));await a.locator('dialog').getByRole('button',{name:'Оставить'}).click();assert.equal(await item(a).count(),1);
  await item(a).getByRole('button',{name:'Удалить',exact:true}).click();await a.locator('dialog').getByRole('button',{name:'В корзину',exact:true}).click();await a.waitForFunction(id=>!document.querySelector(`.note[data-id="${id}"]`),original.id);
  await sync(b);assert.equal(await item(b).count(),0);await select(a,'Корзина');await select(b,'Корзина');
  assert.equal(await item(a).locator('.note-text').textContent(),text);assert(await a.locator('#compose').isHidden());assert((await item(a).locator('.trash-expiry').textContent()).includes('Удалится'));assert.equal(await item(a).getByRole('button',{name:'Изменить',exact:true}).count(),0);
  await a.locator('#search-toggle').click();await a.locator('#search').fill('no-match');await a.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);assert(await a.locator('#no-results').isVisible());await a.locator('#search').fill('');await a.locator('#search').press('Escape');await a.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);
  // A failed restore keeps the item and allows a retry.
  await a.route('**/api/trash/*/restore',r=>r.fulfill({status:503,json:{error:'Тест: восстановление временно недоступно.'}}));
  await item(a).getByRole('button',{name:'Восстановить',exact:true}).click();await a.locator('#notice').waitFor();assert.equal(await item(a).count(),1);await a.unroute('**/api/trash/*/restore');
  await item(a).getByRole('button',{name:'Восстановить',exact:true}).click();await a.waitForFunction(id=>!document.querySelector(`.note[data-id="${id}"]`),original.id);
  await sync(b);assert.equal(await item(b).count(),0);await select(a,'Чат');await select(b,'Чат');assert.equal(await item(a).locator('.note-text').textContent(),text);assert.equal(await a.locator('#text').inputValue(),'Черновик не должен потеряться');
  let restored=await (await ca.request.get(base+'/api/notes')).json();assert.equal(restored[0].id,original.id);assert.equal(restored[0].created,original.created);
  // An editor survives a remote delete/restore without silently replacing the local text.
  await item(a).getByRole('button',{name:'Изменить',exact:true}).click();await a.locator('.edit-form textarea').fill('Локальная правка');
  await a.locator('#view-trash').click();assert.equal(await a.locator('#workspace').getAttribute('data-view'),'chat');assert.equal(await a.locator('.edit-form textarea').inputValue(),'Локальная правка');
  await cb.request.delete(base+'/api/notes/'+original.id);await sync(a);assert(await a.locator('.edit-save').isDisabled());
  await cb.request.post(base+'/api/trash/'+original.id+'/restore',{data:{}});await sync(a);assert.equal(await a.locator('.edit-form textarea').inputValue(),'Локальная правка');assert(await a.getByRole('button',{name:'Сохранить мой вариант'}).isEnabled());await a.getByRole('button',{name:'Отмена',exact:true}).click();
  // Prepare populated trash screenshots, then cancel/confirm permanent deletion.
  await cb.request.delete(base+'/api/notes/'+original.id);
  const second=await (await cb.request.post(base+'/api/notes',{data:{text:'Удалённая заметка: https://example.test/docs'}})).json();await cb.request.delete(base+'/api/notes/'+second.id);
  await select(a,'Корзина');await sync(a);
  const captures=path.join(os.tmpdir(),'textdrop-trash-captures');fs.mkdirSync(captures,{recursive:true});
  for(const [device,size] of [['desktop',{width:1280,height:850}],['mobile',{width:390,height:844}],['narrow',{width:320,height:640}]]){await a.setViewportSize(size);for(const theme of ['light','dark']){await a.evaluate(t=>setTextdropTheme(t),theme);await a.waitForTimeout(200);assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await a.locator('#history').evaluate(e=>e.scrollWidth<=e.clientWidth));await a.screenshot({path:path.join(captures,device+'-'+theme+'.png')});}}
  await item(a).getByRole('button',{name:'Удалить навсегда',exact:true}).click();await a.locator('dialog').getByRole('button',{name:'Оставить'}).click();assert.equal(await item(a).count(),1);
  await item(a).getByRole('button',{name:'Удалить навсегда',exact:true}).click();await a.locator('dialog').getByRole('button',{name:'Удалить навсегда',exact:true}).click();await a.waitForFunction(id=>!document.querySelector(`.note[data-id="${id}"]`),original.id);assert.equal((await ca.request.post(base+'/api/trash/'+original.id+'/restore',{data:{}})).status(),410);
  // Expired messages disappear on read and cannot be restored.
  const expire=spawn('python3',['-c',"import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE trash SET expires=0'); db.commit()",path.join(data,'notes.sqlite3')]);await new Promise((resolve,reject)=>expire.once('exit',code=>code===0?resolve():reject(Error('expiry update failed'))));
  await sync(a);assert.equal(await a.locator('.note').count(),0);assert(await a.locator('#empty').isVisible());assert.equal((await ca.request.post(base+'/api/trash/'+second.id+'/restore',{data:{}})).status(),410);
  await select(a,'Чат');assert.equal(await a.locator('#text').inputValue(),'Черновик не должен потеряться');
  assert.deepEqual(errors,[]);console.log('PASS: safe links/literal HTML, noopener/noreferrer, delete/cancel, two-device trash, search, restore failure/retry, retained draft, editor delete/restore conflict, permanent delete, expiry, desktop/mobile/320px in both themes.');
 }finally{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null||server.signalCode!==null?resolve():server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1)});
