const {chromium}=require('playwright');
const fs=require('fs');
const assert=require('assert/strict');
const path=require('path');
const os=require('os');
const root=path.resolve(__dirname,'../static');
const captures=path.join(os.tmpdir(),'textdrop-chat-captures');
fs.mkdirSync(captures,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true});
 const errors=[];
 const context=await browser.newContext({viewport:{width:1280,height:850},colorScheme:'light'});
 let data=Array.from({length:45},(_,i)=>({id:String(i),text:`Сообщение ${i+1}\nТекст для проверки истории на разных устройствах.`,created:1794470400000+i*60000})).reverse();
 const feed=require('./feed-fixture.cjs')(()=>data);
 let failSend=false;
 const policy="default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
 async function mock(route){
  const req=route.request(),path=new URL(req.url()).pathname;
  const reply=feed(req);if(reply)return route.fulfill(reply);
  let result;
  if(path==='/api/session') result={authenticated:true,user:{id:'owner',username:'admin',role:'admin'}};
  else if(path==='/api/notes'&&req.method()==='GET') result=data;
  else if(path==='/api/notes'&&req.method()==='POST'){
   if(failSend)return route.fulfill({status:503,json:{error:'Тест: сервер временно недоступен.'}});
   result={id:'sent-'+Date.now(),text:req.postDataJSON().text,created:Date.now()}; data=[result,...data];
  } else if(path.startsWith('/api/notes/')&&req.method()==='DELETE'){data=data.filter(n=>n.id!==path.split('/').pop());result={ok:true};}
  else if(path==='/api/logout') result={ok:true};
  else {
   const file=path==='/'?'index.html':path.slice(1);
   const mime=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
   return route.fulfill({body:fs.readFileSync(root+'/'+file),contentType:mime,headers:{'Content-Security-Policy':policy}});
  }
  return route.fulfill({json:result});
 }
 await context.route('http://textdrop.test/**',mock);
 const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503'))errors.push(m.text());});
 await page.goto('http://textdrop.test/');await page.locator('.note').last().waitFor();
 assert.equal(await page.locator('.note-text').first().textContent(), 'Сообщение 1\nТекст для проверки истории на разных устройствах.');
 assert(await page.locator('#history').evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight<2));
 await page.locator('#history').evaluate(e=>e.scrollTop=0);
 const before=await page.locator('#history').evaluate(e=>e.scrollTop);
 data.unshift({id:'remote',text:'С другого устройства',created:Date.now()});
 await page.evaluate(()=>sync());
 assert(Math.abs(await page.locator('#history').evaluate(e=>e.scrollTop)-before)<2);
 assert(await page.locator('#latest').isVisible()); await page.locator('#latest').click();
 assert(await page.locator('#history').evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight<2));
 await page.locator('#search-toggle').click();await page.locator('#search').fill('Сообщение 12');await page.waitForFunction(()=>viewLoaded&&!loading&&!searchTimer); assert.equal(await page.locator('.note').count(),1);
 await page.locator('#text').fill('Новый текст <script>alert(1)</script>'); await page.locator('#text').press('Control+Enter');
 await page.waitForFunction(()=>document.querySelector('#text').value==='');
 assert.equal(await page.locator('.note-text').last().textContent(),'Новый текст <script>alert(1)</script>');
 assert.equal(await page.locator('#search').inputValue(),'');
 failSend=true;await page.locator('#text').fill('Не потерять при ошибке');await page.locator('#send').click();
 await page.locator('#notice').waitFor();assert.equal(await page.locator('#text').inputValue(),'Не потерять при ошибке');failSend=false;
 await page.locator('#text').fill('');await page.locator('.note').last().getByRole('button',{name:'Удалить',exact:true}).click();
 await page.getByRole('button',{name:'Оставить',exact:true}).click();assert(await page.locator('.note-text').last().textContent().then(x=>x.includes('<script>')));
 await page.locator('.note').last().getByRole('button',{name:'Удалить',exact:true}).click();await page.locator('dialog').getByRole('button',{name:'В корзину',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.note:last-child').textContent.includes('<script>'));
 await page.locator('#theme-toggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 await page.reload();await page.locator('.note').last().waitFor();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 // Compact real-looking fixture for screenshot review, isolated from production.
 data=[{id:'c',text:'Готово, продолжу с ноутбука.',created:Date.now()},{id:'b',text:'ssh user@example.com -p 22222',created:Date.now()-60000},{id:'a',text:'Идея: всё, что нужно передать себе, теперь в одном чате.\n\nСсылки, заметки и фрагменты кода — на любом устройстве.',created:Date.now()-120000}];
 await page.evaluate(()=>sync());await page.evaluate(()=>notice(''));
 for(const [device,size] of [['desktop',{width:1280,height:850}],['mobile',{width:390,height:844}]]){
  await page.setViewportSize(size);
  for(const theme of ['light','dark']){
   await page.evaluate(t=>{setTextdropTheme(t);themeLabel();latest();},theme);
   await page.waitForTimeout(200);
   await page.screenshot({path:`${captures}/${device}-${theme}.png`});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const box=await page.locator('#compose').boundingBox();assert(box.y+box.height<=size.height);
   const inputBox=await page.locator('#text').boundingBox();assert(inputBox.width>200);
  }
 }
 await page.locator('#text').fill('строка\n'.repeat(80));
 assert(await page.locator('#text').evaluate(e=>e.clientHeight<=180));
 assert(await page.locator('#history').evaluate(e=>e.clientHeight>100));
 await page.locator('#text').fill('');await page.setViewportSize({width:390,height:420});
 await page.waitForFunction(()=>document.getElementById('compose').getBoundingClientRect().bottom<=innerHeight);
 // Unauthenticated screen and theme under the same CSP.
 await page.route('http://textdrop.test/api/session',r=>r.fulfill({json:{authenticated:false}}));
 await page.reload();await page.locator('#login').waitFor();assert(await page.locator('#theme-toggle').isVisible());
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('PASS: chronological messages, scroll anchoring, new-message navigation, search, send, XSS text, error draft, delete/cancel, theme persistence, desktop/mobile layouts, growing input, short viewport, login, CSP.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
