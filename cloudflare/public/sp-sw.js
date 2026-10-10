// cloudflare/public/sp-sw.js — registers the Service Worker (/sw.js) and exposes a small client-side API.
//
// Injected into dist/index.html by build.mjs, and also loaded by the /preload page (so the worker is registered
// whichever page the visitor opens first). Everything here is best-effort: without a Service Worker the game and
// the preload page keep working exactly as before (they fall back to the HTTP cache).
//
// Escape hatch — the whole cache layer can be switched off per browser tab without a redeploy:
//   /?nosw=1   unregister the worker, delete every `sp-*` cache, remember it for this tab and reload
//   /?nosw=0   forget that, so the next load registers again
//
// Client API (also handy from the devtools console):
//   __SP_SW__.controller()  → is this page served through the worker right now
//   __SP_SW__.info()        → { app, build, assets, data, stats } or null
//   __SP_SW__.purge()       → delete every `sp-*` cache
//   __SP_SW__.off()         → this tab runs without the worker (the ?nosw=1 switch)

(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  const OFF_KEY = 'sp.sw.off';

  const clearAll = async () => {
    try { for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister(); } catch { /* ignore */ }
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith('sp-')).map((n) => caches.delete(n)));
    } catch { /* ignore */ }
  };

  let url = null;
  try { url = new URL(location.href); } catch { /* about:blank & friends */ }
  const nosw = url ? url.searchParams.get('nosw') : null;
  if (nosw === '1') {
    try { sessionStorage.setItem(OFF_KEY, '1'); } catch { /* private mode */ }
    const clean = new URL(location.href);
    clean.searchParams.delete('nosw');            // keep any other query params
    clearAll().then(() => { try { location.replace(clean.pathname + clean.search + clean.hash); } catch { /* ignore */ } });
    return;
  }
  if (nosw === '0') { try { sessionStorage.removeItem(OFF_KEY); } catch { /* private mode */ } }
  let off = false;
  try { off = sessionStorage.getItem(OFF_KEY) === '1'; } catch { /* private mode */ }
  if (off) return;

  /** Talk to the active worker (works even before this page is controlled, via the registration). */
  const ask = (msg, timeoutMs = 2500) => new Promise((resolve) => {
    const fire = (sw) => {
      if (!sw) { resolve(null); return; }
      let ch;
      try { ch = new MessageChannel(); } catch { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), timeoutMs);
      ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data || null); };
      try { sw.postMessage(msg, [ch.port2]); } catch { clearTimeout(timer); resolve(null); }
    };
    const controller = navigator.serviceWorker.controller;
    if (controller) { fire(controller); return; }
    navigator.serviceWorker.ready.then((reg) => fire(reg.active)).catch(() => resolve(null));
  });

  const registration = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null);

  globalThis.__SP_SW__ = {
    off: () => false,
    controller: () => !!navigator.serviceWorker.controller,
    register: () => registration,
    info: () => ask({ t: 'sp-sw-info' }),
    purge: () => ask({ t: 'sp-sw-purge' }),
  };
})();
