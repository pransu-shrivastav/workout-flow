/**
 * Workout Flow service worker v3.
 *
 * Production strategy:
 * - Navigations/index.html: network-first, offline shell fallback.
 * - Same-origin static assets: stale-while-revalidate.
 * - Updates remain waiting until the user chooses "Reload now".
 * - IndexedDB is never touched by this worker.
 */

const CACHE_NAME = 'workout-flow-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './src/app.js',
  './src/state.js',
  './src/storage.js',
  './src/audio.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) ||
      (await caches.match('./index.html')) ||
      Response.error();
  }
}

async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);
  const update = fetch(request, { cache: 'no-store' })
    .then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(update);
  return cached || (await update) || Response.error();
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isNavigation =
    request.mode === 'navigate' ||
    requestUrl.pathname.endsWith('/index.html') ||
    requestUrl.pathname === self.registration.scope.replace(requestUrl.origin, '');

  if (isNavigation) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, event));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});