/**
 * PowSurf service worker — makes the app and map tiles available offline.
 *
 * App shell  : network-first (so a deploy shows up on the next online load,
 *              no version bumping needed), falling back to the cached copy.
 * Map tiles  : cache-first across every cache — the "recent" runtime cache
 *              (bounded, filled as you browse) and the offline-area caches
 *              ("powsurf-pack-*", written by app.js and only deleted by the user).
 */

'use strict';

const SHELL_CACHE  = 'powsurf-shell';
const RECENT_CACHE = 'powsurf-tiles-recent';
const RECENT_MAX   = 1500;   // tiles kept in the runtime cache (~50 MB worst case)
const SHELL_NETWORK_TIMEOUT_MS = 4000;  // weak signal on the hill → fall back to cache

const SHELL_FILES = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'leaflet.js',
  'leaflet.css',
  'maplibre-gl.js',
  'maplibre-gl.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

// Requests worth caching as map tiles. The worker's /api/ (login, trips) is
// deliberately not here — it must never be served stale.
const TILE_URL_RE = new RegExp([
  '^https://avoin-karttakuva\\.maanmittauslaitos\\.fi/',
  '^https://powsurf-heatmap\\.powsurf-heatmap\\.workers\\.dev/(?!api/)',
  '^https://cache\\.kartverket\\.no/',
  '^https://cyberjapandata\\.gsi\\.go\\.jp/',
  '^https://disaportaldata\\.gsi\\.go\\.jp/',
  '^https://s3\\.amazonaws\\.com/elevation-tiles-prod/',
  '^https://tile\\.opentopomap\\.org/',
  '^https://[a-d]\\.basemaps\\.cartocdn\\.com/',
  '^https://tile\\.openstreetmap\\.org/',
  '^https://gis3\\.nve\\.no/',
].join('|'));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // app.js downloads offline areas with cache: 'no-store' and stores them
  // itself — skip so those tiles aren't duplicated into the recent cache.
  if (req.cache === 'no-store') return;

  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    event.respondWith(shellResponse(req));
  } else if (TILE_URL_RE.test(req.url)) {
    event.respondWith(tileResponse(req));
  }
});

async function shellResponse(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SHELL_NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true }) ||
                   (req.mode === 'navigate' ? await cache.match('index.html') : null);
    return cached || Response.error();
  }
}

let _putsSinceTrim = 0;

async function tileResponse(req) {
  const cached = await caches.match(req.url, { ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(req);
  // Opaque (no-CORS) responses can't be checked for errors and count as
  // ~7 MB each against the storage quota in Chrome, so they're never cached.
  if (res.ok && res.type !== 'opaque') {
    const copy = res.clone();
    caches.open(RECENT_CACHE).then(async cache => {
      await cache.put(req.url, copy);
      if (++_putsSinceTrim >= 50) {
        _putsSinceTrim = 0;
        const keys = await cache.keys();  // insertion order → oldest first
        await Promise.all(keys.slice(0, Math.max(0, keys.length - RECENT_MAX)).map(k => cache.delete(k)));
      }
    });
  }
  return res;
}
