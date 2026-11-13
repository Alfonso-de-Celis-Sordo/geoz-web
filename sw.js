/* GeoZ service-worker source. scripts/build-sw.mjs injects the build manifest.
 * No skipWaiting: a new version must not replace a game already in progress.
 */
'use strict';

const BUILD_VERSION = '3cd060b495367b110d7e';
const APP_BASE = "/geoz-web/";
const PRECACHE_URLS = [
  "/geoz-web/assets/index-BjGZIvFa.css",
  "/geoz-web/assets/index-BTh5ULB2.js",
  "/geoz-web/assets/photos/credits.json",
  "/geoz-web/assets/photos/tera-valles.credit.json",
  "/geoz-web/data/catalog.json",
  "/geoz-web/data/comarcas.geojson",
  "/geoz-web/data/LICENSE.txt",
  "/geoz-web/data/sources.json",
  "/geoz-web/data/territories.geojson",
  "/geoz-web/icons/apple-touch-icon.png",
  "/geoz-web/icons/icon-192.png",
  "/geoz-web/icons/icon-512.png",
  "/geoz-web/icons/icon.svg",
  "/geoz-web/icons/maskable-512.png",
  "/geoz-web/icons/maskable.svg",
  "/geoz-web/index.html",
  "/geoz-web/manifest.webmanifest"
];
const CACHE_PREFIX = `geoz-${encodeURIComponent(APP_BASE)}-`;
const CORE_CACHE = `${CACHE_PREFIX}core-${BUILD_VERSION}`;
const PHOTO_CACHE = `${CACHE_PREFIX}photos-${BUILD_VERSION}`;
const INDEX_URL = `${APP_BASE}index.html`;
const CORE_PATHS = new Set(PRECACHE_URLS);
const MAX_CACHED_PHOTOS = 48;

function isPublicResponse(response) {
  return response.ok && response.status === 200 && response.type === 'basic' &&
    !response.redirected && !/\b(?:no-store|private)\b/i.test(response.headers.get('cache-control') || '');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (!PRECACHE_URLS.length || BUILD_VERSION.startsWith('__') || APP_BASE.startsWith('__')) {
      throw new Error('GeoZ: generate the production service worker with npm run build.');
    }
    const cache = await caches.open(CORE_CACHE);
    try {
      // addAll rejects the install if any essential asset is missing. The old
      // worker remains active; partial deployments never replace a working app.
      await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, {
        cache: 'reload', credentials: 'same-origin',
      })));
      const shell = await cache.match(INDEX_URL);
      if (!shell) throw new Error('GeoZ: the offline shell is missing.');
      await cache.put(APP_BASE, shell.clone());
    } catch (error) {
      await caches.delete(CORE_CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CORE_CACHE, PHOTO_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((name) =>
      name.startsWith(CACHE_PREFIX) && !keep.has(name),
    ).map((name) => caches.delete(name)));
    // Activation happens after older controlled windows have closed, so claiming
    // clients cannot hot-swap a newer release into an old running game.
    await self.clients.claim();
  })());
});

async function coreResponse(request, pathname) {
  const cache = await caches.open(CORE_CACHE);
  const cacheKey = pathname === APP_BASE ? INDEX_URL : pathname;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const response = await fetch(request);
  if (isPublicResponse(response)) await cache.put(cacheKey, response.clone());
  return response;
}

async function photoResponse(request) {
  const cache = await caches.open(PHOTO_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (isPublicResponse(response) && response.headers.get('content-type')?.startsWith('image/')) {
      await cache.put(request, response.clone());
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_CACHED_PHOTOS))
        .map((key) => cache.delete(key)));
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Photo unavailable offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // No API interception, token caching, POST queuing, or background score sync.
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('apikey')) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || !url.pathname.startsWith(APP_BASE)) return;
  const appPath = url.pathname.slice(APP_BASE.length);
  if (/^(?:api|auth|rest|functions|storage|realtime)(?:\/|$)/.test(appPath)) return;

  if (request.mode === 'navigate') {
    if (url.pathname === APP_BASE || url.pathname === INDEX_URL) {
      // One HTML/assets version stays together until the next worker activates.
      event.respondWith(coreResponse(request, INDEX_URL));
    }
    return;
  }
  if (CORE_PATHS.has(url.pathname)) {
    event.respondWith(coreResponse(request, url.pathname));
    return;
  }
  if (/^assets\/photos\/[^/]+\.(?:jpe?g|png|webp|avif)$/i.test(appPath)) {
    event.respondWith(photoResponse(request));
  }
});
