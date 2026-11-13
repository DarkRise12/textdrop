// Synthetic image fixtures against a disposable real server/database.
const {chromium} = require('playwright');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-previews-'));
  const captures = path.join(os.tmpdir(), 'textdrop-previews-ui'); fs.mkdirSync(captures, {recursive: true});
  const seed = spawnSync('python3', ['-c', `import hashlib, io, json, sys
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw
from server import Store
root = Path(sys.argv[1]); store = Store(root / 'notes.sqlite3'); result = []
for i in range(32):
    size = (600,400) if i % 3 else (300,500)
    image = Image.new('RGB', size, '#b9d5ef'); draw = ImageDraw.Draw(image)
    w,h = size; draw.ellipse((w*.67,h*.07,w*.89,h*.29), fill='#f6ca6e')
    draw.polygon([(0,h*.7),(w*.35,h*.27),(w*.69,h*.7)], fill='#733bb8')
    draw.polygon([(w*.3,h*.74),(w*.72,h*.4),(w,h*.76)], fill='#9872bd')
    draw.rectangle((0,h*.74,w,h), fill='#779bb7')
    output = io.BytesIO(); image.save(output, format='PNG'); body = output.getvalue(); image.close()
    original = root / f'fixture-{i}.png'; original.write_bytes(body)
    with patch('server.time.time', return_value=1700000000+i):
        note = store.add_file(io.BytesIO(body), len(body), f'Фото {i+1}.png', 'Тестовая фотография' if i==31 else '', f'preview-fixture-{i:016d}', hashlib.sha256(body).hexdigest())
    result.append(dict(id=note['id'], original=str(original)))
for i, body in enumerate([b'<svg onload="alert(1)"></svg>', b'\\xff\\xd8\\xffbroken image']):
    with patch('server.time.time', return_value=1700000040+i):
        note=store.add_file(io.BytesIO(body), len(body), ['drawing.svg','broken.jpg'][i], '', f'preview-broken-{i:016d}', hashlib.sha256(body).hexdigest())
    result.append(dict(id=note['id'], original=None))
print(json.dumps(result))
`, data], {cwd: root, encoding: 'utf8'});
  assert.equal(seed.status, 0, seed.stderr); const fixtures = JSON.parse(seed.stdout);
  const password = 'preview-test-password-123';
  const server = spawn('python3', ['server.py'], {cwd: root, env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: data, TEXTDROP_PASSWORD: password, TEXTDROP_SECRET: 'preview-test-secret-'.repeat(3), TEXTDROP_SECURE: '0'}, stdio: ['ignore','pipe','pipe']});
  server.stderr.on('data', () => {}); let browser;
  try {
    const port = await new Promise((resolve,reject) => {const timer=setTimeout(()=>reject(Error('Startup timeout')),10000); server.once('exit',()=>reject(Error('Server exited'))); server.stdout.on('data',chunk=>{const match=String(chunk).match(/port (\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});});
    const base = 'http://127.0.0.1:'+port; browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:1280,height:850}}), page = await context.newPage();
    const errors=[], originals=[], previews=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(request.method()==='GET'&&/^\/api\/files\/[a-f0-9]+$/.test(pathname))originals.push(pathname);if(pathname.endsWith('/preview'))previews.push(pathname);});
    const idle = () => page.waitForFunction(()=>!loading&&!searchTimer&&viewLoaded);
    const sync = async()=>{await idle();await page.evaluate(()=>sync());await idle();};
    const login = async()=>{await page.locator('#password').fill(password);await page.locator('#login-form button').click();await idle();};
    await page.goto(base);await login();
    await page.waitForFunction(()=>[...document.querySelectorAll('.image-preview img')].some(image=>image.complete&&image.naturalWidth>0));
    await page.waitForTimeout(700);
    assert(previews.length>0&&previews.length<32,'Lazy loading must not fetch every image in the history');
    assert.equal(originals.length,0,'Opening the chat must not request original images');
    const photo=fixtures[31], item=()=>page.locator(`.note[data-id="${photo.id}"]`);
    await item().locator('.image-preview img').waitFor();
    await page.waitForFunction(id=>{const image=document.querySelector(`.note[data-id="${id}"] .image-preview img`);return image?.complete&&image.naturalWidth>0;},photo.id);
    assert.equal(await item().locator('img').getAttribute('loading'),'lazy');assert.equal(await item().locator('img').getAttribute('decoding'),'async');
    const response=await context.request.get(base+'/api/files/'+photo.id+'/preview');
    assert.equal(response.status(),200);assert((await response.body()).length<=102400);
    const etag=response.headers()['etag'];assert(etag);
    assert.equal((await context.request.get(base+'/api/files/'+photo.id+'/preview',{headers:{'If-None-Match':etag}})).status(),304);
    const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(base+'/api/files/'+photo.id+'/preview',{headers:{'If-None-Match':etag}})).status(),401);await anonymous.close();
    // Broken images leave the original file card usable, with no broken-image icon.
    await page.waitForFunction(id=>!document.querySelector(`.note[data-id="${id}"] .image-preview`),fixtures[33].id);
    assert.equal(await page.locator(`.note[data-id="${fixtures[32].id}"] .image-preview`).count(),0);
    assert.equal(await page.locator(`.note[data-id="${fixtures[33].id}"] .file-download`).count(),1);
    // Viewer uses the cached thumbnail; the original is downloaded only on explicit action.
    await item().getByRole('button',{name:'Открыть фотографию Фото 32.png'}).click();
    await page.locator('#image-viewer').waitFor();await page.waitForFunction(()=>document.getElementById('viewer-image').naturalWidth>0);
    assert.equal(originals.length,0);assert.equal(await page.locator('#image-viewer-title').textContent(),'Фото 32.png');
    await page.screenshot({path:path.join(captures,'viewer-desktop.png')});
    const downloadPromise=page.waitForEvent('download');await page.locator('#download-original').click();const download=await downloadPromise;
    assert.deepEqual(fs.readFileSync(await download.path()),fs.readFileSync(photo.original));assert.equal(download.url(),base+'/api/files/'+photo.id);
    await page.locator('#close-image-viewer').press('Escape');assert(await page.locator('#image-viewer').isHidden());
    assert(await item().locator('.image-preview').evaluate(el=>el===document.activeElement));
    // Polling has no thumbnail traffic when nothing changed.
    const readCount=previews.length;await sync();assert.equal(previews.length,readCount);
    // Responsive review of both themes; aspect ratio reserves space before image decoding.
    for(const [width,height]of [[1280,850],[390,844],[320,640]]){
      await page.setViewportSize({width,height});await page.waitForTimeout(150);await page.evaluate(()=>latest());
      for(const theme of ['light','dark']){await page.evaluate(value=>setTextdropTheme(value),theme);await page.waitForTimeout(180);await page.screenshot({path:path.join(captures,width+'-'+theme+'.png')});}
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const box=await item().locator('.image-preview').boundingBox();assert(box.width<=280&&box.height<=211);
      assert(Math.abs(box.width/box.height-4/3)<.02);
    }
    await item().locator('.image-preview').click();await page.waitForFunction(()=>document.getElementById('viewer-image').naturalWidth>0);
    await page.screenshot({path:path.join(captures,'viewer-mobile.png')});
    // Auth expiry clears both the history and the open viewer, even for cached previews.
    await context.clearCookies();await page.evaluate(()=>sync());await page.locator('#login').waitFor();
    assert(await page.locator('#image-viewer').isHidden());assert.equal(await page.locator('#viewer-image').getAttribute('src'),null);
    assert.equal(await page.locator('.image-preview').count(),0);await login();
    await item().locator('.image-preview').click();
    await context.request.delete(base+'/api/notes/'+photo.id);await sync();assert(await page.locator('#image-viewer').isHidden());
    await context.request.post(base+'/api/trash/'+photo.id+'/restore',{data:{}});await sync();assert.equal(await item().locator('.image-preview').count(),1);
    // A temporary preview failure must not hide messages or prevent original downloads.
    await page.route('**/api/files/*/preview',route=>route.fulfill({status:503,json:{error:'Synthetic outage'}}));
    await page.reload();await idle();await page.waitForTimeout(600);
    assert.equal(await page.locator('.file-download').count(),34);assert(await page.locator('#notice').isHidden());
    await page.unroute('**/api/files/*/preview');await page.reload();await idle();
    await page.waitForFunction(()=>[...document.querySelectorAll('.image-preview img')].some(image=>image.complete&&image.naturalWidth>0));
    assert.deepEqual(errors,[]);
    console.log('PASS: signature detection, lazy thumbnails with no original traffic, small private JPEGs, ETag/auth, corrupt/SVG fallback, native viewer and keyboard focus, original download bytes, idle polling, fixed image space, 1280/390/320 in both themes, auth clearing, remote deletion/restore, preview outage recovery.');
  }finally{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
