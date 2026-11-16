// One message with ten files; atomic retries, thumbnails, trash and two devices.
const {chromium} = require('playwright');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-multi-data-'));
  const captures = path.join(os.tmpdir(), 'textdrop-multi-review'); fs.mkdirSync(captures, {recursive: true});
  const server = spawn('python3', ['server.py'], {cwd: root, env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: data,
    TEXTDROP_PASSWORD: 'test-password', TEXTDROP_SECRET: 'multi-file-secret-'.repeat(3), TEXTDROP_FILE_LIMIT: String(2 * 1024 * 1024)}, stdio: ['ignore', 'pipe', 'pipe']});
  let logs = '', browser; server.stderr.on('data', chunk => logs += chunk);
  try {
    const port = await new Promise((resolve, reject) => {const timer = setTimeout(() => reject(Error(logs)), 10000); server.once('exit', () => reject(Error(logs))); server.stdout.on('data', chunk => {const match = String(chunk).match(/port (\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});});
    const base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 390, height: 844}}), page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const idle = () => page.waitForFunction(() => viewLoaded && !loading && !searchTimer);
    await page.goto(base); await page.locator('#username').fill('admin'); await page.locator('#password').fill('test-password');
    await page.locator('#login-form button[type=submit]').click(); await idle();
    assert(await page.locator('#file-input').evaluate(el => el.multiple));
    const png = spawnSync('python3', ['-c', "from PIL import Image\nimport sys\nImage.new('RGB',(40,30),'#733bb8').save(sys.stdout.buffer,format='PNG')"], {encoding: null});
    assert.equal(png.status, 0, String(png.stderr));
    const files = Array.from({length: 10}, (_, index) => ({name: index < 6 ? 'Фото ' + (index + 1) + '.png' : index < 8 ? 'same.txt' : index === 8 ? '<literal>.bin' : 'Последний документ.txt',
      mimeType: index < 6 ? 'image/png' : 'application/octet-stream', buffer: index < 6 ? png.stdout : Buffer.from('file-' + index)}));
    const choose = async (items, count) => {await page.locator('#file-input').setInputFiles(items); await page.waitForFunction(count => !choosingFiles && selectedFiles.length === count, count);};
    await choose(files.slice(0, 2), 2); await choose(files.slice(2, 3), 3);
    await page.locator('.selected-file').nth(1).getByRole('button').click(); await page.waitForFunction(() => selectedFiles.length === 2);
    await page.locator('#file-input').setInputFiles(files.slice(0, 9)); await page.waitForFunction(() => !choosingFiles);
    assert.equal(await page.evaluate(() => selectedFiles.length), 2);
    assert((await page.locator('#notice').textContent()).includes('10 файлов'));
    await page.locator('#remove-attachment').click();
    await page.locator('#file-input').setInputFiles([{name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(2 * 1024 * 1024 + 1)}]);
    await page.waitForFunction(() => !choosingFiles); assert.equal(await page.evaluate(() => selectedFiles.length), 0);
    await choose(files, 10); await page.locator('#text').fill('Общая подпись <literal>');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width, height: width === 1280 ? 800 : width === 390 ? 844 : 640});
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')) - innerHeight) < 1);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => window.setTextdropTheme(value), theme);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.locator('.selected-file').count(), 10);
        assert(await page.locator('#compose').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight));
        await page.screenshot({path: path.join(captures, width + '-' + theme + '-selected.png'), animations: 'disabled'});
      }
    }
    // The server committed all bytes, but the first response is lost.
    await page.route('**/api/files', async route => {await route.fetch(); await route.abort('failed');});
    await page.locator('#send').click(); await page.waitForFunction(() => !uploadRequest && !document.getElementById('send').classList.contains('sending'));
    const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('textdrop-draft-v1')).filePending);
    assert.equal(pending.files.length, 10);
    assert.equal((await (await context.request.get(base + '/api/notes/page')).json()).total, 1);
    await page.unroute('**/api/files'); await page.reload(); await idle();
    assert((await page.locator('#draft-status').textContent()).includes('10'));
    // Different picker order, in two batches, must retain the original retry key.
    const reversed = [...files].reverse(); await choose(reversed.slice(0, 4), 4);
    assert.equal(await page.evaluate(() => pendingFileSend.id), pending.id);
    await choose(reversed.slice(4), 10); await page.locator('#send').click();
    await page.waitForFunction(() => !uploadRequest && !selectedFiles.length); await idle();
    const feed = await (await context.request.get(base + '/api/notes/page')).json();
    assert.equal(feed.total, 1); const note = feed.items[0]; assert.equal(note.files.length, 10);
    assert.equal(await page.locator('.file-download').count(), 10);
    for (const [index, file] of note.files.entries()) {
      const response = await context.request.get(base + '/api/files/' + file.id);
      assert.equal(response.status(), 200); assert.deepEqual(await response.body(), files[index].buffer);
    }
    await page.locator('.image-preview').nth(1).click();
    assert((await page.locator('#viewer-image').getAttribute('src')).includes(note.files[1].id));
    assert((await page.locator('#download-original').getAttribute('href')).endsWith(note.files[1].id));
    await page.locator('#close-image-viewer').click();
    const second = await context.newPage(); await second.goto(base); await second.waitForFunction(() => viewLoaded && !loading);
    assert.equal(await second.locator('.note').count(), 1); assert.equal(await second.locator('.file-download').count(), 10);
    await second.close();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width, height: width === 1280 ? 800 : width === 390 ? 844 : 640});
      await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')) - innerHeight) < 1);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => window.setTextdropTheme(value), theme);
        await page.locator('#history').evaluate(el => el.scrollTop = 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.waitForTimeout(180);
        await page.screenshot({path: path.join(captures, width + '-' + theme + '-message.png'), animations: 'disabled'});
      }
    }
    await page.locator('#search-toggle').click(); await page.locator('#search').fill('ПОСЛЕДНИЙ'); await idle();
    assert.equal(await page.locator('.note').count(), 1); assert.equal(await page.locator('.file-download mark').textContent(), 'Последний');
    await page.locator('#search').press('Escape'); await idle();
    await page.locator('.note').getByRole('button', {name: 'Изменить', exact: true}).click();
    await page.locator('[data-action=edit-text]').fill(''); await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await page.waitForFunction(() => !editor && !loading); assert.equal(await page.locator('.file-download').count(), 10);
    await page.locator('.note').getByRole('button', {name: 'Удалить', exact: true}).click();
    await page.locator('#delete-dialog button[value=delete]').click(); await idle();
    await page.locator('#view-trash').click(); await idle(); assert.equal(await page.locator('.file-download').count(), 10);
    await page.locator('.note').getByRole('button', {name: 'Восстановить', exact: true}).click(); await idle();
    await page.locator('#view-chat').click(); await idle(); assert.equal(await page.locator('.file-download').count(), 10);
    await page.locator('.note').getByRole('button', {name: 'Удалить', exact: true}).click();
    await page.locator('#delete-dialog button[value=delete]').click(); await idle(); await page.locator('#view-trash').click(); await idle();
    await page.locator('.note').getByRole('button', {name: 'Удалить навсегда', exact: true}).click();
    await page.locator('#delete-dialog button[value=delete]').click(); await idle();
    await page.waitForFunction(() => !loading && notes.length === 0);
    assert.equal((await (await context.request.get(base + '/api/storage')).json()).used_bytes, 0);
    for (const file of note.files) assert.equal((await context.request.get(base + '/api/files/' + file.id)).status(), 404);
    assert.deepEqual(errors, []);
    console.log('PASS: ten files in one message, add/remove and limits, atomic lost-response retry after reload/reordered batch selection, downloads/two devices, per-file previews, search/caption, trash/restore/purge, 320/390/1280px and both themes.');
  } finally {if (browser) await browser.close();server.kill();await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));fs.rmSync(data,{recursive:true,force:true});}
})().catch(error => {console.error(error);process.exitCode = 1;});
