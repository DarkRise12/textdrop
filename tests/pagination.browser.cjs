// Full flow against 10,000 synthetic records in a disposable database.
const {chromium} = require('playwright');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'textdrop-pages-'));
  const captures = path.join(os.tmpdir(), 'textdrop-pagination'); fs.mkdirSync(captures, {recursive: true});
  const seed = spawnSync('python3', ['-c', `from server import Store
import sys
from pathlib import Path
store = Store(Path(sys.argv[1]) / 'notes.sqlite3')
with store.connect() as db:
    db.executemany('INSERT INTO notes VALUES (?, ?, ?)', ((f'{i:032x}', ('Уникальный ЁЖИК 100% _' if i == 7 else 'Тестовая заметка') + f' {i}\\nСодержимое с другого устройства.', 1700000000000 + i // 4) for i in range(10000)))
`, data], {cwd: root, encoding: 'utf8'});
  assert.equal(seed.status, 0, seed.stderr);
  const password = 'pagination-test-password';
  const server = spawn('python3', ['server.py'], {cwd: root, env: {...process.env, TEXTDROP_HOST: '127.0.0.1', TEXTDROP_PORT: '0', TEXTDROP_DATA: data, TEXTDROP_PASSWORD: password, TEXTDROP_SECRET: 'test-feed-secret-'.repeat(3), TEXTDROP_SECURE: '0'}, stdio: ['ignore', 'pipe', 'pipe']});
  // Drain logs to keep the disposable process from blocking on a full pipe.
  let logs = ''; server.stderr.on('data', chunk => { logs += chunk; }); let browser;
  try {
    const port = await new Promise((resolve, reject) => {const timeout = setTimeout(() => reject(Error('Startup timeout')), 10000); server.once('exit', () => reject(Error('Server exited'))); server.stdout.on('data', chunk => {const match = String(chunk).match(/port (\d+)/); if (match) {clearTimeout(timeout); resolve(match[1]);}});});
    const base = 'http://127.0.0.1:' + port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1280, height: 850}});
    const page = await context.newPage(), errors = [], reads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/notes')) reads.push(request.url());});
    const idle = () => page.waitForFunction(() => !loading && !searchTimer && viewLoaded);
    const sync = async () => {await idle(); await page.evaluate(() => sync()); await idle();};
    const id = index => index.toString(16).padStart(32, '0');
    const item = index => page.locator(`.note[data-id="${id(index)}"]`);
    await page.goto(base); await page.locator('#password').fill(password);
    const start = Date.now(); await page.locator('#login-form button').click(); await idle();
    const initialMs = Date.now() - start;
    assert.equal(await page.locator('.note').count(), 50); assert.equal(await page.locator('#count').textContent(), '10000');
    assert.equal(reads.filter(url => new URL(url).pathname.endsWith('/page')).length, 1);
    assert(!reads.some(url => new URL(url).pathname === '/api/notes'), 'UI must never request the entire history');
    assert.equal(await page.locator('.note').first().getAttribute('data-id'), id(9950));
    // An idle poll transfers no records, independent of the database size.
    const current = await page.evaluate(() => feedRevision);
    const delta = await (await context.request.get(base + '/api/notes/changes?since=' + current)).json();
    assert.deepEqual(delta.items, []); assert.deepEqual(delta.removed, []);
    // Scroll toward the oldest loaded item; prepending must keep the reading anchor.
    await page.locator('#history').evaluate(el => {el.scrollTop = 180;}); await page.waitForTimeout(80);
    const anchor = await page.evaluate(() => {const h = document.getElementById('history').getBoundingClientRect(); const item = [...document.querySelectorAll('.note')].find(el => el.getBoundingClientRect().bottom > h.top); return {id: item.dataset.id, top: item.getBoundingClientRect().top};});
    // Use the accessible fallback button while suppressing pointer-induced scrolling.
    await page.evaluate(() => document.getElementById('load-more').click()); await idle();
    assert.equal(await page.locator('.note').count(), 100);
    const afterTop = await page.locator(`.note[data-id="${anchor.id}"]`).evaluate(el => el.getBoundingClientRect().top);
    assert(Math.abs(afterTop - anchor.top) < 2, 'Loading older records must preserve the visible anchor');
    assert.equal(new Set(await page.locator('.note').evaluateAll(elements => elements.map(el => el.dataset.id))).size, 100);
    // Automatic loading at the upper edge, then another idle poll must retain all pages.
    await page.locator('#history').evaluate(el => {el.scrollTop = 0;});
    await page.waitForFunction(() => notes.length >= 150); await idle();
    const loaded = await page.locator('.note').count(); await sync(); assert.equal(await page.locator('.note').count(), loaded);
    // Changes in an older page are reconciled, including a live editor and its caret.
    await item(9910).getByRole('button', {name: 'Изменить', exact: true}).click();
    await page.locator('[data-action="edit-text"]').fill('Несохранённые локальные правки');
    await page.locator('[data-action="edit-text"]').evaluate(el => el.setSelectionRange(5, 5));
    await context.request.patch(base + '/api/notes/' + id(9910), {data: {text: 'Удалённая правка старой страницы', version: 0}});
    await sync(); assert.equal(await page.locator('[data-action="edit-text"]').inputValue(), 'Несохранённые локальные правки');
    assert.equal(await page.locator('[data-action="edit-text"]').evaluate(el => el.selectionStart), 5);
    assert.equal(await page.locator('.edit-remote-text').textContent(), 'Удалённая правка старой страницы');
    await page.getByRole('button', {name: 'Отмена', exact: true}).click();
    await context.request.delete(base + '/api/notes/' + id(9911)); await sync(); assert.equal(await item(9911).count(), 0);
    await context.request.post(base + '/api/trash/' + id(9911) + '/restore', {data: {}}); await sync(); assert.equal(await item(9911).count(), 1);
    // Old changes outside the loaded range must not create a misleading timeline gap.
    await context.request.patch(base + '/api/notes/' + id(8), {data: {text: 'Изменение вне загруженного диапазона', version: 0}});
    await sync(); assert.equal(await item(8).count(), 0);
    // Search covers unloaded text, preserves literal wildcard characters, and counts all results.
    await page.locator('#text').fill('Мой черновик');
    await page.locator('#search-toggle').click(); await page.locator('#search').fill('ёжик 100% _'); await idle();
    assert.equal(await page.locator('.note').count(), 1); assert.equal(await item(7).count(), 1);
    assert.equal(await page.locator('#count').textContent(), '1');
    await page.locator('#search').fill('Тестовая заметка'); await idle();
    assert.equal(await page.locator('.note').count(), 50); assert.equal(await page.locator('#count').textContent(), '9997');
    await page.evaluate(() => document.getElementById('load-more').click()); await idle(); assert.equal(await page.locator('.note').count(), 100);
    // A delayed answer for a previous query cannot replace a newer result.
    let release, seen; const gate = new Promise(resolve => release = resolve), requested = new Promise(resolve => seen = resolve);
    await page.route('**/api/notes/page?*', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === 'Задержка') {seen(); await gate; try {await route.continue();} catch {}} else await route.continue();
    });
    await page.locator('#search').fill('Задержка'); await requested;
    await page.locator('#search').fill('ёжик'); release(); await idle();
    assert.equal(await item(7).count(), 1); assert.equal(await page.locator('.note').count(), 1);
    await page.unroute('**/api/notes/page?*');
    // A search result being edited stays valid even after the query changes away from it.
    await item(7).getByRole('button', {name: 'Изменить', exact: true}).click();
    await page.locator('[data-action="edit-text"]').fill('Мой вариант'); await page.locator('#search').fill('ничего такого нет'); await idle();
    assert(await page.locator('.edit-save').isEnabled()); assert(await page.locator('.edit-feedback').isHidden());
    await context.request.patch(base + '/api/notes/' + id(7), {data: {text: 'Новая версия вне фильтра', version: 0}}); await sync();
    assert.equal(await page.locator('.edit-remote-text').textContent(), 'Новая версия вне фильтра');
    await page.getByRole('button', {name: 'Отмена', exact: true}).click();
    await page.locator('#search').press('Escape'); await idle();
    assert.equal(await page.locator('.note').count(), 50); assert.equal(await page.locator('#text').inputValue(), 'Мой черновик');
    // Sending from a search resets its page cursor and opens the latest chat page.
    await page.locator('#search-toggle').click(); await page.locator('#search').fill('нет такого результата'); await idle();
    await page.locator('#text').fill('Отправлено во время поиска'); await page.locator('#send').click();
    await page.waitForFunction(() => !loading && viewLoaded && !document.getElementById('text').value);
    assert.equal(await page.locator('#search').inputValue(), ''); assert.equal(await page.locator('.note').count(), 50);
    assert.equal(await page.locator('.note-text').last().textContent(), 'Отправлено во время поиска');
    // A failed older-page request leaves the loaded records and offers a safe retry.
    await page.route('**/api/notes/page?*', route => new URL(route.request().url()).searchParams.has('before') ? route.fulfill({status: 503, json: {error: 'Тестовый сбой'}}) : route.continue());
    await page.evaluate(() => loadOlder()); assert.equal(await page.locator('.note').count(), 50); assert(await page.locator('#notice').isVisible());
    await page.unroute('**/api/notes/page?*'); await page.evaluate(() => loadOlder()); await idle(); assert.equal(await page.locator('.note').count(), 100); assert(await page.locator('#notice').isHidden());
    // A new remote record must not move a reader of older history to the bottom.
    await page.locator('#history').evaluate(el => {el.scrollTop = 250;}); await page.waitForTimeout(80);
    const oldTop = await page.locator('#history').evaluate(el => el.scrollTop);
    await context.request.post(base + '/api/notes', {data: {text: 'Новое сообщение с телефона'}}); await sync();
    assert(Math.abs(await page.locator('#history').evaluate(el => el.scrollTop) - oldTop) < 2); assert(await page.locator('#latest').isVisible());
    // The existing compact layout remains intact on desktop and mobile, both themes.
    await page.locator('#text').fill('');
    for (const [width, height] of [[1280, 850], [390, 844], [320, 640]]) {
      await page.setViewportSize({width, height}); await page.waitForTimeout(120);
      await page.evaluate(() => {document.getElementById('history').scrollTop = 110; lastHistoryScroll = 110;});
      for (const theme of ['light', 'dark']) {await page.evaluate(value => setTextdropTheme(value), theme); await page.waitForTimeout(180); await page.screenshot({path: path.join(captures, width + '-' + theme + '.png')});}
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert((await page.locator('#workspace-toolbar').boundingBox()).height <= 52);
    }
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(120);
    await page.evaluate(() => {document.getElementById('history').scrollTop = 0; lastHistoryScroll = 0; document.getElementById('latest').hidden = true;});
    assert(await page.locator('#load-more').evaluate(el => {const r = el.getBoundingClientRect(), h = document.getElementById('history').getBoundingClientRect(); return r.top >= h.top && r.bottom <= h.bottom;}));
    await page.screenshot({path: path.join(captures, 'older-control-mobile.png')});
    await page.locator('#search-toggle').click(); await page.locator('#search').fill('Удалённая правка старой страницы'); await idle();
    assert.equal(await page.locator('.note').count(), 1); assert.equal(await item(9910).count(), 1);
    await page.screenshot({path: path.join(captures, 'server-search-mobile.png')});
    assert(!reads.some(url => new URL(url).pathname === '/api/notes'));
    assert(!logs.includes('q='), 'Search text must not be written to request logs');
    assert.deepEqual(errors, []);
    console.log(`PASS: 10,000 records, initial 50 in ${initialMs}ms, bounded pages, empty idle delta, automatic/manual older loading, scroll anchoring, no duplicates, remote edit/delete/restore in older pages, editor caret/conflicts, Unicode/literal server search, query race, query change during editing, retained draft, page failure/retry, both themes and 320/390/1280px.`);
  } finally {
    if (browser) await browser.close(); server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    fs.rmSync(data, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exit(1);});
