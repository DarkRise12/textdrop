// Fixture-only browser coverage: no production messages or credentials.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
(async () => {
  const root = path.resolve(__dirname, '../static');
  const captures = path.join(os.tmpdir(), 'textdrop-collapse');
  fs.mkdirSync(captures, {recursive: true});
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 850}});
    await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      value: {writeText: async text => { window.copiedText = text; }}
    }));
    const now = Date.now();
    const make = (id, text, index) => ({id, text, created: now + index * 60000, version: 0});
    const longText = 'Тестовая заметка\nhttps://example.com/visible\n'
      + 'Строка с текстом, который передаём между устройствами.\n'.repeat(14)
      + '<script>alert(1)</script>\nhttps://example.com/hidden\nУникальный хвост';
    let notes = [
      make('short', 'Короткое сообщение', 0),
      make('six', Array.from({length: 6}, (_, i) => 'Строка ' + (i + 1)).join('\n'), 1),
      make('seven', Array.from({length: 7}, (_, i) => 'Строка ' + (i + 1)).join('\n'), 2),
      make('wrapped', 'Текст без переводов строки. '.repeat(70), 3),
      make('url', 'https://example.com/' + 'a'.repeat(3000), 4),
      make('unicode', '👩🏽‍💻Привет '.repeat(8000).slice(0, 100000), 5),
      make('long', longText, 6)
    ].reverse();
    const original = structuredClone(notes);
    const trash = [{...notes[0], deleted: now, expires: now + 30 * 86400000}];
    await context.route('http://textdrop.test/**', route => {
      const req = route.request(), pathname = new URL(req.url()).pathname;
      if (pathname === '/api/session') return route.fulfill({json: {authenticated: true}});
      if (pathname === '/api/notes') return route.fulfill({json: notes});
      if (pathname === '/api/trash') return route.fulfill({json: trash});
      if (pathname.startsWith('/api/notes/') && req.method() === 'PATCH') {
        const id = pathname.split('/').pop();
        const note = {...notes.find(n => n.id === id), text: req.postDataJSON().text, version: 1, updated: Date.now()};
        notes = notes.map(n => n.id === id ? note : n);
        return route.fulfill({json: note});
      }
      const name = pathname === '/' ? 'index.html' : pathname.slice(1);
      return route.fulfill({body: fs.readFileSync(path.join(root, name)),
        contentType: name.endsWith('html') ? 'text/html' : name.endsWith('css') ? 'text/css' : 'text/javascript'});
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://textdrop.test/');
    await page.locator('.note').last().waitFor();
    const item = id => page.locator(`.note[data-id="${id}"]`);
    const toggle = id => item(id).locator('.message-toggle');
    const body = id => item(id).locator('.note-text');
    const expanded = id => toggle(id).getAttribute('aria-expanded');
    for (const [width, height] of [[1280, 850], [390, 844], [320, 640]]) {
      await page.setViewportSize({width, height});
      await page.waitForTimeout(150);
      for (const id of ['short', 'six']) assert(await toggle(id).isHidden(), id);
      for (const id of ['seven', 'wrapped', 'url', 'unicode', 'long']) {
        assert.equal(await expanded(id), 'false', id);
        assert(await toggle(id).isVisible());
        assert(await body(id).evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 6 + 1));
        assert((await body(id).textContent()).endsWith('…'));
        const control = await toggle(id).getAttribute('aria-controls');
        assert.equal(control, await body(id).getAttribute('id'));
        const box = await toggle(id).boundingBox(); assert(box.height >= 40);
      }
      assert.equal(await item('url').locator('.note-text a').count(), 0, 'Partial URLs must not become links');
      assert.equal(await item('long').locator('a[href="https://example.com/hidden"]').count(), 0, 'Hidden links must not be focusable');
      assert.equal(await item('long').locator('a[href="https://example.com/visible"]').count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => {setTextdropTheme(value); latest();}, theme);
        await page.waitForTimeout(180);
        await page.screenshot({path: path.join(captures, width + '-' + theme + '.png')});
      }
    }
    await page.setViewportSize({width: 1280, height: 850});
    await toggle('long').focus(); await toggle('long').press('Enter');
    assert.equal(await expanded('long'), 'true');
    assert.equal(await body('long').textContent(), longText);
    await page.waitForTimeout(180); // Let the existing button background transition settle.
    assert(await toggle('long').evaluate(el => {
      const box = el.getBoundingClientRect(), history = document.getElementById('history').getBoundingClientRect();
      return el === document.activeElement && box.top >= history.top && box.bottom <= history.bottom + 1
        && box.width >= el.previousElementSibling.getBoundingClientRect().width - 1
        && getComputedStyle(el).backgroundColor === getComputedStyle(el.closest('.note')).backgroundColor;
    }));
    await page.screenshot({path: path.join(captures, 'expanded-desktop.png')});
    assert.equal(await item('long').locator('script').count(), 0);
    assert.equal(await item('long').locator('a').count(), 2);
    // Expanded state survives changed polls and changes of screen width.
    notes.unshift(make('remote', 'С другого устройства', 7));
    await page.evaluate(() => sync());
    assert.equal(await expanded('long'), 'true');
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(100);
    assert.equal(await expanded('long'), 'true');
    await page.screenshot({path: path.join(captures, 'expanded-mobile.png')});
    // Collapse from the bottom returns to this message rather than jumping to another.
    await toggle('long').click(); assert.equal(await expanded('long'), 'false');
    assert(await item('long').evaluate(el => {
      const history = document.getElementById('history').getBoundingClientRect();
      return el.getBoundingClientRect().top >= history.top - 1;
    }));
    await item('long').getByRole('button', {name: 'Копировать', exact: true}).click();
    assert.equal(await page.evaluate(() => window.copiedText), longText);
    // Search reveals matches beyond the preview without changing the manual choice.
    await page.locator('#search-toggle').click(); await page.locator('#search').fill('Уникальный хвост');
    assert.equal(await page.locator('.note').count(), 1);
    assert.equal(await body('long').textContent(), longText); assert(await toggle('long').isHidden());
    await page.locator('#search').press('Escape'); assert.equal(await expanded('long'), 'false');
    // Editing always starts with the original, full value, even from a collapsed message.
    await item('long').getByRole('button', {name: 'Изменить', exact: true}).click();
    const field = page.locator('[data-action="edit-text"]'); assert.equal(await field.inputValue(), longText);
    await page.getByRole('button', {name: 'Отмена', exact: true}).click();
    assert.equal(await expanded('long'), 'false');
    await item('long').getByRole('button', {name: 'Изменить', exact: true}).click();
    await field.fill('Теперь коротко'); await page.getByRole('button', {name: 'Сохранить', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('.note-editing'));
    assert.equal(await body('long').textContent(), 'Теперь коротко'); assert(await toggle('long').isHidden());
    // A remote edit invalidates the measured preview; the original text was never mutated.
    notes = structuredClone(original); await page.evaluate(() => sync());
    assert.equal(await expanded('long'), 'false'); assert((await body('long').textContent()).endsWith('…'));
    await page.locator('#view-trash').click(); await page.waitForFunction(() => !loading);
    assert.equal(await expanded('long'), 'false'); await toggle('long').click();
    assert.equal(await body('long').textContent(), longText);
    await page.locator('#view-chat').click(); await page.waitForFunction(() => !loading);
    assert.equal(await expanded('long'), 'true');
    // Reload resets a local presentation choice, leaving stored records untouched.
    await page.reload(); await page.locator('.note').last().waitFor();
    assert.equal(await expanded('long'), 'false'); assert.deepEqual(notes, original);
    assert.deepEqual(errors, []);
    console.log('PASS: real six-line previews at desktop/390/320 widths, 100k Unicode text, literal HTML, complete and truncated links, keyboard toggles, scroll position, full copy/edit, search tail, polling/resize, edit invalidation, trash, reload, both themes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
