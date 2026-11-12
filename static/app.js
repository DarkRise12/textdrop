'use strict';
const $ = id => document.getElementById(id);
let notes = [], loading = false, generation = 0, online = false;
const notice = message => {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('login-feedback').textContent = message;
  $('login-feedback').hidden = !message || $('login').hidden;
};
function themeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  $('theme-toggle').setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
  $('theme-label').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
}
$('theme-toggle').onclick = () => {
  window.setTextdropTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  themeLabel();
};
new MutationObserver(themeLabel).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
themeLabel();
function resizeInput() {
  $('send').disabled = $('send').classList.contains('sending') || !$('text').value.trim();
  $('text').style.height = 'auto';
  $('text').style.height = Math.min($('text').scrollHeight, 180) + 'px';
}
function latest() {
  $('history').scrollTop = $('history').scrollHeight;
  $('latest').hidden = true;
}
$('latest').onclick = latest;
$('history').onscroll = () => {
  if ($('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 80) $('latest').hidden = true;
};
$('text').oninput = resizeInput;
if (window.visualViewport) {
  const fitViewport = () => document.documentElement.style.setProperty('--app-height', window.visualViewport.height + 'px');
  window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}
function session(active) {
  generation++;
  $('login').hidden = active;
  $('workspace').hidden = !active;
  $('logout').hidden = !active;
  $('login-feedback').hidden = active || !$('login-feedback').textContent;
  if (active) requestAnimationFrame(resizeInput);
  if (!active) { online = false; notes = []; $('notes').replaceChildren(); $('text').value = ''; $('latest').hidden = true; }
}
async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, {
    method, headers: body ? {'Content-Type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') session(false);
    throw new Error(data.error || 'Ошибка сервера. Попробуй снова.');
  }
  return data;
}
function errorMessage(error) {
  return error instanceof TypeError || error.name === 'TimeoutError'
    ? 'Нет связи с сервером. Проверь подключение и попробуй снова.' : error.message;
}
function render({forceBottom = false, searchChanged = false} = {}) {
  const history = $('history');
  const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
  const previousTop = history.scrollTop;
  const anchor = [...$('notes').querySelectorAll('.note')].find(item => item.getBoundingClientRect().bottom > history.getBoundingClientRect().top);
  const anchorId = anchor?.dataset.id;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const focused = document.activeElement;
  const focusId = focused?.closest('.note')?.dataset.id;
  const focusAction = focused?.dataset.action;
  const query = $('search').value.toLocaleLowerCase();
  const filtered = notes.filter(n => n.text.toLocaleLowerCase().includes(query)).slice().reverse();
  $('count').textContent = notes.length;
  $('empty').hidden = notes.length > 0;
  $('no-results').hidden = !notes.length || filtered.length > 0;
  const fragment = document.createDocumentFragment();
  let previousDay = '';
  for (const note of filtered) {
    const date = new Date(note.created);
    const day = date.toLocaleDateString('ru');
    if (day !== previousDay) {
      const divider = document.createElement('div'); divider.className = 'day-divider';
      divider.textContent = date.toLocaleDateString('ru', {day: 'numeric', month: 'long', year: 'numeric'});
      fragment.append(divider); previousDay = day;
    }
    const article = document.createElement('article'); article.className = 'note'; article.dataset.id = note.id;
    const meta = document.createElement('div'); meta.className = 'note-meta';
    const time = document.createElement('time'); time.dateTime = new Date(note.created).toISOString();
    time.textContent = new Intl.DateTimeFormat('ru', {hour:'2-digit', minute:'2-digit'}).format(note.created);
    time.title = date.toLocaleString('ru');
    const actions = document.createElement('div'); actions.className = 'note-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet'; copy.textContent = 'Копировать'; copy.dataset.action = 'copy';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(note.text); copy.textContent = 'Скопировано'; setTimeout(() => { copy.textContent = 'Копировать'; }, 1800); }
      catch { notice('Не удалось скопировать. Выдели текст и скопируй вручную. Для кнопки нужен HTTPS.'); }
    };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Удалить'; remove.dataset.action = 'delete';
    remove.onclick = () => {
      const dialog = $('delete-dialog'); dialog.returnValue = ''; dialog.showModal();
      dialog.onclose = async () => {
        if (dialog.returnValue !== 'delete') return;
        remove.disabled = true;
        try { await api('notes/' + note.id, 'DELETE'); generation++; notes = notes.filter(item => item.id !== note.id); render(); notice(''); await sync(); }
        catch (error) { notice(errorMessage(error)); remove.disabled = false; }
      };
    };
    actions.append(copy, remove); meta.append(time, actions);
    const text = document.createElement('pre'); text.className = 'note-text'; text.textContent = note.text;
    article.append(text, meta); fragment.append(article);
  }
  $('notes').replaceChildren(fragment);
  if (forceBottom || (!searchChanged && nearBottom)) latest();
  else if (searchChanged) { history.scrollTop = query ? 0 : history.scrollHeight; $('latest').hidden = true; }
  else {
    const restored = [...$('notes').querySelectorAll('.note')].find(item => item.dataset.id === anchorId);
    history.scrollTop = restored ? previousTop + restored.getBoundingClientRect().top - anchorTop : previousTop;
  }
  if (focusId && focusAction) {
    const item = [...$('notes').querySelectorAll('.note')].find(node => node.dataset.id === focusId);
    item?.querySelector(`[data-action="${focusAction}"]`)?.focus({preventScroll: true});
  }
}
async function sync() {
  if ($('workspace').hidden || loading) return;
  loading = true;
  const current = generation;
  try {
    const data = await api('notes');
    if (generation !== current) return;
    const changed = JSON.stringify(notes) !== JSON.stringify(data);
    const firstLoad = !online && !notes.length;
    const previousIds = new Set(notes.map(note => note.id));
    const added = data.some(note => !previousIds.has(note.id));
    const following = $('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 80;
    notes = data;
    if (changed || !online) render({forceBottom: firstLoad && !$('search').value});
    if (added && !firstLoad && !following && !$('search').value) $('latest').hidden = false;
    if (!online) notice('');
    online = true;
    $('connection').textContent = 'Синхронизировано'; $('retry').hidden = true;
  } catch (error) {
    online = false; $('connection').textContent = 'Нет соединения';
    $('retry').hidden = $('workspace').hidden;
    notice(errorMessage(error));
  } finally { loading = false; }
}
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; notice('');
  try { await api('login', 'POST', {password: $('password').value}); $('password').value = ''; session(true); await sync(); }
  catch (error) { notice(errorMessage(error)); }
  finally { button.disabled = false; }
};
$('compose').onsubmit = async event => {
  event.preventDefault(); const button = $('compose').querySelector('button');
  if (button.disabled || !$('text').value.trim()) return;
  button.disabled = true; button.classList.add('sending'); button.setAttribute('aria-label', 'Отправляем сообщение'); notice('');
  const text = $('text').value;
  try {
    const saved = await api('notes', 'POST', {text});
    generation++; // Ignore a poll that began before this message was saved.
    notes = [saved, ...notes.filter(note => note.id !== saved.id)];
    if ($('text').value === text) $('text').value = '';
    $('search').value = '';
    resizeInput();
    render({forceBottom: true});
    $('text').focus({preventScroll: true});
    await sync();
  } catch (error) { notice(errorMessage(error)); }
  finally { button.classList.remove('sending'); button.setAttribute('aria-label', 'Отправить сообщение'); resizeInput(); }
};
$('text').onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose').requestSubmit(); } };
$('logout').onclick = async () => {
  try { await api('logout', 'POST'); session(false); notice(''); $('password').focus(); }
  catch (error) { notice(errorMessage(error)); }
};
$('search').oninput = () => render({searchChanged: true});
$('retry').onclick = async () => { notice(''); await start(); };
async function start() {
  try { const data = await api('session'); session(data.authenticated); $('retry').hidden = true; if (data.authenticated) await sync(); }
  catch (error) { session(false); notice(errorMessage(error)); $('retry').hidden = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', sync);
setInterval(() => { if (!document.hidden) sync(); }, 3000);
start();
