// Two devices, disposable server/database, synthetic binary data only.
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-files-'));
  const captures = path.join(os.tmpdir(), 'textdrop-files-ui'); fs.mkdirSync(captures, {recursive: true});
  const password = 'file-test-password-12345';
  const server = spawn('python3', ['server.py'], {cwd: root, env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: data, TEXTDROP_PASSWORD: password, TEXTDROP_SECRET: 'file-test-secret-'.repeat(3), TEXTDROP_SECURE: '0', TEXTDROP_FILE_LIMIT: '131072', TEXTDROP_STORAGE_LIMIT: '262144'}, stdio: ['ignore', 'pipe', 'pipe']});
  server.stderr.on('data', () => {}); let browser;
  try {
    const port = await new Promise((resolve, reject) => {const timer = setTimeout(() => reject(Error('Startup timeout')), 10000); server.once('exit', () => reject(Error('Server exited'))); server.stdout.on('data', chunk => {const match = String(chunk).match(/port (\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});});
    const base = 'http://127.0.0.1:' + port; browser = await chromium.launch({headless: true});
    const ca = await browser.newContext({viewport: {width: 1280, height: 850}}), cb = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'dark'});
    const a = await ca.newPage(), b = await cb.newPage(), errors = [];
    const idle = page => page.waitForFunction(() => !loading && !searchTimer && viewLoaded);
    const sync = async page => {await idle(page); await page.evaluate(() => sync()); await idle(page);};
    const login = async page => {await page.locator('#password').fill(password); await page.locator('#login-form button').click(); await idle(page);};
    for (const page of [a, b]) {page.on('pageerror', error => errors.push(error.message)); await page.goto(base); await login(page);}
    const binary = Buffer.alloc(100000); for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
    const choose = async (page, name, bytes) => {await page.locator('#file-input').setInputFiles({name, mimeType: 'application/octet-stream', buffer: bytes}); await page.locator('#attachment-selection').waitFor();};
    const send = async page => {await page.locator('#send').click(); await page.waitForFunction(() => !document.getElementById('send').classList.contains('sending')); await idle(page);};
    await choose(a, 'Документ.bin', binary); await a.locator('#text').fill('Подпись <script>literal</script>'); await send(a);
    assert(await a.locator('#attachment-selection').isHidden()); assert.equal(await a.locator('.file-download').count(), 1);
    assert.equal(await a.locator('.note-text').textContent(), 'Подпись <script>literal</script>'); assert.equal(await a.locator('#notes script').count(), 0);
    const first = await a.locator('.note').getAttribute('data-id'); await sync(b);
    assert((await b.locator('.file-download').textContent()).includes('Документ.bin'));
    const downloadPromise = b.waitForEvent('download'); await b.locator('.file-download').click(); const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'Документ.bin'); assert.deepEqual(fs.readFileSync(await download.path()), binary);
    const anonymous = await browser.newContext(); assert.equal((await anonymous.request.get(base + '/api/files/' + first)).status(), 401); await anonymous.close();
    // Clear a file caption without removing its bytes.
    await a.getByRole('button', {name: 'Изменить', exact: true}).click(); await a.locator('[data-action="edit-text"]').fill('');
    await a.getByRole('button', {name: 'Сохранить', exact: true}).click(); await a.waitForFunction(() => !document.querySelector('.note-editing')); await sync(a);
    assert.equal(await a.locator('.file-download').count(), 1); assert.equal(await a.locator('.note-text').textContent(), '');
    // Lost acknowledgement: server has the file; retry uses the same request ID.
    await choose(a, 'повтор.bin', Buffer.from('retry bytes'));
    await a.route('**/api/files', async route => {await route.fetch(); await route.abort('failed');});
    await a.locator('#send').click(); await a.waitForFunction(() => !document.getElementById('send').classList.contains('sending'));
    assert(await a.locator('#attachment-selection').isVisible()); assert(await a.locator('#notice').isVisible());
    await a.unroute('**/api/files'); await send(a);
    assert.equal(await a.locator('.file-download').count(), 2);
    // Cancellation preserves the selected file and text for an explicit retry.
    await choose(a, '<img onerror=alert(1)>.txt', Buffer.alloc(0)); await a.locator('#text').fill('Черновик с файлом');
    let release, entered; const gate = new Promise(resolve => release = resolve), requested = new Promise(resolve => entered = resolve);
    await a.route('**/api/files', async route => {entered(); await gate; try {await route.abort('failed');} catch {}});
    await a.locator('#send').click(); await requested; assert(await a.locator('#upload-feedback').isVisible()); assert(await a.locator('#upload-progress').isVisible());
    await a.setViewportSize({width: 320, height: 640}); await a.waitForTimeout(100);
    await a.screenshot({path: path.join(captures, 'upload-progress-mobile.png')});
    await a.locator('#cancel-upload').click(); release(); await a.waitForFunction(() => !document.getElementById('send').classList.contains('sending'));
    assert.equal(await a.locator('#text').inputValue(), 'Черновик с файлом'); assert(await a.locator('#attachment-selection').isVisible());
    await a.unroute('**/api/files'); await send(a); assert.equal(await a.locator('.file-download').count(), 3); assert.equal(await a.locator('#notes img').count(), 0);
    // Large file is rejected before transfer; ordinary text can still be sent afterward.
    await a.locator('#file-input').setInputFiles({name: 'too-big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(131073)});
    await a.waitForFunction(() => document.getElementById('notice').textContent.includes('слишком большой'));
    assert(await a.locator('#attachment-selection').isHidden()); await a.locator('#text').fill('Обычное текстовое сообщение'); await send(a);
    // Search by file name is server-side; no file bytes are included in page JSON.
    await a.locator('#search-toggle').click(); await a.locator('#search').fill('ДОКУМЕНТ.BIN'); await idle(a);
    assert.equal(await a.locator('.note').count(), 1); assert.equal(await a.locator('.note').getAttribute('data-id'), first);
    await a.locator('#search').press('Escape'); await idle(a);
    // Trash retains the bytes, restore keeps the identity, permanent deletion frees quota.
    const firstItem = () => a.locator(`.note[data-id="${first}"]`);
    await firstItem().getByRole('button', {name: 'Удалить', exact: true}).click(); await a.locator('dialog').getByRole('button', {name: 'В корзину', exact: true}).click(); await sync(a);
    await a.locator('#view-trash').click(); await idle(a); assert.equal(await a.locator('.file-download').count(), 1);
    assert.deepEqual(await (await ca.request.get(base + '/api/files/' + first)).body(), binary);
    await a.getByRole('button', {name: 'Восстановить', exact: true}).click(); await a.waitForFunction(() => !loading && !document.querySelector('.note'));
    await a.locator('#view-chat').click(); await idle(a); assert.equal(await firstItem().count(), 1);
    await firstItem().getByRole('button', {name: 'Удалить', exact: true}).click(); await a.locator('dialog').getByRole('button', {name: 'В корзину', exact: true}).click(); await sync(a);
    await a.locator('#view-trash').click(); await idle(a); await a.getByRole('button', {name: 'Удалить навсегда', exact: true}).click(); await a.locator('dialog').getByRole('button', {name: 'Удалить навсегда', exact: true}).click();
    await a.waitForFunction(() => !loading && !document.querySelector('.note')); assert.equal((await ca.request.get(base + '/api/files/' + first)).status(), 404);
    assert.equal((await (await ca.request.get(base + '/api/storage')).json()).used_bytes, 11);
    await a.locator('#view-chat').click(); await idle(a); await sync(b);
    // Session expiry keeps a selected file in memory for re-login/retry.
    await choose(b, 'после-входа.txt', Buffer.from('reauth'));
    await cb.clearCookies(); await b.locator('#send').click(); await b.locator('#login').waitFor(); await login(b);
    assert(await b.locator('#attachment-selection').isVisible()); await send(b); await sync(a);
    // Screenshots cover the established themes, compact mobile UI, and selected-file state.
    for (const [width, height] of [[1280, 850], [390, 844], [320, 640]]) {
      await a.setViewportSize({width, height}); await a.waitForTimeout(100); await a.evaluate(() => latest());
      for (const theme of ['light', 'dark']) {await a.evaluate(value => setTextdropTheme(value), theme); await a.waitForTimeout(180); await a.screenshot({path: path.join(captures, width + '-' + theme + '.png')});}
      assert(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert((await a.locator('#compose').boundingBox()).y + (await a.locator('#compose').boundingBox()).height <= height);
    }
    await choose(a, 'Выбранный файл с длинным названием для передачи на другое устройство.pdf', Buffer.from('selection'));
    await a.screenshot({path: path.join(captures, 'selected-mobile.png')}); assert.deepEqual(errors, []);
    console.log('PASS: binary upload/download on two devices, caption clearing, empty/literal filename, lost-response retry without duplicates, cancel/retry, progress, size limit, text regression, file-name search, trash/restore/purge/quota, auth/re-login, desktop/mobile/320px in both themes.');
  } finally {if (browser) await browser.close(); server.kill(); await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve)); fs.rmSync(data, {recursive: true, force: true});}
})().catch(error => {console.error(error); process.exit(1);});
