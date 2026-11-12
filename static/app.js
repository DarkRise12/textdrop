'use strict';
const $ = id => document.getElementById(id);
let notes = [], loading = false, generation = 0, online = false;
let editor = null;
let view = 'chat', syncAgain = false, viewLoaded = false;
let noticeKind = '';
const notice = (message, kind = '') => {
  noticeKind = kind;
  $('notice').classList.toggle('success', kind === 'success');
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('login-feedback').textContent = message;
  $('login-feedback').hidden = !message || $('login').hidden;
};
let draftStore, draftReady = false, pendingSend = null;
function draftStatus(text, error = false) {
  if ($('draft-status').textContent !== text) $('draft-status').textContent = text;
  $('draft-status').hidden = !text;
  $('draft-status').classList.toggle('error', error);
}
function saveDraft() {
  if (!draftReady) return;
  try {
    draftStore.save($('text').value, pendingSend);
    draftStatus($('text').value ? 'Черновик сохранён на этом устройстве' : '');
  } catch {
    draftStatus('Не удалось сохранить черновик на устройстве. Не закрывай вкладку.', true);
  }
}
function restoreDraft() {
  draftReady = true;
  try {
    draftStore = new window.TextdropDraft(localStorage);
    const draft = draftStore.load();
    if (draft) {
      $('text').value = draft.text;
      pendingSend = draft.pending || null;
      draftStatus(draft.text ? 'Черновик восстановлен' : '');
    }
  } catch { draftStatus('Хранилище браузера недоступно. Черновик сохранится только в этой вкладке.', true); }
}
function requestId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
}
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
$('text').oninput = () => { resizeInput(); saveDraft(); };
window.addEventListener('pagehide', saveDraft);
if (window.visualViewport) {
  const fitViewport = () => {
    document.documentElement.style.setProperty('--app-height', window.visualViewport.height + 'px');
    requestAnimationFrame(resizeInput);
  };
  window.visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}
