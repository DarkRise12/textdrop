// Design-audit changes against an isolated service with synthetic content.
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-design-data-'));
  const captures = path.join(os.tmpdir(), 'textdrop-design-review'); fs.mkdirSync(captures, {recursive: true});
  const server = spawn('python3', ['server.py'], {cwd: path.resolve(__dirname, '..'), env: {...process.env,
    TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: data,
    TEXTDROP_PASSWORD: 'auditpw', TEXTDROP_SECRET: 'design-review-secret-'.repeat(3)}, stdio: ['ignore', 'pipe', 'pipe']});
  let browser, logs = ''; server.stderr.on('data', chunk => logs += chunk);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + logs)), 10000);
      server.once('exit', () => reject(Error('Server exited: ' + logs)));
      server.stdout.on('data', chunk => {const match = String(chunk).match(/port (\d+)/); if (match) {clearTimeout(timer); resolve(match[1]);}});
    });
    const base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1280, height: 800}});
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {value: {writeText: async value => window.copiedText = value}}));
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const idle = () => page.waitForFunction(() => viewLoaded && !loading && !searchTimer);
    const shot = async name => {await page.screenshot({path: path.join(captures, name + '.png'), animations: 'disabled'});};
    const search = async query => {
      if (!await page.locator('#search').isVisible()) await page.locator('#search-toggle').click();
      await page.locator('#search').fill(query); await idle();
    };
    await page.goto(base); await page.locator('#login').waitFor();
    assert.equal(await page.locator('#username').inputValue(), '');
    await page.locator('#password').fill('auditpw');
    await page.locator('#login-form .password-toggle').click(); assert.equal(await page.locator('#password').getAttribute('type'), 'text');
    await page.locator('#login-form .password-toggle').press('Space'); assert.equal(await page.locator('#password').getAttribute('type'), 'password');
    await page.locator('#username').fill('admin'); await page.locator('#login-form button[type=submit]').click(); await idle();
    assert(await page.locator('#empty').textContent().then(text => text.includes('прикрепи файл')));
    assert(await page.locator('#logout').isHidden());
    const text = 'Начало заметки\n' + 'Детали для другого устройства.\n'.repeat(30) + '\n'.repeat(80) + 'Уникальный проект Straße — <script>literal</script>\nКонец';
    const response = await context.request.post(base + '/api/notes', {data: {text}}); const note = await response.json();
    await context.request.post(base + '/api/notes', {data: {text: 'Ссылка на проект: https://example.com/project'}});
    await context.request.post(base + '/api/notes', {data: {text: 'Список покупок\nМолоко\nКофе\nБатарейки AA'}});
    for (const username of ['alex', 'anna', 'very.long.account.name.123456789']) {
      assert.equal((await context.request.post(base + '/api/users', {data: {username, password: 'auditpw'}})).status(), 201);
    }
    await page.reload(); await idle();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({width, height: width === 1280 ? 800 : width === 390 ? 844 : 640});
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => window.setTextdropTheme(value), theme);
        assert(await page.locator('#account-label').isVisible());
        assert.equal(await page.locator('#account-label').textContent(), 'admin');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.evaluate(() => latest()); await shot(width + '-' + theme + '-chat');
        await search('STRASSE');
        const item = page.locator('.note[data-id="' + note.id + '"]');
        assert.equal(await page.locator('.note').count(), 1);
        assert.equal(await item.locator('mark').textContent(), 'Straße');
        assert.notEqual(await item.locator('.note-text').textContent(), text);
        assert(await item.locator('.note-text').evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 6 + 1));
        assert.equal(await page.locator('#search-results-label').textContent(), 'Найдено: 1');
        assert.equal(await item.locator('script').count(), 0);
        await shot(width + '-' + theme + '-search');
        await item.getByRole('button', {name: 'Показать полностью', exact: true}).click();
        assert.equal(await item.locator('.note-text').textContent(), text);
        await item.getByRole('button', {name: 'Копировать', exact: true}).click(); assert.equal(await page.evaluate(() => window.copiedText), text);
        await item.getByRole('button', {name: 'Свернуть', exact: true}).click();
        await page.locator('#search').press('Escape'); await idle();
        await page.locator('#account-button').click(); await page.locator('.user-row').last().waitFor();
        await page.waitForFunction(() => document.getElementById('storage-status').textContent.includes('Свободно'));
        assert(await page.locator('#create-user-form').isHidden()); assert.equal(await page.locator('.user-row').count(), 4);
        assert(await page.locator('#logout').isVisible());
        assert(await page.locator('#close-account').evaluate(el => {const r = el.getBoundingClientRect(); return r.top >= 0 && r.right <= innerWidth;}));
        assert(await page.locator('#logout').evaluate(el => {const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;}));
        await shot(width + '-' + theme + '-accounts');
        await page.locator('#add-user').click(); await page.locator('#create-user-form [name=username]').fill('cancelled');
        await page.locator('#create-user-form [name=password]').fill('auditpw');
        await page.locator('#create-user-form .password-toggle').click();
        assert.equal(await page.locator('#create-user-form [name=password]').getAttribute('type'), 'text');
        await page.locator('#cancel-create-user').click();
        assert.equal(await page.locator('#create-user-form [name=password]').inputValue(), '');
        assert.equal(await page.locator('#create-user-form [name=password]').getAttribute('type'), 'password');
        await page.locator('#close-account').click();
      }
    }
    await search('example.com');
    const link = page.locator('.note-text a'); assert.equal(await link.locator('mark').textContent(), 'example.com');
    assert.equal(await link.getAttribute('href'), 'https://example.com/project'); assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    await page.locator('#search').press('Escape'); await idle();
    await page.locator('#file-input').setInputFiles({name: 'проект <literal>.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic file')});
    await page.locator('#attachment-selection').waitFor();
    assert((await page.locator('#attachment-space').textContent()).includes('Свободно: 3 ГБ'));
    await shot('320-file-selected');
    await page.locator('#send').click(); await page.waitForFunction(() => !uploadRequest && !selectedFile); await idle();
    await search('ПРОЕКТ'); assert.equal(await page.locator('.file-download mark').textContent(), 'проект');
    await page.locator('#search').press('Escape'); await idle();
    // Storage errors remain local to settings and can recover without discarding a draft.
    await page.locator('#text').fill('Сохранить черновик');
    await page.route('**/api/storage', route => route.fulfill({status: 503, json: {error: 'Synthetic failure'}}));
    await page.locator('#account-button').click(); await page.locator('#storage-retry').waitFor();
    await page.unroute('**/api/storage'); await page.locator('#storage-retry').click();
    await page.waitForFunction(() => document.getElementById('storage-status').textContent.includes('Свободно'));
    await page.locator('#account-password-tab').click();
    await page.locator('#password-form .password-toggle').last().click();
    assert.equal(await page.locator('#password-form [name=password]').getAttribute('type'), 'text');
    await shot('320-password-settings');
    await page.locator('#close-account').click();
    await page.waitForFunction(() => document.querySelector('#password-form [name=password]').type === 'password');
    assert.equal(await page.locator('#text').inputValue(), 'Сохранить черновик');
    // The header must accommodate a 32-character username on a narrow phone.
    await page.locator('#account-button').click(); await page.locator('#logout').click(); await page.locator('#login').waitFor();
    assert.equal(await page.locator('#username').inputValue(), 'admin');
    await page.locator('#username').fill('very.long.account.name.123456789'); await page.locator('#password').fill('auditpw');
    await page.locator('#login-form button[type=submit]').click(); await idle();
    assert(await page.locator('#account-label').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot('320-long-username');
    assert.deepEqual(errors, []);
    console.log('PASS: quieter header and visible account, compact Unicode search and safe marked links/files, full copy, settings list and create/cancel, quota/retry, password visibility/reset, saved username, 320/390/1280px in both themes.');
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(data, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
