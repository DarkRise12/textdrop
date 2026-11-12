// Real HTTP server, temporary SQLite database; never reads production credentials.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'textdrop-reliability-'));
 const password='test-password-only-12345';let browser;
 const launch=(port='0')=>spawn('python3',['server.py'],{cwd:root,env:{...process.env,TEXTDROP_HOST:'127.0.0.1',TEXTDROP_PORT:port,TEXTDROP_DATA:data,TEXTDROP_PASSWORD:password,TEXTDROP_SECRET:'test-secret-only-'.repeat(3),TEXTDROP_SECURE:'0'},stdio:['ignore','pipe','pipe']});
 let server=launch();
 const ready=server=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout')),10000);server.once('exit',()=>reject(Error('Server exited')));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
 try {
  const port=await ready(server);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();const page=await context.newPage();
  await page.goto('http://127.0.0.1:'+port);await page.locator('#password').fill(password);await page.locator('#login-form button').click();await page.locator('#workspace').waitFor();
  await page.locator('#text').fill('Черновик\nс переносом 😀');await page.reload();await page.locator('#workspace').waitFor();assert.equal(await page.locator('#text').inputValue(),'Черновик\nс переносом 😀');
  // Commit on the server, then lose the response received by the browser.
  await page.route('**/api/notes',async route=>{
   if(route.request().method()==='POST'){await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  const lost=await page.evaluate(()=>JSON.parse(localStorage.getItem('textdrop-draft-v1')));
  assert(lost.pending.id);assert.equal(lost.text,'Черновик\nс переносом 😀');
  await page.unroute('**/api/notes');await page.reload();await page.locator('.note').waitFor();
  assert.equal(await page.locator('.note').count(),1);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('textdrop-draft-v1')).pending.id),lost.pending.id);
  await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#text').value==='');
  assert.equal(await page.locator('.note').count(),1);assert.equal(await page.evaluate(()=>localStorage.getItem('textdrop-draft-v1')),null);
  // Same text deliberately sent again must be a distinct message.
  await page.locator('#text').fill(lost.text);await page.locator('#send').click();await page.waitForFunction(()=>document.querySelectorAll('.note').length===2);
  // Failed reads keep the last good history and recover without re-login.
  const existingCount=await page.locator('.note').count();
  await page.locator('#text').fill('Черновик при сбое чтения');
  for(const failure of [
   {status:503,json:{error:'Не удалось загрузить сообщения. Повторите попытку.'}},
   {status:502,contentType:'text/html',body:'<html>Bad gateway</html>'},
   {status:200,json:{broken:true}}
  ]){
   await page.route('**/api/notes',route=>route.request().method()==='GET'?route.fulfill(failure):route.continue());
   await page.evaluate(()=>sync());
   assert.equal(await page.locator('.note').count(),existingCount);
   assert.equal(await page.locator('#text').inputValue(),'Черновик при сбое чтения');
   assert(await page.locator('#notice').isVisible());
   assert(!/SyntaxError|Unexpected token|Bad gateway/.test(await page.locator('#notice').textContent()));
   await page.unroute('**/api/notes');await page.evaluate(()=>sync());
   assert(await page.locator('#notice').isHidden());
   assert.equal(await page.locator('#connection').textContent(),'Синхронизировано');
  }
  await context.setOffline(true);await page.evaluate(()=>sync());
  assert.equal(await page.locator('#connection').textContent(),'Нет соединения');
  await context.setOffline(false);await page.waitForFunction(()=>document.getElementById('connection').textContent==='Синхронизировано');
  // Actual process restart on the same origin: persistent cookie and secret keep login valid.
  server.kill();await new Promise(resolve=>server.once('exit',resolve));
  server=launch(String(port));await ready(server);await page.reload();await page.locator('#workspace').waitFor();
  await page.waitForFunction(expected=>document.querySelectorAll('.note').length===expected,existingCount);
  assert.equal(await page.locator('#text').inputValue(),'Черновик при сбое чтения');
  assert(await page.locator('#login').isHidden());
  // Startup can be retried after a temporary reverse-proxy failure.
  await page.route('**/api/session',route=>route.fulfill({status:502,contentType:'text/html',body:'Gateway unavailable'}));
  await page.reload();await page.locator('#login-retry').waitFor();
  assert(await page.locator('#login-feedback').isVisible());
  await page.unroute('**/api/session');await page.locator('#login-retry').click();await page.locator('#workspace').waitFor();
  assert(await page.locator('#login-feedback').isHidden());
  // Classify timeout separately from authentication and connectivity errors.
  await page.evaluate(async()=>{const original=window.fetch;window.fetch=()=>Promise.reject(new DOMException('timed out','TimeoutError'));try{await sync();}finally{window.fetch=original;}});
  assert.equal(await page.locator('#connection').textContent(),'Сервер не отвечает');
  await page.evaluate(()=>sync());assert(await page.locator('#notice').isHidden());
  // Authentication expiry preserves the draft through re-login.
  await page.locator('#text').fill('Сохранить при истечении сессии');await context.clearCookies();await page.evaluate(()=>sync());await page.locator('#login').waitFor();
  await page.locator('#password').fill(password);await page.locator('#login-form button').click();await page.locator('#workspace').waitFor();assert.equal(await page.locator('#text').inputValue(),'Сохранить при истечении сессии');
  // Don't erase text typed while a previous message is being acknowledged.
  let release,committed;const gate=new Promise(r=>release=r),seen=new Promise(r=>committed=r);
  await page.route('**/api/notes',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();committed();await gate;await route.fulfill({response});}else await route.continue();});
  await page.locator('#send').click();await seen;await page.locator('#text').fill('Следующий черновик');release();
  await page.waitForFunction(()=>!document.querySelector('#send').classList.contains('sending'));
  assert.equal(await page.locator('#text').inputValue(),'Следующий черновик');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('textdrop-draft-v1')).text),'Следующий черновик');
  await page.unroute('**/api/notes');await page.locator('#logout').click();await page.locator('#login').waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('textdrop-draft-v1')),null);
  await page.locator('#password').fill(password);await page.locator('#login-form button').click();await page.locator('#workspace').waitFor();assert.equal(await page.locator('#text').inputValue(),'');
  const blocked=await context.newPage();
  await blocked.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='textdrop-draft-v1')throw new DOMException('Quota exceeded','QuotaExceededError');return original.call(this,key,value);};});
  await blocked.goto('http://127.0.0.1:'+port);await blocked.locator('#workspace').waitFor();
  await blocked.locator('#text').fill('Хранить в памяти при ошибке');
  assert(await blocked.locator('#draft-status').evaluate(e=>e.classList.contains('error')));
  await blocked.route('**/api/notes',route=>route.request().method()==='POST'?route.abort('failed'):route.continue());
  await blocked.locator('#send').click();await blocked.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(await blocked.locator('#text').inputValue(),'Хранить в памяти при ошибке');
  await blocked.close();
  console.log('PASS: draft reload, lost committed response, retry across reload without duplicates, intentional repeat, session expiry, concurrent typing, explicit logout cleanup, unavailable storage, failed reads, HTML gateway error, malformed response, offline recovery, real server restart, startup retry, timeout feedback.');
 } finally {if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
