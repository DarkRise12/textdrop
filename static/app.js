'use strict';
const $ = id => document.getElementById(id);
let notes = [], loading = false, generation = 0, online = false;
const notice = message => { $('notice').textContent = message; $('notice').hidden = !message; };
function session(active) {
  generation++;
  $('login').hidden = active;
  $('workspace').hidden = !active;
  $('logout').hidden = !active;
  if (!active) { online = false; notes = []; $('notes').replaceChildren(); $('text').value = ''; }
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
function render() {
  const query = $('search').value.toLocaleLowerCase();
  const filtered = notes.filter(n => n.text.toLocaleLowerCase().includes(query));
  $('count').textContent = notes.length;
  $('empty').hidden = notes.length > 0;
  $('no-results').hidden = !notes.length || filtered.length > 0;
  const fragment = document.createDocumentFragment();
  for (const note of filtered) {
    const article = document.createElement('article'); article.className = 'note';
    const meta = document.createElement('div'); meta.className = 'note-meta';
    const time = document.createElement('time'); time.dateTime = new Date(note.created).toISOString();
    time.textContent = new Intl.DateTimeFormat('ru', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', year:'numeric'}).format(note.created);
    const actions = document.createElement('div'); actions.className = 'note-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet'; copy.textContent = 'Копировать';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(note.text); copy.textContent = 'Скопировано'; setTimeout(() => { copy.textContent = 'Копировать'; }, 1800); }
      catch { notice('Не удалось скопировать. Выдели текст и скопируй вручную. Для кнопки нужен HTTPS.'); }
    };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Удалить';
    remove.onclick = () => {
      const dialog = $('delete-dialog'); dialog.returnValue = ''; dialog.showModal();
      dialog.onclose = async () => {
        if (dialog.returnValue !== 'delete') return;
        remove.disabled = true;
        try { await api('notes/' + note.id, 'DELETE'); notice(''); await sync(); }
        catch (error) { notice(errorMessage(error)); remove.disabled = false; }
      };
    };
    actions.append(copy, remove); meta.append(time, actions);
    const text = document.createElement('pre'); text.className = 'note-text'; text.textContent = note.text;
    article.append(meta, text); fragment.append(article);
  }
  $('notes').replaceChildren(fragment);
}
async function sync() {
  if ($('workspace').hidden || loading) return;
  loading = true;
  const current = generation;
  try {
    const data = await api('notes');
    if (generation !== current) return;
    const changed = JSON.stringify(notes) !== JSON.stringify(data);
    notes = data;
    if (changed || !online) render();
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
  try { await api('login', 'POST', {password: $('password').value}); $('password').value = ''; session(true); await sync(); $('text').focus(); }
  catch (error) { notice(errorMessage(error)); }
  finally { button.disabled = false; }
};
$('compose').onsubmit = async event => {
  event.preventDefault(); const button = $('compose').querySelector('button');
  if (button.disabled || !$('text').value.trim()) return;
  button.disabled = true; button.textContent = 'Сохраняем…'; notice('');
  const text = $('text').value;
  try {
    await api('notes', 'POST', {text});
    if ($('text').value === text) $('text').value = '';
    await sync(); $('text').focus();
  } catch (error) { notice(errorMessage(error)); }
  finally { button.disabled = false; button.textContent = 'Сохранить ↑'; }
};
$('text').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose').requestSubmit(); } };
$('logout').onclick = async () => {
  try { await api('logout', 'POST'); session(false); notice(''); $('password').focus(); }
  catch (error) { notice(errorMessage(error)); }
};
$('search').oninput = render;
$('retry').onclick = async () => { notice(''); await start(); };
async function start() {
  try { const data = await api('session'); session(data.authenticated); $('retry').hidden = true; if (data.authenticated) await sync(); }
  catch (error) { notice(errorMessage(error)); $('retry').hidden = false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', sync);
setInterval(() => { if (!document.hidden) sync(); }, 3000);
start();
