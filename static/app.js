'use strict';
const $ = id => document.getElementById(id);
let notes = [], loading = false, generation = 0, online = false;
let editor = null;
let sessionEpoch = 0, currentUser = null, startupAttempt = 0, startupLoading = false;
let view = 'chat', syncAgain = false, viewLoaded = false;
let noticeKind = '';
let categoryUI;
let currentQuery = '', searchTimer = null, feedAbort = null;
let nextPage = null, feedRevision = null, totalNotes = 0, matchedNotes = 0, loadedThrough = null;
let olderLoading = false, lastHistoryScroll = 0;
let selectedFiles = [], choosingFiles = false, pendingFileSend = null, uploadRequest = null, storageState = null;
const expandedSearchMessages = new Set();
const expandedMessages = new Set(), messagePreviewCache = new Map();
const notice = (message, kind = '') => {
  noticeKind = kind;
  $('notice').classList.toggle('success', kind === 'success');
  if ($('notice').textContent !== message) $('notice').textContent = message;
  $('notice').hidden = !message;
  if ($('login-feedback').textContent !== message) $('login-feedback').textContent = message;
  $('login-feedback').hidden = !message || $('login').hidden;
};
let draftStore, draftReady = false, pendingSend = null;
function draftStatus(text, error = false) {
  if ($('draft-status').textContent !== text) $('draft-status').textContent = text;
  $('draft-status').hidden = !text;
  $('draft-status').classList.toggle('error', error);
}
function saveDraft() {
  if (!draftReady) return true;
  try {
    draftStore.save($('text').value, pendingSend, pendingFileSend);
    draftStatus(pendingFileSend && !selectedFiles.length ? 'Для повтора выбери ' + (pendingFileSend.files?.length > 1 ? 'файлы (' + pendingFileSend.files.length + ')' : 'файл: ' + pendingFileSend.name) : $('text').value ? 'Черновик сохранён на этом устройстве' : '');
    return true;
  } catch {
    draftStatus('Не удалось сохранить черновик на устройстве. Не закрывай вкладку.', true);
    return false;
  }
}
function restoreDraft() {
  draftReady = true;
  try {
    draftStore = new window.TextdropDraft(localStorage, () => Date.now(), currentUser.id);
    const draft = draftStore.load();
    if (draft) {
      $('text').value = draft.text;
      pendingSend = draft.pending || null;
      pendingFileSend = draft.filePending || null;
      draftStatus(pendingFileSend ? 'Для повтора выбери ' + (pendingFileSend.files?.length > 1 ? 'файлы (' + pendingFileSend.files.length + ')' : 'файл: ' + pendingFileSend.name) : draft.text ? 'Черновик восстановлен' : '');
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
  $('send').disabled = choosingFiles || $('send').classList.contains('sending') || (!$('text').value.trim() && !selectedFiles.length);
  $('text').required = !selectedFiles.length;
  $('text').style.height = 'auto';
  $('text').style.height = Math.min($('text').scrollHeight, 180) + 'px';
}
function latest() {
  $('history').scrollTop = $('history').scrollHeight;
  $('latest').hidden = true;
  lastHistoryScroll = $('history').scrollTop;
}
$('latest').onclick = latest;
$('history').onscroll = () => {
  const history = $('history');
  const bottom = history.scrollHeight - history.scrollTop - history.clientHeight;
  if (bottom < 80) $('latest').hidden = true;
  const towardOlder = view === 'chat' ? history.scrollTop < lastHistoryScroll : history.scrollTop > lastHistoryScroll;
  lastHistoryScroll = history.scrollTop;
  if (towardOlder && (view === 'chat' ? history.scrollTop < 100 : bottom < 100)) loadOlder();
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
function session(active, user = currentUser) {
  $('offline-start').hidden = true;
  resetPasswordVisibility();
  choosingFiles = false; $('attach').disabled = false;
  if (active) {
    if (!isUser(user)) throw Error('Не удалось определить учётную запись. Обнови страницу.');
    if (currentUser?.id !== user.id) {
      saveDraft();
      if (editor) editor.closed = true;
      editor = null; selectedFiles = []; pendingFileSend = null; pendingSend = null;
      $('text').value = ''; draftStatus(''); draftReady = false;
      categoryUI?.reset();
      currentQuery = ''; $('search').value = ''; view = 'chat'; storageState = null;
      $('workspace').dataset.view = view;
      $('view-chat').setAttribute('aria-pressed', 'true');
      $('view-trash').setAttribute('aria-pressed', 'false');
      $('compose-controls').hidden = false; $('trash-hint').hidden = true;
      clearFeedState(); notes = []; viewLoaded = false; $('notes').replaceChildren();
      expandedMessages.clear(); expandedSearchMessages.clear(); messagePreviewCache.clear(); updateAttachment();
    }
    currentUser = user;
    $('account-label').textContent = user.username;
    $('account-button').setAttribute('aria-label', 'Учётная запись ' + user.username);
    $('username').value = user.username;
    try { localStorage.setItem('textdrop-username-v1', user.username); } catch {}
  }
  $('account-button').hidden = !active;
  if (!active) categoryUI?.reset();
  if (!active && $('account-dialog').open) $('account-dialog').close();
  sessionEpoch++;
  uploadRequest?.abort();
  $('send').classList.remove('sending');
  $('send').setAttribute('aria-label', 'Отправить сообщение');
  resizeInput();
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
  if (!active && $('image-viewer').open) closeImageViewer();
  if (!active && $('delete-dialog').open) $('delete-dialog').close('cancel');
  if (!active) { clearFeedState(); expandedMessages.clear(); expandedSearchMessages.clear(); messagePreviewCache.clear(); online = false; viewLoaded = false; notes = []; $('notes').replaceChildren(); $('latest').hidden = true; }
}
function apiError(message, status, kind) {
  return Object.assign(new Error(message), {status, kind});
}
function isUser(value) {
  return value && /^(owner|[a-f0-9]{32})$/.test(value.id) && typeof value.username === 'string' && ['admin', 'user'].includes(value.role);
}
function filesForNote(note) {
  return note.files || (note.file ? [{id: note.id, ...note.file}] : []);
}
function isFile(value) {
  return value && typeof value.name === 'string' && Number.isSafeInteger(value.size) && value.size >= 0 && /^[a-f0-9]{64}$/.test(value.sha256);
}
function isNote(value) {
  return value && (!value.file || isFile(value.file)) && (!value.files || Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= 10 && value.files.every(file => isFile(file) && /^[a-f0-9]{32}$/.test(file.id))) && typeof value.id === 'string' && typeof value.text === 'string' && Number.isFinite(value.created) && !Number.isNaN(new Date(value.created).getTime());
}
async function api(path, method = 'GET', body, signal) {
  const requestedAt = generation;
  let response;
  try {
    response = await fetch('/api/' + path, {
      method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(currentUser && !['session', 'login'].includes(path) ? {'X-Textdrop-User': currentUser.id} : {})},
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
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
    if ((response.status === 401 || data?.account_changed) && path !== 'login' && requestedAt === generation) {
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
  const route = path.split('?')[0];
  const feedRoute = /^(notes|trash)\/(page|changes)$/.test(route);
  const counters = data && Number.isSafeInteger(data.total) && data.total >= 0
    && Number.isSafeInteger(data.matched) && data.matched >= 0 && data.matched <= data.total
    && Number.isSafeInteger(data.revision) && data.revision >= 0;
  const records = Array.isArray(data?.items) && data.items.length <= 100 && data.items.every(note => isNote(note)
    && (!route.startsWith('trash/') || (Number.isFinite(note.deleted) && Number.isFinite(note.expires))));
  const valid = feedRoute ? (route.endsWith('/changes') && data?.reset === true) || counters && records
    && (route.endsWith('/page') ? data.next === null || typeof data.next === 'string'
      : typeof data.has_more === 'boolean' && Array.isArray(data.removed) && data.removed.every(id => typeof id === 'string')
        && data.items.every(note => typeof note.matches === 'boolean'))
    : /^notes\/[^/]+$/.test(route) && method === 'GET' ? isNote(data)
    : route === 'storage' ? Number.isSafeInteger(data?.used_bytes) && Number.isSafeInteger(data?.max_file_bytes) && Number.isSafeInteger(data?.max_storage_bytes)
    : route === 'users' && method === 'GET' ? Array.isArray(data?.users) && data.users.every(user => typeof user.id === 'string' && typeof user.username === 'string')
    : path === 'login' ? data?.ok === true && isUser(data.user)
    : path === 'session' ? typeof data?.authenticated === 'boolean' && (!data.authenticated || isUser(data.user))
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
function setSearchOpen(open, focus = false) {
  $('workspace-toolbar').classList.toggle('search-open', open);
  $('search-toggle').setAttribute('aria-expanded', String(open));
  $('search-toggle').setAttribute('aria-label', open ? 'Закрыть поиск' : 'Открыть поиск');
  if (!open && $('search').value) { $('search').value = ''; changeSearch(''); }
  if (focus) (open ? $('search') : $('search-toggle')).focus({preventScroll: true});
}
$('search-toggle').onclick = () => setSearchOpen($('search-toggle').getAttribute('aria-expanded') !== 'true', true);
$('search').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false, true); }
};
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
  currentQuery = ''; clearFeedState();
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
  const count = filesForNote(note).length;
  if (count > 1) dialog.querySelector('p').textContent += ' Вместе с ним — все вложения (' + count + ').';
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
// Measure real wrapped lines at the current width; keep only visible text in the DOM.
function mountMessagePreview(article, text, note, searching) {
  text.id = 'message-text-' + note.id;
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'message-toggle'; toggle.dataset.action = 'toggle-text';
  toggle.setAttribute('aria-controls', text.id); text.after(toggle);
  const query = searching ? currentQuery : '';
  const choices = searching ? expandedSearchMessages : expandedMessages;
  function update() {
    article.classList.add('note-collapsible');
    const width = text.getBoundingClientRect().width;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    let cached = messagePreviewCache.get(note.id);
    if (!cached || cached.text !== note.text || cached.width !== width || cached.lineHeight !== lineHeight || cached.query !== query) {
      const match = query ? window.TextdropLinks.ranges(note.text, query, 1)[0] : null;
      let start = match ? Math.max(0, match.start - 70) : 0;
      if (/[\uDC00-\uDFFF]/u.test(note.text[start] || '')) start--;
      function fit(from) {
        const end = match ? Math.min(note.text.length, Math.max(from + 360, match.end + 70)) : note.text.length;
        const source = note.text.slice(from, end);
        const display = length => (from ? '…' : '') + source.slice(0, length).trimEnd() + (from + length < note.text.length ? '…' : '');
        const limit = lineHeight * 6 + 1;
        text.textContent = display(source.length);
        let length = source.length;
        if (text.getBoundingClientRect().height > limit) {
          let low = 0, high = length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2); text.textContent = display(middle);
            if (text.getBoundingClientRect().height <= limit) low = middle;
            else high = middle - 1;
          }
          length = source.slice(0, low).trimEnd().length;
        }
        if (/[\uD800-\uDBFF]/u.test(source[length - 1] || '')) length--;
        return {text: note.text, width, lineHeight, query, start: from, end: from + length};
      }
      cached = fit(start);
      // Whitespace or large text can consume the preview before the match.
      if (match && cached.end <= match.start) cached = fit(match.start);
      messagePreviewCache.set(note.id, cached);
    }
    const long = cached.start > 0 || cached.end < note.text.length;
    const expanded = choices.has(note.id);
    article.classList.toggle('note-collapsible', long);
    toggle.hidden = !long;
    toggle.textContent = expanded ? 'Свернуть' : searching ? 'Показать полностью' : 'Развернуть';
    toggle.setAttribute('aria-expanded', String(expanded));
    window.TextdropLinks.append(text, note.text, expanded ? note.text.length : cached.end, {start: expanded ? 0 : cached.start, query});
  }
  toggle.onclick = () => {
    const history = $('history');
    const top = Math.max(0, article.getBoundingClientRect().top - history.getBoundingClientRect().top);
    if (choices.has(note.id)) choices.delete(note.id); else choices.add(note.id);
    update();
    history.scrollTop += article.getBoundingClientRect().top - history.getBoundingClientRect().top - top;
  };
  return update;
}

function render({forceBottom = false, searchChanged = false, preserveScroll = false} = {}) {
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
  const query = currentQuery;
  const filtering = Boolean(query || categoryUI?.filter);
  const visible = notes.slice();
  if ($('image-viewer').open && !notes.some(note => note.id === $('image-viewer').dataset.noteId)) closeImageViewer();
  if (editor && !visible.some(note => note.id === editor.id)) visible.push(editor.note);
  const filtered = visible.sort((a, b) => compareNotes(b, a));
  if (view === 'chat') filtered.reverse();
  $('workspace').classList.toggle('has-query', Boolean(query));
  $('search-results-label').hidden = !query;
  $('search-results-label').textContent = viewLoaded ? 'Найдено: ' + matchedNotes : 'Ищем…';
  $('count').textContent = filtering ? matchedNotes : totalNotes;
  $('count').title = 'Найдено: ' + matchedNotes + '. Всего: ' + totalNotes + '. Загружено: ' + notes.length;
  $('count-label').textContent = filtering ? 'Найдено:' : view === 'trash' ? 'В корзине:' : 'Всего сообщений:';
  $('empty').hidden = !viewLoaded || totalNotes > 0 || notes.length > 0 || !!editor;
  $('no-results').hidden = !viewLoaded || !filtering || !totalNotes || matchedNotes > 0 || !!editor;
  updatePageControls();
  const fragment = document.createDocumentFragment();
  const previews = [];
  const knownIds = new Set(visible.map(note => note.id));
  for (const id of messagePreviewCache.keys()) if (!knownIds.has(id)) messagePreviewCache.delete(id);
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
    const text = document.createElement('pre'); text.className = 'note-text';
    const files = filesForNote(note);
    if (files.length) {
      article.classList.add('note-file');
      const group = document.createElement('div'); group.className = 'attachment-files';
      if (files.length > 1) {
        group.classList.add('multiple-files');
        const heading = document.createElement('p'); heading.className = 'files-heading'; heading.textContent = 'Файлы · ' + files.length; article.append(heading);
      }
      for (const file of files) {
        const item = document.createElement('div'); item.className = 'file-item';
        if (file.preview) {
          item.classList.add('file-image');
          const button = document.createElement('button'); button.type = 'button'; button.className = 'image-preview';
          button.dataset.action = 'preview'; button.setAttribute('aria-label', 'Открыть фотографию ' + file.name);
          const image = document.createElement('img'); image.width = 640; image.height = 480;
          image.loading = 'lazy'; image.decoding = 'async'; image.alt = 'Фото: ' + file.name;
          image.src = '/api/files/' + encodeURIComponent(file.id) + '/preview';
          image.onerror = () => { button.remove(); };
          button.append(image); button.onclick = () => showImage(note, file, button); item.append(button);
        }
        const card = document.createElement('a'); card.className = 'file-download';
        card.href = '/api/files/' + encodeURIComponent(file.id); card.setAttribute('download', file.name);
        const name = document.createElement('span'); window.TextdropLinks.highlight(name, file.name, query);
        const detail = document.createElement('span'); detail.className = 'file-detail';
        detail.textContent = formatFileSize(file.size) + ' · Скачать';
        card.append(name, detail); item.append(card); group.append(item);
      }
      article.append(group);
      if (!note.text) copy.hidden = true;
    }
    if (editor?.id === note.id) {
      article.classList.add('note-editing');
      actions.hidden = true;
      article.append(editor.element, meta);
    } else {
      article.append(text, meta);
      previews.push(mountMessagePreview(article, text, note, Boolean(query)));
    }
    categoryUI?.decorate(article, note, actions, view === 'trash');
    fragment.append(article);
  }
  $('notes').replaceChildren(fragment);
  for (const update of previews) update();
  if (view === 'trash' && !preserveScroll) { history.scrollTop = searchChanged ? 0 : previousTop; $('latest').hidden = true; }
  else if (!preserveScroll && (forceBottom || (!searchChanged && nearBottom))) latest();
  else if (searchChanged) { history.scrollTop = query ? 0 : history.scrollHeight; $('latest').hidden = true; }
  else {
    const restored = [...$('notes').querySelectorAll('.note')].find(item => item.dataset.id === anchorId);
    history.scrollTop = restored ? history.scrollTop + restored.getBoundingClientRect().top - anchorTop : previousTop;
  }
  lastHistoryScroll = history.scrollTop;
  if (focusId && focusAction) {
    const item = [...$('notes').querySelectorAll('.note')].find(node => node.dataset.id === focusId);
    const target = item?.querySelector(`[data-action="${focusAction}"]`);
    target?.focus({preventScroll: true});
    if (selection && target) target.setSelectionRange(...selection);
  }
}
let historyWidth = 0;
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (width === historyWidth) return;
  historyWidth = width;
  if (viewLoaded && !$('workspace').hidden) render();
}).observe($('history'));
function compareNotes(a, b) {
  const key = view === 'trash' ? 'deleted' : 'created';
  return a[key] - b[key] || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
}
function clearFeedState() {
  feedAbort?.abort();
  clearTimeout(searchTimer); searchTimer = null;
  nextPage = null; feedRevision = null; loadedThrough = null;
  totalNotes = 0; matchedNotes = 0;
}
function updatePageControls() {
  $('page-controls').hidden = viewLoaded && !nextPage;
  if (!nextPage && document.activeElement === $('load-more')) $('history').focus({preventScroll: true});
  $('load-more').hidden = !nextPage;
  $('load-more').disabled = loading;
  $('load-more').textContent = olderLoading ? 'Загружаем…' : view === 'chat' ? 'Загрузить предыдущие' : 'Загрузить ещё';
  $('page-status').textContent = !viewLoaded ? (currentQuery ? 'Ищем…' : 'Загружаем сообщения…')
    : 'Показано ' + notes.length + ' из ' + matchedNotes;
  const controls = $('page-controls'), content = controls.parentElement;
  if (view === 'trash') { if (content.lastElementChild !== controls) content.append(controls); }
  else if (content.firstElementChild !== controls) content.prepend(controls);
}
function feedPath(kind, cursor) {
  const params = new URLSearchParams({limit: '50', q: currentQuery});
  if (categoryUI?.filter) params.set('category', categoryUI.filter);
  if (kind === 'changes') params.set('since', String(feedRevision));
  else if (cursor) params.set('before', cursor);
  return (view === 'trash' ? 'trash/' : 'notes/') + kind + '?' + params;
}
function changeSearch(query, delay = 0) {
  generation++;
  currentQuery = query.trim(); expandedSearchMessages.clear();
  clearFeedState(); notes = []; viewLoaded = false; online = false;
  $('latest').hidden = true;
  if (noticeKind === 'sync') notice('');
  render({searchChanged: true});
  if (delay) searchTimer = setTimeout(() => { searchTimer = null; sync(); }, delay);
  else sync();
}
function feedError(error) {
  online = false;
  setConnection(error.kind === 'server' ? 'Сервер недоступен'
    : error.kind === 'protocol' ? 'Ошибка ответа сервера'
    : error.kind === 'timeout' ? 'Сервер не отвечает' : 'Нет соединения', 'error');
  $('retry').hidden = $('workspace').hidden;
  notice(navigator.onLine === false ? 'Нет сети. Черновик сохраняется на этом устройстве; отправь его после подключения.' : errorMessage(error), navigator.onLine === false ? 'offline' : 'sync');
}
async function sync() {
  if ($('workspace').hidden || searchTimer) return;
  if (loading) { syncAgain = true; return; }
  loading = true;
  const current = generation;
  feedAbort = new AbortController();
  updatePageControls();
  try {
    if (feedRevision === null) {
      const data = await api(feedPath('page'), 'GET', undefined, feedAbort.signal);
      if (generation !== current) return;
      categoryUI?.accept(data.categories || []);
      if (generation !== current) return;
      // An editor may be outside the page or the new query. Absence is not deletion.
      const watched = editor;
      if (view === 'chat' && watched) {
        let note;
        try { note = await api('notes/' + watched.id, 'GET', undefined, feedAbort.signal); }
        catch (error) { if (error.status !== 404) throw error; }
        if (generation !== current) return;
        if (editor === watched) watched.reconcile(note ? [note] : []);
      }
      notes = data.items; nextPage = data.next; feedRevision = data.revision;
      loadedThrough = data.items.at(-1) || null;
      totalNotes = data.total; matchedNotes = data.matched; viewLoaded = true;
      render({forceBottom: !currentQuery, searchChanged: Boolean(currentQuery)});
    } else {
      // Bound each poll even after a long offline period; the next poll continues it.
      for (let batch = 0; batch < 5; batch++) {
        const data = await api(feedPath('changes'), 'GET', undefined, feedAbort.signal);
        if (generation !== current) return;
        if (data.reset) { changeSearch(currentQuery); return; }
        if (data.revision < feedRevision || (data.has_more && data.revision === feedRevision)) {
          throw apiError('Ошибка версии синхронизации. Повтори подключение.', 200, 'protocol');
        }
        const categoriesChanged = categoryUI?.accept(data.categories || []);
        if (generation !== current) return;
        const previous = JSON.stringify(notes);
        const previousIds = new Set(notes.map(note => note.id));
        const following = $('history').scrollHeight - $('history').scrollTop - $('history').clientHeight < 80;
        if (editor && view === 'chat') {
          const updated = data.items.find(note => note.id === editor.id);
          if (updated) editor.reconcile([updated]);
          else if (data.removed.includes(editor.id)) editor.reconcile([]);
        }
        const merged = new Map(notes.map(note => [note.id, note]));
        for (const id of data.removed) merged.delete(id);
        for (const changed of data.items) {
          const {matches, ...note} = changed;
          if (!matches) merged.delete(note.id);
          else if (merged.has(note.id) || !nextPage || !loadedThrough || compareNotes(note, loadedThrough) >= 0) merged.set(note.id, note);
        }
        notes = [...merged.values()];
        const countersChanged = totalNotes !== data.total || matchedNotes !== data.matched;
        totalNotes = data.total; matchedNotes = data.matched; feedRevision = data.revision;
        if (JSON.stringify(notes) !== previous || countersChanged || categoriesChanged || !online) render();
        if (view === 'chat' && !following && !currentQuery && notes.some(note => !previousIds.has(note.id))) $('latest').hidden = false;
        if (!data.has_more) break;
      }
    }
    if (noticeKind === 'sync' || noticeKind === 'start' || noticeKind === 'offline') notice('');
    online = true;
    setConnection('Синхронизировано', 'ready'); $('retry').hidden = true;
  } catch (error) {
    if (current !== generation) return;
    feedError(error);
  } finally {
    loading = false; feedAbort = null; updatePageControls();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}
async function loadOlder() {
  if (!nextPage || loading || !viewLoaded || $('workspace').hidden) return;
  loading = true; olderLoading = true;
  const current = generation;
  feedAbort = new AbortController(); updatePageControls();
  try {
    const data = await api(feedPath('page', nextPage), 'GET', undefined, feedAbort.signal);
    if (generation !== current) return;
    categoryUI?.accept(data.categories || []);
    if (generation !== current) return;
    // Preserve already loaded records if a mutation happened before this page snapshot.
    const merged = new Map(notes.map(note => [note.id, note]));
    for (const note of data.items) if (!merged.has(note.id)) merged.set(note.id, note);
    notes = [...merged.values()]; nextPage = data.next;
    loadedThrough = data.items.at(-1) || loadedThrough;
    totalNotes = data.total; matchedNotes = data.matched;
    render({preserveScroll: true});
    syncAgain = true;
  } catch (error) {
    if (current !== generation) return;
    feedError(error);
  } finally {
    loading = false; olderLoading = false; feedAbort = null; updatePageControls();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}
$('load-more').onclick = loadOlder;
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; notice('');
  try { const data = await api('login', 'POST', {username: $('username').value, password: $('password').value}); $('password').value = ''; session(true, data.user); await sync(); }
  catch (error) { notice(errorMessage(error)); }
  finally { button.disabled = false; }
};
$('compose').onsubmit = async event => {
  event.preventDefault(); const button = $('send');
  if (button.disabled || (!$('text').value.trim() && !selectedFiles.length)) return;
  button.disabled = true; button.classList.add('sending'); button.setAttribute('aria-label', 'Отправляем сообщение'); notice('');
  const text = $('text').value;
  const epoch = sessionEpoch;
  const files = selectedFiles.slice();
  if (!files.length && (!pendingSend || pendingSend.text !== text)) pendingSend = {text, id: requestId()};
  const sending = pendingSend;
  saveDraft(); // Persist the retry identifier before the request can reach the server.
  try {
    const saved = files.length ? await uploadFiles(files, text) : await api('notes', 'POST', {text, request_id: sending.id});
    if (epoch !== sessionEpoch) return;
    if (files.length && files.every((file, index) => selectedFiles[index] === file)) { selectedFiles = []; pendingFileSend = null; updateAttachment(); }
    if (pendingSend === sending) pendingSend = null;
    generation++; // Ignore a poll that began before this message was saved.
    if (view === 'chat') notes = [saved, ...notes.filter(note => note.id !== saved.id)];
    if ($('text').value === text) $('text').value = '';
    saveDraft();
    resizeInput();
    if (view === 'chat' && !$('workspace').hidden) {
      if (currentQuery || categoryUI.filter) { currentQuery = ''; categoryUI.filter = ''; categoryUI.updateFilter(); clearFeedState(); viewLoaded = false; }
      $('search').value = ''; setSearchOpen(false); render({forceBottom: true});
      $('text').focus({preventScroll: true});
    }
    await sync();
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    if ([409, 410].includes(error.status) && pendingSend === sending) pendingSend = null;
    if (files.length && [409, 410].includes(error.status)) pendingFileSend = null;
    saveDraft();
    notice(errorMessage(error));
  }
  finally { if (epoch === sessionEpoch) { button.classList.remove('sending'); button.setAttribute('aria-label', 'Отправить сообщение'); resizeInput(); } }
};
let imageOpener = null;
function showImage(note, file, opener) {
  imageOpener = opener;
  const viewer = $('image-viewer'); viewer.dataset.noteId = note.id;
  $('image-viewer-title').textContent = file.name;
  $('viewer-image').alt = file.name;
  $('viewer-image').onerror = () => { closeImageViewer(); notice('Предпросмотр недоступен. Оригинал можно скачать из сообщения.'); };
  $('viewer-image').src = '/api/files/' + encodeURIComponent(file.id) + '/preview';
  $('download-original').href = '/api/files/' + encodeURIComponent(file.id);
  $('download-original').setAttribute('download', file.name);
  viewer.showModal(); $('close-image-viewer').focus();
}
function closeImageViewer() {
  $('viewer-image').onerror = null; $('viewer-image').removeAttribute('src');
  $('download-original').removeAttribute('href'); $('image-viewer-title').textContent = '';
  if ($('image-viewer').open) $('image-viewer').close();
}
$('close-image-viewer').onclick = closeImageViewer;
$('image-viewer').onclick = event => { if (event.target === $('image-viewer')) closeImageViewer(); };
$('image-viewer').onclose = () => {
  closeImageViewer();
  if (!$('workspace').hidden) (imageOpener?.isConnected ? imageOpener : $('history')).focus({preventScroll: true});
  imageOpener = null;
};
function formatFileSize(size) {
  if (size < 1024) return size + ' Б';
  if (size >= 1024 ** 3) return (size / 1024 ** 3).toLocaleString('ru', {maximumFractionDigits: 1}) + ' ГБ';
  if (size < 1024 * 1024) return (size / 1024).toLocaleString('ru', {maximumFractionDigits: 1}) + ' КБ';
  return (size / (1024 * 1024)).toLocaleString('ru', {maximumFractionDigits: 1}) + ' МБ';
}
function updateAttachment() {
  const count = selectedFiles.length;
  $('attachment-selection').hidden = !count;
  $('attachment-name').textContent = count === 1 ? selectedFiles[0].name + ' · ' + formatFileSize(selectedFiles[0].size)
    : count ? 'Файлы: ' + count + ' / 10 · ' + formatFileSize(selectedFiles.reduce((sum, file) => sum + file.size, 0)) : '';
  $('remove-attachment').textContent = count > 1 ? 'Убрать все' : 'Убрать';
  $('remove-attachment').setAttribute('aria-label', count > 1 ? 'Убрать все выбранные файлы' : 'Убрать выбранный файл');
  $('attachment-list').replaceChildren(); $('attachment-list').hidden = count < 2;
  for (const [index, file] of selectedFiles.entries()) {
    const row = document.createElement('div'); row.className = 'selected-file'; row.setAttribute('role', 'listitem');
    const name = document.createElement('span'); name.textContent = file.name + ' · ' + formatFileSize(file.size); name.title = file.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Убрать';
    remove.setAttribute('aria-label', 'Убрать ' + file.name); remove.disabled = Boolean(uploadRequest);
    remove.onclick = () => { selectedFiles.splice(index, 1); pendingFileSend = null; updateAttachment(); saveDraft(); };
    row.append(name, remove); $('attachment-list').append(row);
  }
  $('file-input').value = '';
  $('attachment-space').textContent = count && storageState ? 'Свободно: ' + formatFileSize(Math.max(0, storageState.max_storage_bytes - storageState.used_bytes)) + ' · до 10 файлов по ' + formatFileSize(storageState.max_file_bytes) : '';
  resizeInput();
}
$('attach').onclick = () => $('file-input').click();
$('remove-attachment').onclick = () => { selectedFiles = []; pendingFileSend = null; updateAttachment(); saveDraft(); };
$('file-input').onchange = async () => {
  const files = Array.from($('file-input').files);
  if (!files.length || uploadRequest || choosingFiles) return;
  const epoch = sessionEpoch;
  choosingFiles = true; $('attach').disabled = true; resizeInput();
  try {
    if (selectedFiles.length + files.length > 10) throw Error('К сообщению можно прикрепить не больше 10 файлов.');
    const storage = await api('storage');
    if (epoch !== sessionEpoch || $('workspace').hidden) return;
    const large = files.find(file => file.size > storage.max_file_bytes);
    if (large) throw Error('Файл «' + large.name + '» слишком большой. Лимит: ' + formatFileSize(storage.max_file_bytes) + '.');
    storageState = storage; selectedFiles.push(...files);
    if (pendingFileSend && !samePendingFiles(selectedFiles, pendingFileSend, true)) pendingFileSend = null;
    updateAttachment(); saveDraft();
    const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    notice(total + storage.used_bytes > storage.max_storage_bytes ? 'Хранилище заполнено. Освободи место в корзине перед отправкой.' : '');
  } catch (error) { if (epoch === sessionEpoch) { notice(errorMessage(error)); $('file-input').value = ''; } }
  finally { if (epoch === sessionEpoch) { choosingFiles = false; $('attach').disabled = Boolean(uploadRequest); resizeInput(); } }
};
$('cancel-upload').onclick = () => uploadRequest?.abort();
function samePendingFiles(files, pending, partial = false) {
  const expected = (pending.files || [pending]).map(file => JSON.stringify([file.name, file.size])).sort();
  const actual = files.map(file => JSON.stringify([file.name, file.size])).sort();
  if ((!partial && expected.length !== actual.length) || actual.length > expected.length) return false;
  for (const value of actual) { const index = expected.indexOf(value); if (index < 0) return false; expected.splice(index, 1); }
  return true;
}
function uploadFiles(files, text) {
  const manifest = files.map(file => ({name: file.name, size: file.size, lastModified: file.lastModified}));
  if (!pendingFileSend || !samePendingFiles(files, pendingFileSend) || pendingFileSend.text !== text) pendingFileSend = {...manifest[0], files: manifest, text, id: requestId()};
  saveDraft();
  const payload = files.length === 1 ? {name: files[0].name, text, request_id: pendingFileSend.id}
    : {files: manifest.map(({name, size}) => ({name, size})), text, request_id: pendingFileSend.id};
  const metadata = new TextEncoder().encode(JSON.stringify(payload));
  const current = generation;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); uploadRequest = xhr;
    xhr.open('POST', '/api/files'); xhr.timeout = files.length * 600000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Textdrop-User', currentUser.id);
    xhr.setRequestHeader('X-Textdrop-Metadata-Length', String(metadata.length));
    $('upload-feedback').hidden = false;
    $('upload-progress').value = 0; $('upload-status').textContent = 'Загружаем файлы…';
    for (const id of ['attach', 'remove-attachment', 'logout', 'account-button']) $(id).disabled = true;
    for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = true;
    function finish() {
      uploadRequest = null; $('upload-feedback').hidden = true;
      for (const id of ['attach', 'remove-attachment', 'logout', 'account-button']) $(id).disabled = false;
      for (const button of $('attachment-list').querySelectorAll('button')) button.disabled = false;
    }
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      $('upload-progress').value = percent;
      $('upload-status').textContent = percent === 100 ? 'Сохраняем файлы…' : 'Загрузка: ' + percent + '%';
    };
    xhr.onload = () => {
      finish(); let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if ((xhr.status === 401 || data?.account_changed) && current === generation) { session(false); notice('Сессия завершилась. Войди снова — файлы остаются выбранными.', 'auth'); }
      if (xhr.status >= 200 && xhr.status < 300 && isNote(data) && filesForNote(data).length) resolve(data);
      else reject(apiError(data?.error || 'Не удалось отправить файлы. Повтори отправку.', xhr.status, xhr.status === 401 ? 'auth' : 'server'));
    };
    xhr.onerror = () => { finish(); reject(Error('Нет связи с сервером. Файлы остаются выбранными — повтори отправку.')); };
    xhr.ontimeout = () => { finish(); reject(Error('Сервер не ответил вовремя. Файлы остаются выбранными — повтори отправку.')); };
    xhr.onabort = () => { finish(); reject(Error('Загрузка отменена. Файлы остаются выбранными для повтора.')); };
    try { xhr.send(new Blob([metadata, ...files])); }
    catch { finish(); reject(Error('Не удалось начать загрузку. Повтори отправку.')); }
  });
}
$('text').onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose').requestSubmit(); } };
$('logout').onclick = async () => {
  try {
    await api('logout', 'POST');
    if (editor) editor.closed = true;
    editor = null;
    pendingSend = null; selectedFiles = []; pendingFileSend = null; updateAttachment(); $('text').value = '';
    let cleared = true;
    try { draftStore?.clear(); } catch { cleared = false; }
    draftStatus(''); session(false); draftReady = false; currentUser = null; draftStore = null;
    notice(cleared ? '' : 'Вы вышли, но очистить черновик не удалось. Удалите данные сайта в настройках браузера.');
    $('password').focus();
  }
  catch (error) { notice(errorMessage(error)); }
};
$('search').oninput = () => changeSearch($('search').value, 250);
async function retryConnection(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try { if ($('workspace').hidden) await start(); else await sync(); }
  finally { button.disabled = false; }
}
$('retry').onclick = retryConnection;
$('login-retry').onclick = retryConnection;
async function start() {
  const current = generation, attempt = ++startupAttempt;
  startupLoading = true;
  try {
    const data = await api('session');
    if (current !== generation || attempt !== startupAttempt) return;
    if (noticeKind === 'start') notice('');
    session(data.authenticated, data.user); $('retry').hidden = true;
    if (data.authenticated) await sync();
  } catch (error) {
    if (current !== generation || attempt !== startupAttempt) return;
    session(false); notice(errorMessage(error), 'start');
    $('login-retry').hidden = false;
    if (error.kind === 'network' || navigator.onLine === false) {
      $('offline-start').hidden = false; $('login').hidden = true; $('login-retry').hidden = true; $('login-feedback').hidden = true;
      const message = 'Попробуем подключиться снова, когда появится сеть.';
      if ($('offline-feedback').textContent !== message) $('offline-feedback').textContent = message;
    }
  } finally { if (attempt === startupAttempt) startupLoading = false; }
}
$('offline-retry').onclick = async () => {
  $('offline-retry').disabled = true;
  try { await start(); } finally { $('offline-retry').disabled = false; }
};
window.addEventListener('offline', () => {
  saveDraft();
  if (!$('workspace').hidden) { setConnection('Нет соединения', 'error'); notice('Нет сети. Черновик сохраняется на этом устройстве; отправь его после подключения.', 'offline'); }
});
window.addEventListener('textdrop:before-update', event => {
  if (editor || uploadRequest || choosingFiles || selectedFiles.length || $('send').classList.contains('sending')) {
    event.preventDefault(); event.detail.message = 'Заверши редактирование или отправку файлов, затем обнови.'; return;
  }
  if (!saveDraft() && ($('text').value || pendingSend || pendingFileSend)) {event.preventDefault(); event.detail.message = 'Не удалось сохранить черновик. Скопируй текст перед обновлением.';}
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => { if ($('workspace').hidden) start(); else sync(); });
setInterval(() => {
  if (document.hidden) return;
  if (!$('offline-start').hidden && navigator.onLine && !startupLoading) start();
  else sync();
}, 3000);
categoryUI = new window.TextdropCategories({
  api,
  onFilter() { changeSearch(currentQuery); },
  onMarked(saved) {
    if (saved) {
      if (noticeKind === 'category') notice('');
      notes = notes.map(note => note.id === saved.id ? saved : note);
      if (categoryUI.filter && !(saved.categories || []).includes(categoryUI.filter)) notes = notes.filter(note => note.id !== saved.id);
    }
    render({preserveScroll: true}); sync();
  },
  onError(error) { notice(errorMessage(error), 'category'); }
});
start();

function accountFeedback(message, success = false) {
  $('account-feedback').textContent = message;
  $('account-feedback').classList.toggle('success', success);
}
async function loadUsers() {
  const epoch = sessionEpoch;
  $('users-retry').hidden = true;
  try {
    const data = await api('users');
    if (epoch !== sessionEpoch || !$('account-dialog').open) return;
    $('users-list').replaceChildren();
    for (const user of data.users) {
      const row = document.createElement('div'); row.className = 'user-row';
      const name = document.createElement('strong'); name.textContent = user.username;
      const state = document.createElement('span'); state.className = 'user-state';
      state.textContent = user.role === 'admin' ? 'Владелец' : user.active ? 'Активен' : 'Отключён';
      row.append(name, state);
      if (user.role !== 'admin') {
        const actions = document.createElement('div'); actions.className = 'user-actions';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'quiet';
        toggle.textContent = user.active ? 'Отключить' : 'Включить';
        toggle.setAttribute('aria-label', toggle.textContent + ' ' + user.username);
        toggle.onclick = async () => {
          const actionEpoch = sessionEpoch; toggle.disabled = true;
          try { await api('users/' + user.id, 'PATCH', {active: !user.active}); if (actionEpoch !== sessionEpoch) return; await loadUsers(); accountFeedback(user.active ? 'Доступ отключён. Сессии завершены.' : 'Доступ включён.', true); }
          catch (error) { if (actionEpoch === sessionEpoch) accountFeedback(errorMessage(error)); toggle.disabled = false; }
        };
        const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'quiet'; reset.textContent = 'Новый пароль';
        const form = document.createElement('form'); form.className = 'user-reset'; form.hidden = true;
        const label = document.createElement('label'); label.textContent = 'Новый пароль для ' + user.username;
        const input = document.createElement('input'); input.type = 'password'; input.required = true; input.minLength = 7; input.maxLength = 1024; input.autocomplete = 'new-password';
        const submit = document.createElement('button'); submit.textContent = 'Сохранить пароль';
        label.append(input); form.append(label, submit); passwordControl(input);
        reset.onclick = () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); };
        form.onsubmit = async event => {
          event.preventDefault(); const actionEpoch = sessionEpoch; submit.disabled = true; accountFeedback('');
          try { await api('users/' + user.id + '/password', 'POST', {password: input.value}); if (actionEpoch !== sessionEpoch) return; form.reset(); form.hidden = true; accountFeedback('Пароль изменён. Сессии пользователя завершены.', true); }
          catch (error) { if (actionEpoch === sessionEpoch) accountFeedback(errorMessage(error)); }
          finally { submit.disabled = false; }
        };
        actions.append(toggle, reset); row.append(actions, form);
      }
      $('users-list').append(row);
    }
  } catch (error) { if (epoch === sessionEpoch) { accountFeedback(errorMessage(error)); $('users-retry').hidden = false; } }
}
$('account-button').onclick = () => {
  accountFeedback(''); $('users-list').replaceChildren(); $('users-retry').hidden = true;
  setCreateUserOpen(false);
  $('account-identity').textContent = currentUser.username;
  $('account-nav').hidden = currentUser.role !== 'admin';
  accountPane(currentUser.role === 'admin' ? 'users' : 'password');
  $('account-dialog').showModal(); loadStorage();
  if (currentUser.role === 'admin') loadUsers();
};
$('close-account').onclick = () => $('account-dialog').close();
$('account-dialog').onclose = () => {
  $('password-form').reset(); $('create-user-form').reset(); $('users-list').replaceChildren(); setCreateUserOpen(false);
};
$('users-retry').onclick = loadUsers;
$('create-user-form').onsubmit = async event => {
  event.preventDefault(); const actionEpoch = sessionEpoch, form = event.currentTarget, button = event.submitter; button.disabled = true; accountFeedback('');
  try { const data = await api('users', 'POST', Object.fromEntries(new FormData(form))); if (actionEpoch !== sessionEpoch) return; form.reset(); setCreateUserOpen(false); await loadUsers(); accountFeedback('Создан пользователь ' + data.user.username + '. Передай ему логин и пароль.', true); }
  catch (error) { if (actionEpoch === sessionEpoch) accountFeedback(errorMessage(error)); }
  finally { button.disabled = false; }
};
$('password-form').onsubmit = async event => {
  event.preventDefault(); const actionEpoch = sessionEpoch, button = event.submitter; button.disabled = true; accountFeedback('');
  try { await api('password', 'POST', Object.fromEntries(new FormData(event.currentTarget))); if (actionEpoch !== sessionEpoch) return; saveDraft(); session(false); notice('Пароль изменён. Войди с новым паролем.', 'success'); }
  catch (error) { if (actionEpoch === sessionEpoch) accountFeedback(errorMessage(error)); }
  finally { button.disabled = false; }
};

