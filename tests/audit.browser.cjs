// Regressions for lost file acknowledgements and responses from a previous session.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-review-'));
  const server = spawn('python3', ['server.py'], {
    cwd: path.resolve(__dirname, '..'),
    env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: dir,
      TEXTDROP_PASSWORD: 'review-test-password', TEXTDROP_SECRET: 'review-test-secret-'.repeat(3)},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', () => {});
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Startup timeout')), 10000);
      server.once('exit', () => reject(Error('Server exited')));
      server.stdout.on('data', chunk => {
        const match = String(chunk).match(/port (\d+)/);
        if (match) {clearTimeout(timer); resolve(match[1]);}
      });
    });
    const base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext(), page = await context.newPage();
    const idle = () => page.waitForFunction(() => viewLoaded && !loading && !searchTimer);
    const login = async () => {
      await page.locator('#username').fill('admin');await page.locator('#password').fill('review-test-password');
      await page.locator('#login-form button[type=submit]').click(); await idle();
    };
    await page.goto(base); await login();
    const choose = async () => {
      await page.locator('#file-input').setInputFiles({name: 'same.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('same content')});
      await page.locator('#attachment-selection').waitFor();
    };
    await choose();
    await page.route('**/api/files', async route => {await route.fetch(); await route.abort('failed');});
    await page.locator('#send').click();
    await page.waitForFunction(() => !document.getElementById('send').classList.contains('sending'));
    await page.unroute('**/api/files');
    const before = (await (await context.request.get(base + '/api/notes/page')).json()).total;
    await page.reload(); await idle(); await choose(); await page.locator('#send').click();
    await page.waitForFunction(() => !document.getElementById('send').classList.contains('sending')); await idle();
    const after = (await (await context.request.get(base + '/api/notes/page')).json()).total;
    assert.equal(after, before, 'Reload and reselect must reuse the pending file request');

    let release, entered;
    const gate = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);
    await page.route('**/api/notes', async route => {
      if (route.request().method() === 'POST') {
        const response = await route.fetch(); entered(); await gate; await route.fulfill({response});
      } else await route.continue();
    });
    await page.locator('#text').fill('same draft text'); await page.locator('#send').click(); await seen;
    await page.locator('#account-button').click();await page.locator('#logout').click(); await page.locator('#login').waitFor(); await login();
    await page.locator('#text').fill('same draft text');
    const draftBefore = await page.locator('#text').inputValue(); release();
    await page.waitForFunction(() => !document.getElementById('send').classList.contains('sending'));
    // Wait for the old request's continuation, including its finally block.
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#text').inputValue(), draftBefore, 'Old session response must not erase a new draft');
    assert.equal(await page.locator('#send').getAttribute('aria-label'), 'Отправить сообщение');
    console.log('PASS: lost file acknowledgement across reload/reselection creates no duplicate; old session response preserves new draft and button state.');
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(dir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exit(1);});
