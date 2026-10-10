// cloudflare/public/sw.js — the Service Worker of this deployment.
// build.mjs copies this file to dist/sw.js and replaces __SP_APP__ / __SP_BUILD__ with the real values, so a
// deploy always ships a sw.js whose bytes differ → the browser installs the update → old caches are purged.
//
// Why this exists: the browser's HTTP cache is a shared, self-managed budget. With a 600 MB+ asset set it evicts
// what the user preloaded, so "preload once, never download again" does not hold (measured: a second pass
// re-fetched ~96% of the files). Cache Storage is per-origin, page-owned and covered by the storage quota (a
// large fraction of the free disk, and persistent once the site is installed or persist() is granted) — a
// preload written there stays, and the game's own asset requests are served from it with zero network.
//
// Routing — same-origin GET only, and every other request is left completely untouched:
//   /assets/ /fonts/ /vendor/   cache-first   — the big, stable art. A miss fetches once and stores, so simply
//                                              playing also fills the cache (边玩边下 without the chip).
//   /data/ /i18n/               network-first — small JSON that changes per build; the cache is the offline
//                                              fallback, never the source of truth.
//   everything else             untouched     — the shell (index.html, /js, /css, /shared), /ws, /healthz,
//                                              /api/*, /packs/*, /sp-*.js and /data/preload-manifest.json always
//                                              come from the network, so updates are never stale.
//
// Cache names: `sp-assets-v<APP>` survives rebuilds of the same release (the art rarely changes), while
// `sp-data-<BUILD>` is dropped as soon as the build changes. Every other `sp-*` cache is deleted on activate.
//
// The page can talk to this worker (see public/sp-sw.js): `sp-sw-info` → { app, build, assets, data, stats } and
// `sp-sw-purge` → delete every `sp-*` cache (the /preload page's 清空资源缓存 button).

'use strict';

const APP = '__SP_APP__';
const BUILD = '__SP_BUILD__';
const CACHE_ASSETS = 'sp-assets-v' + APP;
const CACHE_DATA = 'sp-data-' + BUILD;
const KEEP = [CACHE_ASSETS, CACHE_DATA];

const ASSET_PREFIXES = ['/assets/', '/fonts/', '/vendor/'];
const DATA_PREFIXES = ['/data/', '/i18n/'];
const DATA_SKIP = ['/data/preload-manifest.json'];   // the list itself must never be served stale

const stats = { hits: 0, misses: 0, stored: 0, errors: 0, since: Date.now() };

const inPrefix = (path, list) => list.some((p) => path.startsWith(p));
const isAsset = (path) => inPrefix(path, ASSET_PREFIXES);
const isData = (path) => inPrefix(path, DATA_PREFIXES) && !DATA_SKIP.includes(path);
/** Only a plain, complete, same-origin 200 may be stored. */
const cacheable = (res) => !!res && res.ok && res.status === 200 && res.type === 'basic';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names
        .filter((n) => n.startsWith('sp-') && !KEEP.includes(n))
        .map((n) => caches.delete(n)));
    } catch { /* a cache API hiccup must not block activation */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                                   // POST /api/announce & friends
  if (req.headers.has('range')) return;                               // never interfere with ranged reads
  if (req.cache === 'no-store' || req.cache === 'reload') return;     // the page asked to bypass caches
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (isAsset(path)) { event.respondWith(assetFirst(event, req)); return; }
  if (isData(path)) { event.respondWith(dataFirst(req)); return; }
});

/** /assets|/fonts|/vendor: serve from the cache, else fetch once and store (with a stale fallback offline). */
async function assetFirst(event, req) {
  let cache;
  try { cache = await caches.open(CACHE_ASSETS); } catch { return fetch(req); }
  const hit = await cache.match(req);
  if (hit) { stats.hits += 1; return hit; }
  stats.misses += 1;
  try {
    const res = await fetch(req);
    if (cacheable(res)) {
      // store in the background: the response goes out now, the copy lands a moment later
      event.waitUntil(cache.put(req, res.clone()).then(() => { stats.stored += 1; }).catch(() => {}));
    }
    return res;
  } catch (err) {
    stats.errors += 1;
    const stale = await cache.match(req);
    if (stale) return stale;
    throw err;
  }
}

/** /data|/i18n: the network is the source of truth; the cache only answers when the network cannot. */
async function dataFirst(req) {
  let cache = null;
  try { cache = await caches.open(CACHE_DATA); } catch { /* no cache: straight to the network */ }
  try {
    const res = await fetch(req);
    if (cache && cacheable(res)) cache.put(req, res.clone()).catch(() => {});
    stats.misses += 1;
    return res;
  } catch (err) {
    stats.errors += 1;
    const hit = cache ? await cache.match(req) : null;
    if (hit) { stats.hits += 1; return hit; }
    throw err;
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => { try { if (port) port.postMessage(payload); } catch { /* the page is gone */ } };
  if (data.t === 'sp-sw-info') {
    reply({ ok: true, app: APP, build: BUILD, assets: CACHE_ASSETS, data: CACHE_DATA, stats: { ...stats } });
    return;
  }
  if (data.t === 'sp-sw-purge') {
    event.waitUntil((async () => {
      let deleted = [];
      try {
        const names = await caches.keys();
        deleted = names.filter((n) => n.startsWith('sp-'));
        await Promise.all(deleted.map((n) => caches.delete(n)));
      } catch { /* report what we managed */ }
      Object.assign(stats, { hits: 0, misses: 0, stored: 0, errors: 0 });
      reply({ ok: true, deleted });
    })());
  }
});
