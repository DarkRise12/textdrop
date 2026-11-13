// Two users, two devices, account administration and cross-tab draft protection.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-accounts-'));
  const server = spawn('python3', ['server.py'], {
    cwd: path.resolve(__dirname, '..'),
    env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: dir,
      TEXTDROP_PASSWORD: 'owner-test-password', TEXTDROP_SECRET: 'accounts-test-secret-'.repeat(3)},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = ''; server.stderr.on('data', data => errors += data);
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout: ' + errors)), 10000);
      server.once('exit', () => reject(Error('Server exited: ' + errors)));
      server.stdout.on('data', chunk => {
        const match = String(chunk).match(/port (\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    const base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless: true});
    const owner = await browser.newContext({viewport: {width: 1280, height: 800}});
    const alex = await browser.newContext({viewport: {width: 375, height: 812}});
    const page = await owner.newPage(), phone = await alex.newPage();
    const idle = page => page.waitForFunction(() => viewLoaded && !loading && !searchTimer);
    const login = async (page, username, password) => {
      await page.locator('#username').fill(username); await page.locator('#password').fill(password);
      await page.locator('#login-form button').click(); await idle(page);
    };
    const send = async (page, text) => {
      await page.locator('#text').fill(text); await page.locator('#send').click();
      await page.waitForFunction(() => !document.getElementById('send').classList.contains('sending')); await idle(page);
    };
    await page.goto(base); await login(page, 'admin', 'owner-test-password');
    await send(page, 'Owner private history');
    await page.locator('#account-button').click();
    await page.locator('#create-user-form [name=username]').fill('alex');
    await page.locator('#create-user-form [name=password]').fill('alex-test-password');
    await page.locator('#create-user-form button').click();
    await page.getByText('Создан пользователь alex.', {exact: false}).waitFor();
    assert.equal(await page.locator('.user-row').count(), 2);
    await page.screenshot({path: '/tmp/textdrop-accounts-desktop.png'});
    await page.locator('#close-account').click();
    await phone.goto(base); await login(phone, 'alex', 'alex-test-password');
    assert.equal(await phone.locator('.note').count(), 0);
    await send(phone, 'Alex private history');
    assert.equal(await page.locator('.note').count(), 1);
    const file = {name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('Alex file')};
    await phone.locator('#file-input').setInputFiles(file); await phone.locator('#attachment-selection').waitFor();
    await phone.locator('#send').click(); await phone.waitForFunction(() => !selectedFile && !uploadRequest); await idle(phone);
    const fileId = await phone.evaluate(() => notes.find(note => note.file).id);
    assert.equal((await owner.request.get(base + '/api/files/' + fileId)).status(), 404);
    assert.equal(await (await alex.request.get(base + '/api/files/' + fileId)).text(), 'Alex file');
    await phone.locator('#text').fill('Alex browser draft');
    await phone.reload(); await idle(phone);
    assert.equal(await phone.locator('#text').inputValue(), 'Alex browser draft');
    await phone.locator('#account-button').click();
    assert.equal(await phone.locator('#users-section').isVisible(), false);
    await phone.setViewportSize({width: 320, height: 640});
    await phone.evaluate(() => window.setTextdropTheme('dark'));
    await phone.screenshot({path: '/tmp/textdrop-accounts-mobile.png'});
    assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(await phone.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1);}).map(el => [el.tagName, el.id, el.className, el.getBoundingClientRect().right]).slice(0, 20))));
    await phone.locator('#close-account').click();

    // A cookie can change in a different tab without a session transition here.
    await page.locator('#text').fill('Owner browser draft');
    await owner.request.post(base + '/api/login', {data: {username: 'alex', password: 'alex-test-password'}});
    await page.evaluate(() => sync()); await page.locator('#login').waitFor();
    await login(page, 'alex', 'alex-test-password');
    assert.equal(await page.locator('#text').inputValue(), '');
    assert.equal(await page.locator('.note').count(), 2);
    await page.locator('#text').fill('Alex second browser draft');
    await owner.request.post(base + '/api/login', {data: {username: 'admin', password: 'owner-test-password'}});
    await page.evaluate(() => sync()); await page.locator('#login').waitFor();
    await login(page, 'admin', 'owner-test-password');
    assert.equal(await page.locator('#text').inputValue(), 'Owner browser draft');
    assert.equal(await page.locator('.note').count(), 1);

    await page.locator('#account-button').click();
    const row = page.locator('.user-row').filter({has: page.locator('strong', {hasText: /^alex$/})});
    await row.getByRole('button', {name: 'Новый пароль', exact: true}).click();
    await row.locator('input').fill('changed-alex-password');
    await row.getByRole('button', {name: 'Сохранить пароль', exact: true}).click();
    await page.getByText('Пароль изменён. Сессии пользователя завершены.', {exact: true}).waitFor();
    await phone.evaluate(() => sync()); await phone.locator('#login').waitFor();
    await login(phone, 'alex', 'changed-alex-password');
    assert.equal(await phone.locator('#text').inputValue(), 'Alex browser draft');
    await row.getByRole('button', {name: 'Отключить alex', exact: true}).click();
    await page.getByText('Доступ отключён. Сессии завершены.', {exact: true}).waitFor();
    await phone.evaluate(() => sync()); await phone.locator('#login').waitFor();
    await row.getByRole('button', {name: 'Включить alex', exact: true}).click();
    await page.getByText('Доступ включён.', {exact: true}).waitFor();
    await login(phone, 'alex', 'changed-alex-password');
    await phone.locator('#account-button').click();
    await phone.locator('#password-form [name=current_password]').fill('changed-alex-password');
    await phone.locator('#password-form [name=password]').fill('my-new-alex-password');
    await phone.locator('#password-form button').click();
    await phone.locator('#login').waitFor();
    await login(phone, 'alex', 'my-new-alex-password');
    assert.equal(await phone.locator('#text').inputValue(), 'Alex browser draft');
    await phone.locator('#logout').click(); await phone.locator('#login').waitFor();
    await login(phone, 'alex', 'my-new-alex-password');
    assert.equal(await phone.locator('#text').inputValue(), '');
    console.log('PASS: owner administration, isolated chats/files/drafts, mobile layout, cross-tab cookie binding, reset/disable and own password change.');
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