function accountPane(pane) {
  $('users-section').hidden = pane !== 'users';
  $('password-section').hidden = pane !== 'password';
  $('account-users-tab').setAttribute('aria-pressed', String(pane === 'users'));
  $('account-password-tab').setAttribute('aria-pressed', String(pane === 'password'));
}
$('account-users-tab').onclick = () => accountPane('users');
$('account-password-tab').onclick = () => accountPane('password');

function setCreateUserOpen(open) {
  $('create-user-form').hidden = !open;
  $('add-user').hidden = open;
  $('add-user').setAttribute('aria-expanded', String(open));
  if (!open) $('create-user-form').reset();
}
$('add-user').onclick = () => { setCreateUserOpen(true); $('create-user-form').elements.username.focus(); };
$('cancel-create-user').onclick = () => { setCreateUserOpen(false); $('add-user').focus(); };
async function loadStorage() {
  const epoch = sessionEpoch;
  $('storage-status').textContent = 'Проверяем свободное место…';
  $('storage-usage').hidden = true; $('storage-retry').hidden = true;
  try {
    const data = await api('storage');
    if (epoch !== sessionEpoch || !$('account-dialog').open) return;
    storageState = data;
    $('storage-status').textContent = 'Занято ' + formatFileSize(data.used_bytes) + ' из ' + formatFileSize(data.max_storage_bytes) + '. Свободно ' + formatFileSize(Math.max(0, data.max_storage_bytes - data.used_bytes)) + '.';
    $('storage-usage').max = data.max_storage_bytes;
    $('storage-usage').setAttribute('aria-valuetext', formatFileSize(data.used_bytes) + ' из ' + formatFileSize(data.max_storage_bytes));
    $('storage-usage').value = data.used_bytes; $('storage-usage').hidden = false;
    updateAttachment();
  } catch (error) {
    if (epoch !== sessionEpoch || !$('account-dialog').open) return;
    $('storage-status').textContent = 'Не удалось проверить свободное место.'; $('storage-retry').hidden = false;
  }
}
$('storage-retry').onclick = loadStorage;
let passwordFieldId = 0;
function passwordControl(input) {
  if (!input.id) input.id = 'password-field-' + ++passwordFieldId;
  const label = input.closest('label');
  const wrapper = document.createElement('div'); wrapper.className = 'password-field';
  if (label) {
    const group = document.createElement('div'); group.className = 'password-control';
    label.before(group); group.append(label, wrapper); label.htmlFor = input.id;
  } else input.before(wrapper);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet password-toggle';
  button.setAttribute('aria-controls', input.id); button.setAttribute('aria-pressed', 'false'); button.textContent = 'Показать';
  const caption = label?.textContent.trim() || input.labels?.[0]?.textContent.trim() || 'пароль';
  button.setAttribute('aria-label', 'Показать: ' + caption);
  button.onclick = () => {
    const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Скрыть' : 'Показать'; button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', (visible ? 'Скрыть: ' : 'Показать: ') + caption);
  };
  wrapper.append(input, button);
}
function resetPasswordVisibility(root = document) {
  for (const field of root.querySelectorAll('.password-field')) {
    const input = field.querySelector('input'), button = field.querySelector('button');
    if (input.type !== 'password') button.click();
  }
}
document.querySelectorAll('input[type="password"]').forEach(passwordControl);
document.addEventListener('reset', event => resetPasswordVisibility(event.target));
try { const username = localStorage.getItem('textdrop-username-v1'); if (/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username || '')) $('username').value = username; } catch {}
