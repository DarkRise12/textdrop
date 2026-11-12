// Real HTTP server, temporary SQLite database; never reads production credentials.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'textdrop-reliability-'));
 const password='test-password-only-12345';let browser;
 const server=spawn('python3',['server.py'],{cwd:root,env:{...process.env,TEXTDROP_HOST:'127.0.0.1',TEXTDROP_PORT:'0',TEXTDROP_DATA:data,TEXTDROP_PASSWORD:password,TEXTDROP_SECRET:'test-secret-only-'.repeat(3),TEXTDROP_SECURE:'0'},stdio:['ignore','pipe','pipe']});
 try {
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout')),10000);server.once('exit',()=>reject(Error('Server exited')));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
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
  console.log('PASS: draft reload, lost committed response, retry across reload without duplicates, intentional repeat, session expiry, concurrent typing, explicit logout cleanup, unavailable storage.');
 } finally {if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
