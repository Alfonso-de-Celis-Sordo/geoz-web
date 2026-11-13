/* GeoZ service-worker source. scripts/build-sw.mjs injects the build manifest.
 * Publish a complete shell promptly. The app defers page reloads until its menu.
 */
'use strict';

const BUILD_VERSION = '76c4e9e126ba2b472da5';
const APP_BASE = "/geoz-web/";
const PRECACHE_URLS = [
  "/geoz-web/assets/index-BcrLoX7W.css",
  "/geoz-web/assets/index-jZNzmx-6.js",
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
    // Older installed clients do not implement an update handshake. Activate
    // after the complete precache so their next navigation gets the new shell.
    // This does not navigate/reload their documents or interrupt their game.
    await self.skipWaiting();
  })());
});

async function pruneUnusedCaches(excludedClientIds = []) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Keep every older release while another window might still need its assets.
  // A solo navigation can discard them; neither nick nor game data is cached here.
  if (clients.some(client => !excludedClientIds.includes(client.id) &&
    new URL(client.url).origin === self.location.origin &&
    new URL(client.url).pathname.startsWith(APP_BASE))) return;
  const names = await caches.keys();
  const current = names.indexOf(CORE_CACHE);
  if (current < 0) return;
  // Never delete the cache of a newer worker still installing beside this one.
  const older = names.slice(0, current).filter(name => name.startsWith(`${CACHE_PREFIX}core-`));
  await Promise.all(older.flatMap(name => [name, name.replace(`${CACHE_PREFIX}core-`, `${CACHE_PREFIX}photos-`)])
    .map(name => caches.delete(name)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await pruneUnusedCaches();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const script = event.data?.script;
  if (event.data?.type !== 'GEOZ_VERSION' || typeof script !== 'string' ||
    !script.startsWith(`${APP_BASE}assets/`) || !script.endsWith('.js')) return;
  event.waitUntil((async () => {
    // A network-loaded page can be newer than its controller. Only reload a
    // bundle positively identified in a previous release, never downgrade it.
    const names = await caches.keys();
    const current = names.indexOf(CORE_CACHE);
    let outdated = false;
    if (!CORE_PATHS.has(script) && current >= 0) {
      for (const name of names.slice(0, current)) {
        if (name.startsWith(`${CACHE_PREFIX}core-`) && await (await caches.open(name)).match(script)) {
          outdated = true; break;
        }
      }
    }
    event.source?.postMessage({ type: 'GEOZ_VERSION', script, outdated });
  })());
});

async function previousAssetResponse(request, pathname) {
  for (const name of (await caches.keys()).reverse()) {
    if (!name.startsWith(`${CACHE_PREFIX}core-`) || name === CORE_CACHE) continue;
    const cached = await (await caches.open(name)).match(pathname);
    if (cached) return cached;
  }
  return fetch(request);
}

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
      event.waitUntil(pruneUnusedCaches([event.clientId, event.resultingClientId]));
    }
    return;
  }
  if (CORE_PATHS.has(url.pathname)) {
    event.respondWith(coreResponse(request, url.pathname));
    return;
  }
  // Content-hashed bundles belonging to an already open older page remain usable.
  if (/^assets\/[^/]+\.(?:js|css|woff2?)$/.test(appPath)) {
    event.respondWith(previousAssetResponse(request, url.pathname));
    return;
  }
  if (/^assets\/photos\/[^/]+\.(?:jpe?g|png|webp|avif)$/i.test(appPath)) {
    event.respondWith(photoResponse(request));
  }
});
