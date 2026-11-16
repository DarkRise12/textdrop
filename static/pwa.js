'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const standalone = matchMedia('(display-mode: standalone)');
  let installPrompt = null, registration = null, preparing = false, applying = false;
  let refreshReady = false, hadController = Boolean(navigator.serviceWorker?.controller), checkedAt = 0;
  function installed() {
    const active = standalone.matches || navigator.standalone === true;
    document.querySelectorAll('[data-pwa-install]').forEach(button => button.hidden = active);
  }
  installed(); standalone.addEventListener('change', installed);
  window.addEventListener('beforeinstallprompt', event => {event.preventDefault(); installPrompt = event;});
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    document.querySelectorAll('[data-pwa-install]').forEach(button => button.hidden = true);
    if ($('install-dialog').open) $('install-dialog').close();
  });
  async function install(event) {
    const button = event.currentTarget;
    if (!installPrompt) { $('install-dialog').showModal(); return; }
    const prompt = installPrompt; installPrompt = null; button.disabled = true;
    try { await prompt.prompt(); await prompt.userChoice; }
    catch { $('install-dialog').showModal(); }
    finally { button.disabled = false; }
  }
  document.querySelectorAll('[data-pwa-install]').forEach(button => button.onclick = install);
  $('close-install').onclick = () => $('install-dialog').close();
  function readyToUpdate() {
    $('pwa-update').hidden = false;
    $('pwa-update-message').textContent = 'Доступна новая версия';
  }
  function observe(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) readyToUpdate();
      if (worker.state === 'redundant' && !registration?.active) $('pwa-status').textContent = 'Офлайн-запуск пока не подготовлен. Повтори при подключении.';
    });
  }
  async function prepare() {
    if (preparing || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    preparing = true;
    try {
      registration = await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
      checkedAt = Date.now();
      if (registration.waiting) readyToUpdate();
      observe(registration.installing);
      registration.addEventListener('updatefound', () => observe(registration.installing));
      navigator.serviceWorker.ready.then(() => {
        $('pwa-status').textContent = 'Готово к запуску без сети. Для входа и синхронизации нужен интернет.';
      }).catch(() => {});
    } catch {
      $('pwa-status').textContent = navigator.serviceWorker.controller ? 'Офлайн-запуск подготовлен. Для входа и синхронизации нужен интернет.' : 'Офлайн-запуск пока не подготовлен. Повтори при подключении.';
    } finally { preparing = false; }
  }
  $('pwa-update-button').onclick = () => {
    const detail = {message: ''};
    const before = new CustomEvent('textdrop:before-update', {cancelable: true, detail});
    if (!window.dispatchEvent(before)) {
      $('pwa-update-message').textContent = detail.message || 'Сначала заверши текущую отправку или редактирование.'; return;
    }
    if (!registration?.waiting && !refreshReady) { $('pwa-update').hidden = true; return; }
    applying = true; $('pwa-update-button').disabled = true;
    $('pwa-update-message').textContent = 'Обновляем приложение…';
    if (registration?.waiting) registration.waiting.postMessage({type: 'APPLY_UPDATE'});
    else location.reload();
  };
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (applying) { location.reload(); return; }
    if (hadController) {refreshReady = true; readyToUpdate();}
    hadController = true;
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine && registration && Date.now() - checkedAt > 15 * 60 * 1000) {
      checkedAt = Date.now(); registration.update().catch(() => {});
    }
  });
  window.addEventListener('online', () => {
    if (!registration) prepare();
    else {checkedAt = Date.now(); registration.update().catch(() => {});}
  });
  prepare();
})();
