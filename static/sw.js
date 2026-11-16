'use strict';
// This template is stamped by the server from the exact public asset bytes.
const CACHE_PREFIX = 'textdrop-shell-';
const CACHE_NAME = CACHE_PREFIX + '__TEXTDROP_VERSION__';
const ASSETS = __TEXTDROP_ASSETS__;
const PUBLIC_PATHS = new Set(ASSETS.map(asset => asset.url));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS.map(asset => new Request(asset.url, {
        credentials: 'omit', cache: 'reload', integrity: asset.integrity
      })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'APPLY_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  // Private API calls (including downloads and previews), writes and foreign URLs
  // always go straight to the network. There is no offline send queue.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || !PUBLIC_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.pathname);
    return cached || fetch(request);
  })());
});
