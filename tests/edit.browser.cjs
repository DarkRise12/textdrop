// Two authenticated devices against a temporary real server and SQLite database.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'textdrop-edit-'));
 const server=spawn('python3',['server.py'],{cwd:root,env:{...process.env,TEXTDROP_HOST:'127.0.0.1',TEXTDROP_PORT:'0',TEXTDROP_DATA:data,TEXTDROP_PASSWORD:'test-edit-password-12345',TEXTDROP_SECRET:'test-edit-secret-'.repeat(3),TEXTDROP_SECURE:'0'},stdio:['ignore','pipe','pipe']});
 let browser;
 try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Startup timeout')),10000);server.once('exit',()=>reject(Error('Server exited')));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  const base='http://127.0.0.1:'+port;
  browser=await chromium.launch({headless:true});
  const ca=await browser.newContext({viewport:{width:1280,height:850},colorScheme:'light'}),cb=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'});
  const a=await ca.newPage(),b=await cb.newPage();
  const errors=[];for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
  async function login(page){await page.locator('#password').fill('test-edit-password-12345');await page.locator('#login-form button').click();await page.locator('#workspace').waitFor();await page.waitForFunction(()=>!loading);}
  for(const page of [a,b]){await page.goto(base);await login(page);}
  const first=await (await ca.request.post(base+'/api/notes',{data:{text:'Первое сообщение\nВторая строка'}})).json();
  await ca.request.post(base+'/api/notes',{data:{text:'Более новое сообщение'}});
  async function sync(page){await page.waitForFunction(()=>!loading);await page.evaluate(()=>sync());}
  await sync(a);await sync(b);
  const note=page=>page.locator(`.note[data-id="${first.id}"]`);
  const form=page=>page.getByRole('form',{name:'Редактирование сообщения'});
  async function open(page){await note(page).getByRole('button',{name:'Изменить',exact:true}).click();await form(page).waitFor();}
  const read=async()=>{const rows=await (await ca.request.get(base+'/api/notes')).json();return rows.find(n=>n.id===first.id);};
  await a.locator('#text').fill('Отдельный черновик нового сообщения');
  await open(a);await form(a).getByRole('textbox').fill('Правка <script>alert(1)</script> 😀');await form(a).getByRole('textbox').press('Control+Enter');await form(a).waitFor({state:'hidden'});
  let saved=await read();assert.equal(saved.created,first.created);assert.equal(saved.version,1);assert.equal(saved.text,'Правка <script>alert(1)</script> 😀');
  assert.equal(await a.locator('#text').inputValue(),'Отдельный черновик нового сообщения');
  assert.equal(await a.locator('.note').first().getAttribute('data-id'),first.id);
  await sync(b);assert.equal(await note(b).locator('.edited-mark').textContent(),' · изменено');
  await open(b);await form(b).getByRole('textbox').fill('Отменить это');await form(b).getByRole('textbox').press('Escape');assert.equal((await read()).text,saved.text);
  // Background polling must not replace the editing field or its selection.
  await open(a);await form(a).getByRole('textbox').fill('Мой вариант');await form(a).getByRole('textbox').evaluate(e=>e.setSelectionRange(3,3));
  await cb.request.post(base+'/api/notes',{data:{text:'Новое сообщение с другого устройства'}});await sync(a);
  assert.equal(await form(a).getByRole('textbox').inputValue(),'Мой вариант');assert.equal(await form(a).getByRole('textbox').evaluate(e=>e.selectionStart),3);
  assert.equal(await a.evaluate(()=>document.activeElement.id),'message-edit-text');
  await open(b);await form(b).getByRole('textbox').fill('Изменено на телефоне');await form(b).getByRole('button',{name:'Сохранить',exact:true}).click();await form(b).waitFor({state:'hidden'});
  await sync(a);assert.equal(await form(a).getByRole('textbox').inputValue(),'Мой вариант');assert.equal(await form(a).locator('.edit-remote-text').textContent(),'Изменено на телефоне');
  await form(a).getByRole('button',{name:'Принять эту версию'}).click();await form(a).waitFor({state:'hidden'});assert.equal(await note(a).locator('.note-text').textContent(),'Изменено на телефоне');
  // Force a genuinely stale save (not just a conflict already found by polling).
  await open(a);await form(a).getByRole('textbox').fill('Мой окончательный вариант');
  const stale=await (await ca.request.get(base+'/api/notes')).json();
  await a.route('**/api/notes',route=>route.request().method()==='GET'?route.fulfill({json:stale}):route.continue());
  await sync(b);await open(b);await form(b).getByRole('textbox').fill('Телефон: версия 3');await form(b).getByRole('button',{name:'Сохранить',exact:true}).click();await form(b).waitFor({state:'hidden'});
  await form(a).getByRole('button',{name:'Сохранить',exact:true}).click();await form(a).getByRole('button',{name:'Сохранить мой вариант'}).waitFor();
  assert.equal(await form(a).getByRole('textbox').inputValue(),'Мой окончательный вариант');assert.equal((await read()).text,'Телефон: версия 3');
  // A second race must still conflict even after explicit overwrite was chosen.
  await open(b);await form(b).getByRole('textbox').fill('Телефон: версия 4');await form(b).getByRole('button',{name:'Сохранить',exact:true}).click();await form(b).waitFor({state:'hidden'});
  await form(a).getByRole('button',{name:'Сохранить мой вариант'}).click();await a.waitForFunction(()=>document.querySelector('.edit-remote-text').textContent==='Телефон: версия 4');
  assert.equal((await read()).text,'Телефон: версия 4');await a.unroute('**/api/notes');
  await form(a).getByRole('button',{name:'Сохранить мой вариант'}).click();await form(a).waitFor({state:'hidden'});assert.equal((await read()).text,'Мой окончательный вариант');
  // Lose an acknowledgement after commit; a retry must not create another revision.
  await open(a);await form(a).getByRole('textbox').fill('Повтор после потери ответа');
  await a.route('**/api/notes/*',async route=>{if(route.request().method()==='PATCH'){await route.fetch();await route.abort('failed');}else await route.continue();});
  await form(a).getByRole('button',{name:'Сохранить',exact:true}).click();await a.waitForFunction(()=>document.querySelector('.edit-save')&&!document.querySelector('.edit-save').disabled);
  const committed=await read();await a.unroute('**/api/notes/*');await sync(a);
  assert.equal(await form(a).getByRole('textbox').inputValue(),'Повтор после потери ответа');await form(a).locator('.edit-save').click();await form(a).waitFor({state:'hidden'});
  assert.equal((await read()).version,committed.version);
  // Session expiry hides but does not discard in-memory editing.
  await open(a);await form(a).getByRole('textbox').fill('Правки до повторного входа');await ca.clearCookies();await a.evaluate(()=>document.querySelector('.edit-form')?.requestSubmit());await a.locator('#login').waitFor();await login(a);await a.waitForFunction(()=>!loading);assert(!/Войдите|Войди/.test(await form(a).locator('.edit-feedback').textContent()));
  assert.equal(await form(a).getByRole('textbox').inputValue(),'Правки до повторного входа');
  // Capture editor and conflict in both device classes and themes, using test data only.
  await sync(b);await open(b);await form(b).getByRole('textbox').fill('Правки с телефона');
  await form(b).getByRole('button',{name:'Сохранить',exact:true}).click();await form(b).waitFor({state:'hidden'});await sync(a);
  const captures=path.join(os.tmpdir(),'textdrop-edit-captures');fs.mkdirSync(captures,{recursive:true});
  for(const [device,size] of [['desktop',{width:1280,height:850}],['mobile',{width:390,height:844}],['narrow',{width:320,height:640}]]){
   await a.setViewportSize(size);
   for(const theme of ['light','dark']){
    await a.evaluate(t=>setTextdropTheme(t),theme);await a.waitForTimeout(200);await form(a).scrollIntoViewIfNeeded();
    assert(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert((await a.locator('.brand').boundingBox()).height < 40);
    assert(await a.locator('#history').evaluate(e=>e.scrollWidth<=e.clientWidth));
    await a.screenshot({path:path.join(captures,device+'-'+theme+'.png')});
   }
  }
  // Deletion while editing keeps a recoverable local text instead of resurrecting a message.
  await cb.request.delete(base+'/api/notes/'+first.id);await sync(a);
  assert.equal(await form(a).getByRole('textbox').inputValue(),'Правки до повторного входа');assert(await form(a).locator('.edit-save').isDisabled());
  assert((await form(a).locator('.edit-feedback').textContent()).includes('удалено'));
  await form(a).getByRole('button',{name:'Отмена',exact:true}).click();assert.equal(await note(a).count(),0);
  assert.equal(await a.locator('#text').inputValue(),'Отдельный черновик нового сообщения');assert.deepEqual(errors,[]);
  console.log('PASS: edit, cancel, literal text, independent compose draft, stable chronology, two-device conflicts, explicit resolution, second race, polling caret, lost edit acknowledgement, authentication expiry, deletion, desktop/mobile/320px in both themes.');
 }finally{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null||server.signalCode!==null?resolve():server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1)});
