'use strict';
const $ = id => document.getElementById(id);
let notes = [], loading = false, generation = 0, online = false;
let editor = null;
let sessionEpoch = 0;
let view = 'chat', syncAgain = false, viewLoaded = false;
let noticeKind = '';
let currentQuery = '', searchTimer = null, feedAbort = null;
let nextPage = null, feedRevision = null, totalNotes = 0, matchedNotes = 0, loadedThrough = null;
let olderLoading = false, lastHistoryScroll = 0;
let selectedFile = null, pendingFileSend = null, uploadRequest = null;
const expandedMessages = new Set(), messagePreviewCache = new Map();
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
    draftStore.save($('text').value, pendingSend, pendingFileSend);
    draftStatus(pendingFileSend && !selectedFile ? 'Для повтора выбери файл: ' + pendingFileSend.name : $('text').value ? 'Черновик сохранён на этом устройстве' : '');
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
      pendingFileSend = draft.filePending || null;
      draftStatus(pendingFileSend ? 'Для повтора выбери файл: ' + pendingFileSend.name : draft.text ? 'Черновик восстановлен' : '');
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
  $('send').disabled = $('send').classList.contains('sending') || (!$('text').value.trim() && !selectedFile);
  $('text').required = !selectedFile;
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
function session(active) {
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
  if (!active) { clearFeedState(); expandedMessages.clear(); messagePreviewCache.clear(); online = false; viewLoaded = false; notes = []; $('notes').replaceChildren(); $('latest').hidden = true; }
}
function apiError(message, status, kind) {
  return Object.assign(new Error(message), {status, kind});
}
function isNote(value) {
  return value && (!value.file || typeof value.file.name === 'string' && Number.isSafeInteger(value.file.size) && value.file.size >= 0 && /^[a-f0-9]{64}$/.test(value.file.sha256)) && typeof value.id === 'string' && typeof value.text === 'string' && Number.isFinite(value.created) && !Number.isNaN(new Date(value.created).getTime());
}
async function api(path, method = 'GET', body, signal) {
  const requestedAt = generation;
  let response;
  try {
    response = await fetch('/api/' + path, {
      method, headers: body ? {'Content-Type': 'application/json'} : {},
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
    : path === 'session' ? typeof data?.authenticated === 'boolean'
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
  toggle.setAttribute('aria-controls', text.id);
  text.after(toggle);
  function update() {
    article.classList.add('note-collapsible');
    const width = text.getBoundingClientRect().width;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    let cached = messagePreviewCache.get(note.id);
    if (!cached || cached.text !== note.text || cached.width !== width || cached.lineHeight !== lineHeight) {
      text.textContent = note.text;
      const limit = lineHeight * 6 + 1;
      let end = note.text.length;
      if (text.getBoundingClientRect().height > limit) {
        let low = 0, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          text.textContent = note.text.slice(0, middle).trimEnd() + '…';
          if (text.getBoundingClientRect().height <= limit) low = middle;
          else high = middle - 1;
        }
        end = note.text.slice(0, low).trimEnd().length;
        // A preview must not end halfway through a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/u.test(note.text[end - 1] || '')) end--;
      }
      cached = {text: note.text, width, lineHeight, end};
      messagePreviewCache.set(note.id, cached);
    }
    const long = cached.end < note.text.length;
    const expanded = searching || expandedMessages.has(note.id);
    article.classList.toggle('note-collapsible', long);
    toggle.hidden = !long || searching;
    toggle.textContent = expanded ? 'Свернуть' : 'Развернуть';
    toggle.setAttribute('aria-expanded', String(expanded));
    window.TextdropLinks.append(text, note.text, expanded ? note.text.length : cached.end);
  }
  toggle.onclick = () => {
    const history = $('history');
    const top = Math.max(0, article.getBoundingClientRect().top - history.getBoundingClientRect().top);
    if (expandedMessages.has(note.id)) expandedMessages.delete(note.id);
    else expandedMessages.add(note.id);
    update();
    // Keep the beginning in view, including when collapsing a message read to its end.
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
  const visible = notes.slice();
  if ($('image-viewer').open && !notes.some(note => note.id === $('image-viewer').dataset.noteId)) closeImageViewer();
  if (editor && !visible.some(note => note.id === editor.id)) visible.push(editor.note);
  const filtered = visible.sort((a, b) => compareNotes(b, a));
  if (view === 'chat') filtered.reverse();
  $('count').textContent = query ? matchedNotes : totalNotes;
  $('count').title = 'Найдено: ' + matchedNotes + '. Всего: ' + totalNotes + '. Загружено: ' + notes.length;
  $('count-label').textContent = query ? 'Найдено:' : view === 'trash' ? 'В корзине:' : 'Всего сообщений:';
  $('empty').hidden = !viewLoaded || totalNotes > 0 || notes.length > 0 || !!editor;
  $('no-results').hidden = !viewLoaded || !query || !totalNotes || matchedNotes > 0 || !!editor;
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
    if (note.file) {
      article.classList.add('note-file');
      if (note.file.preview) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'image-preview';
        button.dataset.action = 'preview'; button.setAttribute('aria-label', 'Открыть фотографию ' + note.file.name);
        const image = document.createElement('img'); image.width = 640; image.height = 480;
        image.loading = 'lazy'; image.decoding = 'async'; image.alt = 'Фото: ' + note.file.name;
        image.src = '/api/files/' + encodeURIComponent(note.id) + '/preview';
        image.onerror = () => { button.remove(); };
        button.append(image); button.onclick = () => showImage(note, button); article.append(button);
      }
      const card = document.createElement('a'); card.className = 'file-download';
      card.href = '/api/files/' + encodeURIComponent(note.id); card.setAttribute('download', note.file.name);
      const name = document.createElement('span'); name.textContent = note.file.name;
      const detail = document.createElement('span'); detail.className = 'file-detail';
      detail.textContent = formatFileSize(note.file.size) + ' · Скачать';
      card.append(name, detail); article.append(card);
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
  if (kind === 'changes') params.set('since', String(feedRevision));
  else if (cursor) params.set('before', cursor);
  return (view === 'trash' ? 'trash/' : 'notes/') + kind + '?' + params;
}
function changeSearch(query, delay = 0) {
  generation++;
  currentQuery = query.trim();
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
  notice(errorMessage(error), 'sync');
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
        if (JSON.stringify(notes) !== previous || countersChanged || !online) render();
        if (view === 'chat' && !following && !currentQuery && notes.some(note => !previousIds.has(note.id))) $('latest').hidden = false;
        if (!data.has_more) break;
      }
    }
    if (noticeKind === 'sync' || noticeKind === 'start') notice('');
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
  try { await api('login', 'POST', {password: $('password').value}); $('password').value = ''; session(true); await sync(); }
  catch (error) { notice(errorMessage(error)); }
  finally { button.disabled = false; }
};
$('compose').onsubmit = async event => {
  event.preventDefault(); const button = $('send');
  if (button.disabled || (!$('text').value.trim() && !selectedFile)) return;
  button.disabled = true; button.classList.add('sending'); button.setAttribute('aria-label', 'Отправляем сообщение'); notice('');
  const text = $('text').value;
  const epoch = sessionEpoch;
  const file = selectedFile;
  if (!file && (!pendingSend || pendingSend.text !== text)) pendingSend = {text, id: requestId()};
  const sending = pendingSend;
  saveDraft(); // Persist the retry identifier before the request can reach the server.
  try {
    const saved = file ? await uploadFile(file, text) : await api('notes', 'POST', {text, request_id: sending.id});
    if (epoch !== sessionEpoch) return;
    if (file && selectedFile === file) { selectedFile = null; pendingFileSend = null; updateAttachment(); }
    if (pendingSend === sending) pendingSend = null;
    generation++; // Ignore a poll that began before this message was saved.
    if (view === 'chat') notes = [saved, ...notes.filter(note => note.id !== saved.id)];
    if ($('text').value === text) $('text').value = '';
    saveDraft();
    resizeInput();
    if (view === 'chat' && !$('workspace').hidden) {
      if (currentQuery) { currentQuery = ''; clearFeedState(); viewLoaded = false; }
      $('search').value = ''; setSearchOpen(false); render({forceBottom: true});
      $('text').focus({preventScroll: true});
    }
    await sync();
  } catch (error) {
    if (epoch !== sessionEpoch) return;
    if ([409, 410].includes(error.status) && pendingSend === sending) pendingSend = null;
    if (file && [409, 410].includes(error.status)) pendingFileSend = null;
    saveDraft();
    notice(errorMessage(error));
  }
  finally { if (epoch === sessionEpoch) { button.classList.remove('sending'); button.setAttribute('aria-label', 'Отправить сообщение'); resizeInput(); } }
};
let imageOpener = null;
function showImage(note, opener) {
  imageOpener = opener;
  const viewer = $('image-viewer'); viewer.dataset.noteId = note.id;
  $('image-viewer-title').textContent = note.file.name;
  $('viewer-image').alt = note.file.name;
  $('viewer-image').onerror = () => { closeImageViewer(); notice('Предпросмотр недоступен. Оригинал можно скачать из сообщения.'); };
  $('viewer-image').src = '/api/files/' + encodeURIComponent(note.id) + '/preview';
  $('download-original').href = '/api/files/' + encodeURIComponent(note.id);
  $('download-original').setAttribute('download', note.file.name);
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
  if (size < 1024 * 1024) return (size / 1024).toLocaleString('ru', {maximumFractionDigits: 1}) + ' КБ';
  return (size / (1024 * 1024)).toLocaleString('ru', {maximumFractionDigits: 1}) + ' МБ';
}
function updateAttachment() {
  $('attachment-selection').hidden = !selectedFile;
  $('attachment-name').textContent = selectedFile ? selectedFile.name + ' · ' + formatFileSize(selectedFile.size) : '';
  $('file-input').value = '';
  resizeInput();
}
$('attach').onclick = () => $('file-input').click();
$('remove-attachment').onclick = () => { selectedFile = null; pendingFileSend = null; updateAttachment(); saveDraft(); };
$('file-input').onchange = async () => {
  const file = $('file-input').files[0];
  if (!file || uploadRequest) return;
  const current = generation;
  try {
    const storage = await api('storage');
    if (current !== generation || $('workspace').hidden) return;
    if (file.size > storage.max_file_bytes) throw Error('Файл слишком большой. Лимит: ' + formatFileSize(storage.max_file_bytes) + '.');
    selectedFile = file;
    if (pendingFileSend && !samePendingFile(file, pendingFileSend)) pendingFileSend = null;
    updateAttachment(); saveDraft();
    notice(file.size + storage.used_bytes > storage.max_storage_bytes
      ? 'Хранилище заполнено. Освободи место в корзине перед отправкой.' : '');
  } catch (error) { notice(errorMessage(error)); $('file-input').value = ''; }
};
$('cancel-upload').onclick = () => uploadRequest?.abort();
function samePendingFile(file, pending) {
  return file.name === pending.name && file.size === pending.size;
}
function uploadFile(file, text) {
  if (!pendingFileSend || !samePendingFile(file, pendingFileSend) || pendingFileSend.text !== text) pendingFileSend = {name: file.name, size: file.size, lastModified: file.lastModified, text, id: requestId()};
  saveDraft();
  const metadata = new TextEncoder().encode(JSON.stringify({name: file.name, text, request_id: pendingFileSend.id}));
  const current = generation;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); uploadRequest = xhr;
    xhr.open('POST', '/api/files'); xhr.timeout = 600000;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Textdrop-Metadata-Length', String(metadata.length));
    $('upload-feedback').hidden = false;
    $('upload-progress').value = 0; $('upload-status').textContent = 'Загружаем файл…';
    for (const id of ['attach', 'remove-attachment', 'logout']) $(id).disabled = true;
    function finish() {
      uploadRequest = null; $('upload-feedback').hidden = true;
      for (const id of ['attach', 'remove-attachment', 'logout']) $(id).disabled = false;
    }
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      $('upload-progress').value = percent;
      $('upload-status').textContent = percent === 100 ? 'Сохраняем файл…' : 'Загрузка: ' + percent + '%';
    };
    xhr.onload = () => {
      finish(); let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status === 401 && current === generation) { session(false); notice('Сессия завершилась. Войди снова — файл остаётся выбранным.', 'auth'); }
      if (xhr.status >= 200 && xhr.status < 300 && isNote(data) && data.file) resolve(data);
      else reject(apiError(data?.error || 'Не удалось отправить файл. Повтори отправку.', xhr.status, xhr.status === 401 ? 'auth' : 'server'));
    };
    xhr.onerror = () => { finish(); reject(Error('Нет связи с сервером. Файл остаётся выбранным — повтори отправку.')); };
    xhr.ontimeout = () => { finish(); reject(Error('Сервер не ответил вовремя. Файл остаётся выбранным — повтори отправку.')); };
    xhr.onabort = () => { finish(); reject(Error('Загрузка отменена. Файл остаётся выбранным для повтора.')); };
    try { xhr.send(new Blob([metadata, file])); }
    catch { finish(); reject(Error('Не удалось начать загрузку. Повтори отправку.')); }
  });
}
$('text').onkeydown = event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('compose').requestSubmit(); } };
$('logout').onclick = async () => {
  try {
    await api('logout', 'POST');
    if (editor) editor.closed = true;
    editor = null;
    pendingSend = null; selectedFile = null; pendingFileSend = null; updateAttachment(); $('text').value = '';
    let cleared = true;
    try { draftStore?.clear(); } catch { cleared = false; }
    draftStatus(''); session(false);
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
