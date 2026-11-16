// Real service workers in a disposable copy: offline privacy and safe updates.
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-pwa-'));
  const code = path.join(temp, 'code'), data = path.join(temp, 'data'); fs.mkdirSync(code); fs.mkdirSync(data);
  const root = path.resolve(__dirname, '..');
  for (const name of ['server.py', 'accounts.py', 'preview.py']) fs.copyFileSync(path.join(root, name), path.join(code, name));
  fs.cpSync(path.join(root, 'static'), path.join(code, 'static'), {recursive: true});
  const captures = path.join(os.tmpdir(), 'textdrop-pwa-review'); fs.mkdirSync(captures, {recursive: true});
  let server, browser, logs = '';
  async function launch(port = '0') {
    server = spawn('python3', ['server.py'], {cwd: code, env: {...process.env, TEXTDROP_HOST:'127.0.0.1', TEXTDROP_PORT:port, TEXTDROP_DATA:data,
      TEXTDROP_PASSWORD:'test-password', TEXTDROP_SECRET:'pwa-test-secret-'.repeat(3)}, stdio:['ignore','pipe','pipe']});
    server.stderr.on('data', chunk => logs += chunk);
    return await new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('Startup timeout: '+logs)),10000);server.once('exit',()=>reject(Error(logs)));server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
  }
  async function restart(port) {const previous = server;previous.kill();await new Promise(resolve=>previous.once('exit',resolve));await launch(port);}
  try {
    const port = await launch(), base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:390,height:844}}), page = await context.newPage(), errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    const idle = () => page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer).catch(async error=>{console.log(await page.evaluate(()=>({generation,startupAttempt,online:navigator.onLine,profile:currentUser,offline:!document.getElementById('offline-start').hidden,login:!document.getElementById('login').hidden,notice:document.getElementById('notice').textContent})));console.log(errors);throw error;});
    const login = async (username='admin') => {await page.locator('#username').fill(username);await page.locator('#password').fill('test-password');await page.locator('#login-form button[type=submit]').click();await idle();};
    const shot = async name => page.screenshot({path:path.join(captures,name+'.png'),animations:'disabled'});
    await page.goto(base); await page.locator('#login').waitFor();
    await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
    const cdp = await context.newCDPSession(page);const manifest = await cdp.send('Page.getAppManifest');
    assert.deepEqual(manifest.errors, []);assert.equal(JSON.parse(manifest.data).display,'standalone');
    const installability = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installability.installabilityErrors, []);
    await page.locator('[data-pwa-install]:visible').click();await page.locator('#install-dialog').waitFor();
    assert((await page.locator('#install-dialog').textContent()).includes('На iPhone и iPad'));
    await shot('390-install-help');await page.locator('#close-install').click();
    // The OS prompt is browser-owned; test its available/accepted event contract.
    await page.evaluate(()=>{window.installCalls=0;const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>window.installCalls++;event.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(event);});
    await page.locator('[data-pwa-install]:visible').click();assert.equal(await page.evaluate(()=>window.installCalls),1);
    await page.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));assert.equal(await page.locator('[data-pwa-install]:visible').count(),0);
    await login();
    await context.request.post(base+'/api/notes',{data:{text:'PRIVATE-HISTORY-MARKER'}});
    await context.request.post(base+'/api/users',{data:{username:'alex',password:'test-password'}});
    const file = fs.readFileSync(path.join(code,'static/icon-192.png'));
    const metadata = Buffer.from(JSON.stringify({name:'private-image.png',text:'PRIVATE-FILE-CAPTION',request_id:'pwa-file-test-request'}));
    const uploaded = await context.request.post(base+'/api/files',{data:Buffer.concat([metadata,file]),headers:{'Content-Type':'application/octet-stream','X-Textdrop-Metadata-Length':String(metadata.length)}});
    assert.equal(uploaded.status(),201);const photo=await uploaded.json();
    assert.equal(await page.evaluate(async id=>(await fetch('/api/files/'+id)).status,photo.id),200);
    assert.equal(await page.evaluate(async id=>(await fetch('/api/files/'+id+'/preview')).status,photo.id),200);
    await page.evaluate(()=>sync());await idle();await page.locator('#text').fill('PRIVATE-OWNER-DRAFT');
    const audit = await page.evaluate(async()=>{const keys=await caches.keys(), result=[];for(const key of keys){const cache=await caches.open(key);for(const request of await cache.keys()){const response=await cache.match(request);result.push({cache:key,url:new URL(request.url).pathname,bytes:(await response.clone().arrayBuffer()).byteLength,private:(await response.text()).includes('PRIVATE-')});}}return result;});
    assert(audit.length>10);assert(audit.every(item=>!item.url.startsWith('/api/')&&!item.private));assert(audit.reduce((sum,item)=>sum+item.bytes,0)<512*1024);
    const originalCache = audit[0].cache;
    await context.setOffline(true);await page.evaluate(()=>sync());
    assert.equal(await page.locator('#text').inputValue(),'PRIVATE-OWNER-DRAFT');
    assert.equal(await page.evaluate(async id=>fetch('/api/files/'+id+'/preview').then(response=>response.status).catch(()=>0),photo.id),0);
    await page.reload();await page.locator('#offline-start').waitFor();
    assert(await page.locator('#login').isHidden());assert(await page.locator('#workspace').isHidden());
    assert.equal(await page.locator('#text').inputValue(),'');assert.equal(await page.locator('#notes').textContent(),'');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('textdrop-draft-v1')).text),'PRIVATE-OWNER-DRAFT');
    await page.locator('.brand-icon').evaluate(image=>image.decode());await shot('390-offline-light');
    await page.locator('#theme-toggle').click();await shot('390-offline-dark');
    await page.locator('#offline-retry').click();assert(await page.locator('#offline-start').isVisible());
    await context.setOffline(false);await idle();assert.equal(await page.locator('#text').inputValue(),'PRIVATE-OWNER-DRAFT');
    // Offline launch never trusts a remembered user or restores a private draft.
    await context.setOffline(true);await context.clearCookies();await page.reload();await page.locator('#offline-start').waitFor();
    await context.setOffline(false);await page.locator('#login').waitFor();assert.equal(await page.locator('#text').inputValue(),'');
    await login('alex');assert.equal(await page.locator('#text').inputValue(),'');assert.equal(await page.locator('.note').count(),0);
    await page.locator('#account-button').click();await page.locator('#logout').click();await page.locator('#login').waitFor();await login();
    assert.equal(await page.locator('#text').inputValue(),'PRIVATE-OWNER-DRAFT');
    const style = path.join(code,'static/style.css');fs.appendFileSync(style,'\n/* PWA update test */\n');await restart(port);
    await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();});
    await page.locator('#pwa-update').waitFor();
    await page.locator('#file-input').setInputFiles({name:'unsent.txt',mimeType:'text/plain',buffer:Buffer.from('Unsent file')});await page.locator('#attachment-selection').waitFor();
    await page.locator('#pwa-update-button').click();
    assert((await page.locator('#pwa-update-message').textContent()).includes('Заверши'));
    assert.equal(await page.evaluate(()=>selectedFiles.length),1);assert.equal(await page.locator('#text').inputValue(),'PRIVATE-OWNER-DRAFT');
    await page.setViewportSize({width:320,height:640});await shot('320-update-blocked');
    await page.locator('#remove-attachment').click();
    await page.locator('.note').filter({hasText:'PRIVATE-HISTORY-MARKER'}).getByRole('button',{name:'Изменить',exact:true}).click();
    await page.locator('[data-action=edit-text]').fill('UNSAVED-EDITOR-TEXT');
    await page.locator('#pwa-update-button').click();
    assert.equal(await page.locator('[data-action=edit-text]').inputValue(),'UNSAVED-EDITOR-TEXT');
    await page.getByRole('button',{name:'Отмена',exact:true}).click();
    await page.evaluate(()=>caches.open('another-application'));
    await page.locator('#pwa-update-button').click();await page.waitForFunction(()=>document.getElementById('pwa-update').hidden&&viewLoaded&&!loading);
    assert.equal(await page.locator('#text').inputValue(),'PRIVATE-OWNER-DRAFT');
    const cachesAfter = await page.evaluate(()=>caches.keys());assert(!cachesAfter.includes(originalCache));assert(cachesAfter.includes('another-application'));assert.equal(cachesAfter.filter(key=>key.startsWith('textdrop-shell-')).length,1);
    // A failed/mixed deploy cannot replace the last complete offline shell.
    const goodCache=cachesAfter.find(key=>key.startsWith('textdrop-shell-'));
    fs.appendFileSync(style,'\n/* expected version */\n');await restart(port);fs.appendFileSync(style,'\n/* mismatch after version stamp */\n');
    const state=await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();return await new Promise((resolve,reject)=>{registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker.addEventListener('statechange',()=>{if(worker.state==='redundant')resolve(worker.state);});},{once:true});registration.update().catch(reject);});});
    assert.equal(state,'redundant');assert((await page.evaluate(()=>caches.keys())).includes(goodCache));
    await context.setOffline(true);await page.reload();await page.locator('#offline-start').waitFor();
    assert.equal(await page.locator('#text').inputValue(),'');
    const installed = await browser.newContext();await installed.addInitScript(()=>Object.defineProperty(navigator,'standalone',{value:true}));const app=await installed.newPage();await app.goto(base);await app.locator('#login').waitFor();assert.equal(await app.locator('[data-pwa-install]:visible').count(),0);await installed.close();
    assert.deepEqual(errors,[]);
    console.log('PASS: installable manifest, real public-only service worker and private preview exclusion, offline launch without trusting auth/drafts, online account isolation, guarded coherent updates and draft recovery, failed integrity update preserves the last cache, standalone controls.');
  } finally {if(browser)await browser.close();if(server){server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));}fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