function session(active) {
  generation++;
  $('login').hidden = active;
  $('workspace').hidden = !active;
  $('logout').hidden = !active;
  $('login-retry').hidden = true;
  if (!active) setConnection('Требуется вход', 'auth');
  $('login-feedback').hidden = active || !$('login-feedback').textContent;
  if (active) {
    if (!draftReady) restoreDraft();
    requestAnimationFrame(resizeInput);
  }
  if (!active && $('delete-dialog').open) $('delete-dialog').close('cancel');
  if (!active) { online = false; viewLoaded = false; notes = []; $('notes').replaceChildren(); $('latest').hidden = true; }
}
function apiError(message, status, kind) {
  return Object.assign(new Error(message), {status, kind});
}
function isNote(value) {
  return value && typeof value.id === 'string' && typeof value.text === 'string' && Number.isFinite(value.created) && !Number.isNaN(new Date(value.created).getTime());
}
async function api(path, method = 'GET', body) {
  const requestedAt = generation;
  let response;
  try {
    response = await fetch('/api/' + path, {
      method, headers: body ? {'Content-Type': 'application/json'} : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw apiError('Сервер не ответил вовремя. Попробуй снова.', 0, 'timeout');
    }
    throw apiError('Нет связи с сервером. Проверь подключение и попробуй снова.', 0, 'network');
  }
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const kind = response.status === 401 ? 'auth' : response.status >= 500 ? 'server' : 'request';
    if (response.status === 401 && path !== 'login' && requestedAt === generation) {
      session(false);
      notice('Сессия завершилась. Войди снова — черновик сохранён.', 'auth');
    }
    const fallback = response.status >= 500
      ? 'Сервер временно недоступен. Повтори попытку чуть позже.'
      : response.status === 401 ? 'Войди, чтобы продолжить.' : 'Не удалось выполнить действие. Попробуй снова.';
    const error = apiError(typeof data?.error === 'string' ? data.error : fallback, response.status, kind);
    if (isNote(data?.current) && Number.isInteger(data.current.version)) error.current = data.current;
    throw error;
  }
  const valid = path === 'session' ? typeof data?.authenticated === 'boolean'
    : path === 'notes' && method === 'GET' ? Array.isArray(data) && data.every(isNote)
    : path === 'trash' && method === 'GET' ? Array.isArray(data) && data.every(note => isNote(note) && Number.isFinite(note.deleted) && !Number.isNaN(new Date(note.deleted).getTime()) && Number.isFinite(note.expires) && !Number.isNaN(new Date(note.expires).getTime()))
    : path.startsWith('trash/') && method === 'POST' ? isNote(data)
    : path === 'notes' && method === 'POST' ? isNote(data)
    : path.startsWith('notes/') && method === 'PATCH' ? isNote(data) && Number.isInteger(data.version)
    : data?.ok === true;
  if (!valid) throw apiError('Сервер вернул некорректный ответ. Попробуй снова чуть позже.', response.status, 'protocol');
  return data;
}
function errorMessage(error) {
  return error.message || 'Не удалось выполнить действие. Попробуй снова.';
}
function setConnection(message, state = 'loading') {
  $('connection').textContent = message;
  $('connection').title = message;
  $('connection').dataset.state = state;
}
const mobileLayout = matchMedia('(max-width: 600px)');
function setSearchOpen(open, focus = false) {
  $('workspace-toolbar').classList.toggle('search-open', open);
  $('search-toggle').setAttribute('aria-expanded', String(open));
  $('search-toggle').setAttribute('aria-label', open ? 'Закрыть поиск' : 'Открыть поиск');
  if (!open && $('search').value) { $('search').value = ''; render({searchChanged: true}); }
  if (focus) (open ? $('search') : $('search-toggle')).focus({preventScroll: true});
}
$('search-toggle').onclick = () => setSearchOpen($('search-toggle').getAttribute('aria-expanded') !== 'true', true);
$('search').onkeydown = event => {
  if (event.key === 'Escape' && mobileLayout.matches) { event.preventDefault(); setSearchOpen(false, true); }
};
mobileLayout.addEventListener('change', event => {
  if (event.matches) setSearchOpen(Boolean($('search').value) || document.activeElement === $('search'));
});
setConnection($('connection').textContent);
function configureView() {
  const inTrash = view === 'trash';
  setSearchOpen(false);
  $('workspace').dataset.view = view;
  $('workspace').setAttribute('aria-label', inTrash ? 'Корзина сообщений' : 'Личный чат');
  $('history').setAttribute('aria-label', inTrash ? 'Удалённые сообщения' : 'История сообщений');
  $('count-label').textContent = inTrash ? 'В корзине:' : 'Всего сообщений:';
  $('view-chat').setAttribute('aria-pressed', String(!inTrash));
  $('view-trash').setAttribute('aria-pressed', String(inTrash));
  $('compose-controls').hidden = inTrash;
  $('trash-hint').hidden = !inTrash;
  if (!inTrash) requestAnimationFrame(resizeInput);
  $('empty').querySelector('h2').textContent = inTrash ? 'Корзина пуста' : 'Чат с собой';
  $('empty').querySelector('p').textContent = inTrash ? 'Удалённые сообщения появятся здесь. Их можно восстановить в течение 30 дней.' : 'Отправь текст здесь. Он будет под рукой на любом устройстве.';
  $('empty').querySelector('.empty-mark').hidden = inTrash;
}
function switchView(next) {
  if (view === next) return;
  if (editor) { notice('Сохрани или отмени правки перед переходом в другой раздел.', 'edit'); editor.field.focus(); return; }
  generation++;
  view = next;
  viewLoaded = false;
  notes = [];
  online = false;
  $('search').value = '';
  $('latest').hidden = true;
  setConnection('Загружаем…');
  notice('');
  configureView(); render({searchChanged: true});
  sync();
}
$('view-chat').onclick = () => switchView('chat');
$('view-trash').onclick = () => switchView('trash');
async function restoreMessage(note, button) {
  const from = view;
  button.disabled = true;
  try {
    await api('trash/' + note.id + '/restore', 'POST', {});
    generation++;
    if (view === from && !$('workspace').hidden) {
      notes = notes.filter(item => item.id !== note.id); render();
      notice('Сообщение восстановлено в чат.', 'success');
    }
    await sync();
  } catch (error) { notice(errorMessage(error)); button.disabled = false; sync(); }
}
function confirmRemoval(note, permanent, button) {
  const from = view;
  const dialog = $('delete-dialog');
  dialog.querySelector('h2').textContent = permanent ? 'Удалить сообщение навсегда?' : 'Переместить сообщение в корзину?';
  dialog.querySelector('p').textContent = permanent ? 'Оно будет удалено окончательно. Восстановить его не получится.' : 'Сообщение исчезнет из чата. Его можно восстановить в течение 30 дней.';
  dialog.querySelector('button[value="delete"]').textContent = permanent ? 'Удалить навсегда' : 'В корзину';
  dialog.returnValue = ''; dialog.showModal();
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'delete') return;
    button.disabled = true;
    try {
      await api((permanent ? 'trash/' : 'notes/') + note.id, 'DELETE');
      generation++;
      if (view === from && !$('workspace').hidden) {
        notes = notes.filter(item => item.id !== note.id); render();
        notice(permanent ? 'Сообщение удалено окончательно.' : 'Сообщение перемещено в корзину на 30 дней.', 'success');
      }
      await sync();
    } catch (error) { notice(errorMessage(error)); sync(); }
    finally { button.disabled = false; }
  };
}
function focusMessageAction(id) {
  const item = [...$('notes').querySelectorAll('.note')].find(note => note.dataset.id === id);
  item?.querySelector('[data-action="edit"]')?.focus({preventScroll: true});
}
function beginEdit(note) {
  if (editor) {
    if (editor.id !== note.id) notice('Сохрани или отмени текущие правки перед редактированием другого сообщения.', 'edit');
    editor.field.focus();
    return;
  }
  notice('');
  editor = new window.TextdropEditor(note, {
    api,
    onSaved(saved, state) {
      if (editor !== state) return;
      generation++;
      notes = notes.map(note => note.id === saved.id ? saved : note);
      editor = null;
      if (noticeKind === 'edit') notice('');
      render(); focusMessageAction(saved.id);
      sync();
    },
    onCancel(state) {
      if (editor === state) {
        editor = null;
        if (noticeKind === 'edit') notice('');
        render(); focusMessageAction(state.id);
      }
    },
    onConflict(current) {
      generation++;
      notes = notes.map(note => note.id === current.id ? current : note);
      render();
    },
    onGone(id) { generation++; notes = notes.filter(note => note.id !== id); render(); }
  });
  render();
  editor.field.focus({preventScroll: true});
  editor.element.scrollIntoView({block: 'nearest'});
}
const actionPaths = {
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  edit: 'M4 16v4h4L20 8l-4-4L4 16ZM14 6l4 4',
  delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
  restore: 'M4 10a8 8 0 1 1 0 6M4 4v6h6'
};
function actionLabel(button, label) {
  let text = button.querySelector('.action-label');
  if (!text) {
    text = document.createElement('span'); text.className = 'action-label';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.classList.add('action-icon');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); icon.append(shape);
    button.replaceChildren(icon, text);
  }
  text.textContent = label; button.setAttribute('aria-label', label); button.title = label;
  button.querySelector('path').setAttribute('d', label === 'Скопировано' ? 'm5 12 4 4 10-10' : actionPaths[button.dataset.action]);
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
  const selection = focusAction === 'edit-text' ? [focused.selectionStart, focused.selectionEnd] : null;
  const query = $('search').value.toLocaleLowerCase();
  const visible = notes.slice();
  if (editor && !visible.some(note => note.id === editor.id)) visible.push(editor.note);
  let filtered = visible.filter(n => n.id === editor?.id || n.text.toLocaleLowerCase().includes(query));
  filtered = view === 'trash' ? filtered.sort((a, b) => b.deleted - a.deleted) : filtered.sort((a, b) => b.created - a.created).reverse();
  $('count').textContent = notes.length;
  $('empty').hidden = !viewLoaded || notes.length > 0 || !!editor;
  $('no-results').hidden = !notes.length || filtered.length > 0;
  const fragment = document.createDocumentFragment();
  let previousDay = '';
  for (const note of filtered) {
    const date = new Date(view === 'trash' ? note.deleted : note.created);
    const day = date.toLocaleDateString('ru');
    if (day !== previousDay) {
      const divider = document.createElement('div'); divider.className = 'day-divider';
      divider.textContent = (view === 'trash' ? 'Удалено ' : '') + date.toLocaleDateString('ru', {day: 'numeric', month: 'long', year: 'numeric'});
      fragment.append(divider); previousDay = day;
    }
    const article = document.createElement('article'); article.className = 'note'; article.dataset.id = note.id;
    const meta = document.createElement('div'); meta.className = 'note-meta';
    const time = document.createElement('time'); time.dateTime = date.toISOString();
    time.textContent = new Intl.DateTimeFormat('ru', {hour:'2-digit', minute:'2-digit'}).format(date);
    time.title = date.toLocaleString('ru');
    const edited = document.createElement('span'); edited.className = 'edited-mark';
    edited.textContent = note.updated && view === 'chat' ? ' · изменено' : '';
    if (note.updated) edited.title = 'Изменено ' + new Date(note.updated).toLocaleString('ru');
    time.append(edited);
    const actions = document.createElement('div'); actions.className = 'note-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet'; copy.textContent = 'Копировать'; copy.dataset.action = 'copy';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(note.text); actionLabel(copy, 'Скопировано'); setTimeout(() => { actionLabel(copy, 'Копировать'); }, 1800); }
      catch { notice('Не удалось скопировать. Выдели текст и скопируй вручную. Для кнопки нужен HTTPS.'); }
    };
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Удалить'; remove.dataset.action = 'delete';
    remove.textContent = view === 'trash' ? 'Удалить навсегда' : 'Удалить';
    remove.onclick = () => confirmRemoval(note, view === 'trash', remove);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'quiet';
    edit.textContent = 'Изменить'; edit.dataset.action = 'edit'; edit.onclick = () => beginEdit(note);
    if (view === 'trash') {
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet';
      restore.textContent = 'Восстановить'; restore.dataset.action = 'restore';
      restore.onclick = () => restoreMessage(note, restore);
      actionLabel(copy, 'Копировать'); actionLabel(restore, 'Восстановить'); actionLabel(remove, 'Удалить навсегда');
      actions.append(copy, restore, remove);
      const expires = document.createElement('span'); expires.className = 'trash-expiry';
      expires.textContent = 'Удалится ' + new Date(note.expires).toLocaleString('ru', {day:'numeric', month:'long', hour:'2-digit', minute:'2-digit'});
      meta.append(expires, actions);
    } else {
      actionLabel(copy, 'Копировать'); actionLabel(edit, 'Изменить'); actionLabel(remove, 'Удалить');
      actions.append(copy, edit, remove); meta.append(time, actions);
    }
    const text = document.createElement('pre'); text.className = 'note-text'; window.TextdropLinks.append(text, note.text);
    if (editor?.id === note.id) {
      article.classList.add('note-editing');
      actions.hidden = true;
      article.append(editor.element, meta);
    } else article.append(text, meta);
    fragment.append(article);
  }
  $('notes').replaceChildren(fragment);
  if (view === 'trash') { history.scrollTop = searchChanged ? 0 : previousTop; $('latest').hidden = true; }
  else if (forceBottom || (!searchChanged && nearBottom)) latest();
  else if (searchChanged) { history.scrollTop = query ? 0 : history.scrollHeight; $('latest').hidden = true; }
  else {
    const restored = [...$('notes').querySelectorAll('.note')].find(item => item.dataset.id === anchorId);
    history.scrollTop = restored ? previousTop + restored.getBoundingClientRect().top - anchorTop : previousTop;
  }
  if (focusId && focusAction) {
    const item = [...$('notes').querySelectorAll('.note')].find(node => node.dataset.id === focusId);
    const target = item?.querySelector(`[data-action="${focusAction}"]`);
    target?.focus({preventScroll: true});
    if (selection && target) target.setSelectionRange(...selection);
  }
}
async function sync() {
  if ($('workspace').hidden) return;
  if (loading) { syncAgain = true; return; }
  loading = true;
  const current = generation;
  try {
    const data = await api(view === 'trash' ? 'trash' : 'notes');
    if (generation !== current) return;
    const changed = JSON.stringify(notes) !== JSON.stringify(data);
    const firstLoad = !online && !notes.length;
    const previousIds = new Set(notes.map(note => note.id));
    const added = data.some(note => !previousIds.has(note.id));
    const following = $('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 80;
    notes = data;
    viewLoaded = true;
    if (view === 'chat') editor?.reconcile(data);
    if (changed || !online) render({forceBottom: firstLoad && !$('search').value});
    if (view === 'chat' && added && !firstLoad && !following && !$('search').value) $('latest').hidden = false;
    if (noticeKind === 'sync' || noticeKind === 'start') notice('');
    online = true;
    setConnection('Синхронизировано', 'ready'); $('retry').hidden = true;
  } catch (error) {
    if (current !== generation) return;
    online = false;
    setConnection(error.kind === 'server' ? 'Сервер недоступен'
      : error.kind === 'protocol' ? 'Ошибка ответа сервера'
      : error.kind === 'timeout' ? 'Сервер не отвечает' : 'Нет соединения', 'error');
    $('retry').hidden = $('workspace').hidden;
    notice(errorMessage(error), 'sync');
  } finally { loading = false; if (syncAgain) { syncAgain = false; sync(); } }
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
  if (!pendingSend || pendingSend.text !== text) pendingSend = {text, id: requestId()};
  const sending = pendingSend;
  saveDraft(); // Persist the retry identifier before the request can reach the server.
  try {
    const saved = await api('notes', 'POST', {text, request_id: sending.id});
    if (pendingSend === sending) pendingSend = null;
    generation++; // Ignore a poll that began before this message was saved.
    if (view === 'chat') notes = [saved, ...notes.filter(note => note.id !== saved.id)];
    if ($('text').value === text) $('text').value = '';
    saveDraft();
    resizeInput();
    if (view === 'chat' && !$('workspace').hidden) {
      $('search').value = ''; setSearchOpen(false); render({forceBottom: true});
      $('text').focus({preventScroll: true});
    }
    await sync();
  } catch (error) {
    if ([409, 410].includes(error.status) && pendingSend === sending) pendingSend = null;
    saveDraft();
    notice(errorMessage(error));
  }
  finally { button.classList.remove('sending'); button.setAttribute('aria-label', 'Отправить сообщение'); resizeInput(); }
};
$('text').onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose').requestSubmit(); } };
$('logout').onclick = async () => {
  try {
    await api('logout', 'POST');
    if (editor) editor.closed = true;
    editor = null;
    pendingSend = null; $('text').value = '';
    let cleared = true;
    try { draftStore?.clear(); } catch { cleared = false; }
    draftStatus(''); session(false);
    notice(cleared ? '' : 'Вы вышли, но очистить черновик не удалось. Удалите данные сайта в настройках браузера.');
    $('password').focus();
  }
  catch (error) { notice(errorMessage(error)); }
};
$('search').oninput = () => render({searchChanged: true});
async function retryConnection(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try { if ($('workspace').hidden) await start(); else await sync(); }
  finally { button.disabled = false; }
}
$('retry').onclick = retryConnection;
$('login-retry').onclick = retryConnection;
async function start() {
  const current = generation;
  try {
    const data = await api('session');
    if (current !== generation) return;
    if (noticeKind === 'start') notice('');
    session(data.authenticated); $('retry').hidden = true;
    if (data.authenticated) await sync();
  } catch (error) {
    if (current !== generation) return;
    session(false); notice(errorMessage(error), 'start');
    $('login-retry').hidden = false;
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => { if ($('workspace').hidden) start(); else sync(); });
setInterval(() => { if (!document.hidden) sync(); }, 3000);
start();
