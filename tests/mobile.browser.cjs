// Shared compact layout and search behavior with fixture data, never production messages.
const {chromium}=require('playwright');const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'../static'),dir=path.join(os.tmpdir(),'textdrop-mobile-layout');fs.mkdirSync(dir,{recursive:true});
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light'});
  await context.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text;}}}));
  const notes=Array.from({length:35},(_,i)=>({id:String(i),text:'Сообщение '+(i+1)+'. Текст, который нужно передать на другое устройство.',created:Date.now()-i*60000,version:0,updated:null}));
  const trash=[{...notes[0],id:'trash-fixture',deleted:Date.now(),expires:Date.now()+30*86400000}];let failed=false;const feed=require('./feed-fixture.cjs')(()=>notes,()=>trash);
  await context.route('http://textdrop.test/**',route=>{
   const pathname=new URL(route.request().url()).pathname;
   const reply=feed(route.request());if(reply)return route.fulfill(failed&&pathname.startsWith('/api/notes/')?{status:503,json:{error:'Тестовый сбой'}}:reply);
   if(pathname==='/api/session')return route.fulfill({json:{authenticated:true}});
   if(pathname==='/api/notes')return route.fulfill(failed?{status:503,json:{error:'Тестовый сбой'}}:{json:notes});
   if(pathname==='/api/trash')return route.fulfill({json:trash});
   const name=pathname==='/'?'index.html':pathname.slice(1);
   if(!fs.existsSync(path.join(root,name)))return route.fulfill({status:404,body:''});
   return route.fulfill({body:fs.readFileSync(path.join(root,name)),contentType:name.endsWith('html')?'text/html':name.endsWith('css')?'text/css':'text/javascript'});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://textdrop.test/');await page.locator('.note').last().waitFor();
  function visibleCount(){return page.evaluate(()=>{const history=document.getElementById('history').getBoundingClientRect();return [...document.querySelectorAll('.note')].filter(n=>{const r=n.getBoundingClientRect();return r.top>=history.top&&r.bottom<=history.bottom}).length;});}
  for(const [w,h,minCount]of [[1280,850,6],[800,600,3],[390,844,5],[320,640,3]]){
   await page.setViewportSize({width:w,height:h});await page.waitForTimeout(120);await page.evaluate(()=>latest());
   assert((await page.locator('#workspace-toolbar').boundingBox()).height<=52);
   assert((await page.locator('#history').boundingBox()).y<=(w>600?115:112));
   assert(await visibleCount()>=minCount);
   assert(await page.locator('#search').isHidden());assert(await page.locator('#search-toggle').isVisible());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   for(const button of await page.locator('.note').last().locator('.note-actions button').all()){const box=await button.boundingBox();assert(box.width>=40&&box.height>=40);assert(await button.getAttribute('aria-label'));}
   for(const theme of ['light','dark']){await page.evaluate(t=>setTextdropTheme(t),theme);await page.waitForTimeout(180);await page.screenshot({path:path.join(dir,w+'-'+theme+'.png')});}
  }
  // Compact icons retain their actions and accessible labels.
  const last=page.locator('.note').last();await last.getByRole('button',{name:'Копировать',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedText),notes[0].text);assert(await last.getByRole('button',{name:'Скопировано',exact:true}).isVisible());
  await last.getByRole('button',{name:'Изменить',exact:true}).click();await page.getByRole('form',{name:'Редактирование сообщения'}).waitFor();await page.getByRole('button',{name:'Отмена',exact:true}).click();
  await page.getByRole('button',{name:'Открыть поиск',exact:true}).click();assert.equal(await page.locator('#search-toggle').getAttribute('aria-expanded'),'true');assert(await page.locator('#search').evaluate(e=>document.activeElement===e));
  await page.locator('#search').fill('Сообщение 12.');await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);assert.equal(await page.locator('.note').count(),1);
  await page.locator('#search').press('Escape');await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);assert(await page.locator('#search').isHidden());assert.equal(await page.locator('.note').count(),35);assert.equal(await page.locator('#search').inputValue(),'');
  await page.getByRole('button',{name:'Открыть поиск',exact:true}).click();await page.locator('#search').fill('Сообщение 7.');await page.getByRole('button',{name:'Закрыть поиск',exact:true}).click();await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);assert.equal(await page.locator('.note').count(),35);
  // Desktop shares the compact icons and collapsed search. Active queries survive resizing.
  await page.setViewportSize({width:1280,height:850});assert(await page.locator('#search').isHidden());assert(await page.locator('#search-toggle').isVisible());assert(await page.locator('.note').last().locator('.action-icon').first().isVisible());await page.locator('#search-toggle').click();
  await page.locator('#search').fill('Сообщение 9.');await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.getElementById('search-toggle').getAttribute('aria-expanded')==='true');assert(await page.locator('#search').isVisible());await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);assert.equal(await page.locator('.note').count(),1);await page.locator('#search').press('Escape');await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer);
  // Status dot retains the full error and the recovery message for assistive tools.
  failed=true;await page.waitForFunction(()=>!loading);await page.evaluate(()=>sync());assert.equal(await page.locator('#connection').getAttribute('data-state'),'error');assert.equal(await page.locator('#connection').getAttribute('title'),'Сервер недоступен');assert(await page.locator('#notice').isVisible());
  failed=false;await page.evaluate(()=>sync());assert.equal(await page.locator('#connection').getAttribute('data-state'),'ready');assert(await page.locator('#notice').isHidden());
  // A multiline draft stays correctly sized after visiting trash and rotating the device.
  await page.locator('#text').fill('Первая строка\nВторая строка\nТретья строка');await page.locator('#view-trash').click();await page.waitForFunction(()=>!loading);await page.setViewportSize({width:320,height:640});await page.locator('#view-chat').click();await page.waitForFunction(()=>!loading);await page.waitForTimeout(100);
  assert.equal(await page.locator('#text').inputValue(),'Первая строка\nВторая строка\nТретья строка');assert(await page.locator('#text').evaluate(e=>e.scrollHeight<=e.clientHeight+2));
  await page.locator('#text').fill('');await page.setViewportSize({width:390,height:420});await page.waitForFunction(()=>document.getElementById('compose').getBoundingClientRect().bottom<=innerHeight);
  await page.locator('#search-toggle').click();assert(await page.locator('#search').isVisible());assert((await page.locator('#history').boundingBox()).height>0);
  await page.screenshot({path:path.join(dir,'search-short-viewport.png')});assert.deepEqual(errors,[]);
  console.log('PASS: compact desktop/mobile toolbar, more fully visible fixture messages, collapsed/expanded search, Escape/close, shared desktop layout, active filter across resize, accessible icons/copy/edit, status recovery, retained multiline draft, short viewport, both themes.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
