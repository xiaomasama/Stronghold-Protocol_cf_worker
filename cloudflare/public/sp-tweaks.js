// cloudflare/public/sp-tweaks.js — landing-page customisations for this deployment.
//
// Injected into dist/index.html by cloudflare/build.mjs (the game's own code is untouched). Three jobs:
//
//   1. Hide xinhai-ai's own "预载资源" launcher (bottom-right .res-pill + its 设置 row). That feature scans the file
//      system, needs a Service Worker and a Node endpoint (/data/resource-manifest.json), so it cannot work on this
//      deployment — the working entry is the bottom-left 资源预载 chip (public/sp-preload-link.js) instead.
//
//   2. 「关于本服务器」. The checkout either ships such a dialog (xinhai-ai's fork, whose rows name the fork author)
//      or has none at all (the original sganggs 0.2.1). Either way the content comes from GET /api/server-info:
//      with an existing dialog its rows are replaced in place (same markup, same styling); without one a chip and
//      a small dialog of our own are added — and only while a document is actually configured, so an unconfigured
//      deployment shows nothing extra.
//
//   3. Nothing else: no network requests before the dialog is needed, no timers.

(() => {
  'use strict';
  const self = document.currentScript || document.querySelector('script[src$="/sp-tweaks.js"]');
  const aboutUi = (self && self.dataset ? self.dataset.aboutUi : '') || 'none'; // 'checkout' | 'none' (baked in at build time)

  // ------------------------------------------------------------------ 1. hide the fork's unusable preload UI
  /**
   * The shared bottom-left chip stack (sp-preload-link.js's 资源预载 chip and sp-announce.js's 公告 chip live in
   * the same one). Whichever script runs first creates it; a chip only carries an `order`.
   */
  const chipStack = () => {
    let stack = document.getElementById('sp-chips');
    if (stack) return stack;
    if (!document.body) return null;
    const css = document.createElement('style');
    css.textContent = [
      '#sp-chips{position:fixed;left:14px;bottom:40px;z-index:2147482000;display:flex;flex-direction:column-reverse;',
      'gap:6px;align-items:flex-start;pointer-events:none}',
      '#sp-chips>*{pointer-events:auto}',
      // 公告 / 关于本服务器 只属于最初始的标题页；资源预载在局内隐藏（大厅、房间仍然可用）
      '#sp-chips.sp-off-title #sp-ann-chip,#sp-chips.sp-off-title #sp-about{display:none !important}',
      '#sp-chips.sp-in-game #sp-preload{display:none !important}',
    ].join('');
    document.head.appendChild(css);
    stack = document.createElement('div');
    stack.id = 'sp-chips';
    document.body.appendChild(stack);
    // Per-chip visibility, driven by the client's own screen classes (`title-screen` / `lobby-screen` /
    // `room-screen` are the outer menus; `brief` / `draft` / `gm` / `result` / `gload` / `crash` are in-game and
    // boot): the preload entry is useful in any menu and hidden in-game, while 公告 and 关于本服务器 belong to the
    // very first screen only. The router keys the screen by route, so a route change replaces that element:
    // reacting to a `.screen` node appearing, disappearing or changing class is enough — no polling, and in-match
    // DOM churn never touches a `.screen` node.
    const isScreenNode = (n) => n.nodeType === 1 && n.classList && n.classList.contains('screen');
    const carriesScreen = (n) => n.nodeType === 1 && (isScreenNode(n) || !!n.querySelector('.screen'));
    const MENUS = '.screen.title-screen, .screen.lobby-screen, .screen.room-screen';
    const sync = () => {
      stack.classList.toggle('sp-in-game', !document.querySelector(MENUS));                     // 资源预载：局内隐藏
      stack.classList.toggle('sp-off-title', !document.querySelector('.screen.title-screen'));  // 公告 / 关于本服务器：仅标题页
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') { if (isScreenNode(r.target)) { sync(); return; } continue; }
        for (const n of r.addedNodes) if (carriesScreen(n)) { sync(); return; }
        for (const n of r.removedNodes) if (carriesScreen(n)) { sync(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', sync);
    sync();
    return stack;
  };

  const style = document.createElement('style');
  style.textContent = [
    '.title-preload,.res-pill{display:none !important}',
    '.sp-hidden-row{display:none !important}',
    // our own 关于本服务器 chip + dialog (used only when the checkout has none)
    '#sp-about{order:3;display:inline-flex;align-items:center;gap:6px;',
    'padding:6px 10px;border-radius:14px;border:1px solid #2c3a35;background:rgba(10,16,14,.82);color:#cfe0d8;',
    'font:500 12.5px/1.2 system-ui,"Noto Sans SC",sans-serif;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4)}',
    '#sp-about:hover{border-color:#2f6d59;color:#eafaf4}',
    '#sp-about-modal{position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;',
    'background:rgba(4,8,7,.72);font:400 14px/1.6 system-ui,"Noto Sans SC",sans-serif;color:#d8e3de}',
    '#sp-about-modal .sp-about-card{width:min(560px,90vw);max-height:80vh;overflow:auto;background:#111614;',
    'border:1px solid #2c3a35;border-radius:6px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '#sp-about-modal h2{margin:0 0 10px;font-size:18px;letter-spacing:.04em;color:#4ed8af}',
    '#sp-about-modal h3{margin:14px 0 6px;font-size:14px;color:#9fb4ac;letter-spacing:.06em}',
    '#sp-about-modal dl{margin:0}',
    '#sp-about-modal dt{color:#8ea79e;font-size:12.5px;margin-top:10px}',
    '#sp-about-modal dd{margin:2px 0 0}',
    '#sp-about-modal a{color:#4ed8af}',
    '#sp-about-modal p{margin:6px 0;white-space:pre-wrap}',
    '#sp-about-modal .sp-about-actions{display:flex;justify-content:flex-end;margin-top:14px}',
    '#sp-about-modal button{cursor:pointer;border:1px solid #2f6d59;background:#173a30;color:#bdf0e0;',
    'border-radius:4px;font:inherit;padding:6px 14px}',
  ].join('');
  document.head.appendChild(style);

  /** Its settings row (设置 ▸ 预载资源) — matched by text, re-applied whenever the settings modal re-renders. */
  const hidePreloadRow = () => {
    for (const row of document.querySelectorAll('.set-row')) {
      if (row.classList.contains('sp-hidden-row')) continue;
      if (!/预载资源/.test(row.textContent || '')) continue;
      row.classList.add('sp-hidden-row');
    }
  };
  const observer = new MutationObserver(() => { hidePreloadRow(); patchAbout(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  hidePreloadRow();

  // ------------------------------------------------------------------ 2. 「关于本服务器」 from /api/server-info
  /** @type {{ title?: string, intro?: string, rows?: Array<{ label: string, value: string, href?: string, hint?: string }>, disclaimer?: string[] | null } | null} */
  let info = null;
  let loaded = false;

  async function loadInfo() {
    if (loaded) return info;
    loaded = true;
    try {
      const res = await fetch('/api/server-info', { cache: 'no-store' });
      const body = res.status === 200 ? await res.json() : null;
      info = body && typeof body === 'object' && (Array.isArray(body.rows) || body.title || body.intro) ? body : null;
    } catch { info = null; }
    return info;
  }

  /** Rebuild the rows of the checkout's own dialog, in its own markup so its styling carries over. */
  function fillExisting(modal, cfg) {
    if (cfg.title) {
      const heading = modal.querySelector('h2, .modal__title, [class*="title"]');
      if (heading && /关于本服务器/.test(heading.textContent || '')) heading.textContent = cfg.title;
    }
    const list = modal.querySelector('dl.title-about__links');
    if (list && Array.isArray(cfg.rows) && cfg.rows.length) {
      list.textContent = '';
      if (cfg.intro) {
        const p = document.createElement('p');
        p.className = 'title-about__hint';
        p.textContent = cfg.intro;
        list.appendChild(p);
      }
      for (const row of cfg.rows) list.appendChild(rowNode(row, true));
    }
    if (Array.isArray(cfg.disclaimer) && cfg.disclaimer.length) {
      const block = modal.querySelector('.title-about__disclaimer');
      if (block) {
        block.textContent = '';
        for (const text of cfg.disclaimer) {
          const p = document.createElement('p');
          p.textContent = text;
          block.appendChild(p);
        }
      }
    }
  }

  /** One `<div><dt>label</dt><dd>value</dd><p class=hint></p></div>` row. */
  function rowNode(row, withHintClass) {
    const box = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = row.label;
    const dd = document.createElement('dd');
    if (row.href) {
      const a = document.createElement('a');
      a.href = row.href;
      if (/^https?:/i.test(row.href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.textContent = row.value || row.href;
      dd.appendChild(a);
    } else {
      dd.textContent = row.value || '';
    }
    box.append(dt, dd);
    if (row.hint) {
      const hint = document.createElement('p');
      if (withHintClass) hint.className = 'title-about__hint';
      hint.style.color = '#8ea79e';
      hint.style.fontSize = '12.5px';
      hint.textContent = row.hint;
      box.appendChild(hint);
    }
    return box;
  }

  async function patchAbout() {
    const modal = document.querySelector('.title-about');
    if (!modal || modal.dataset.spPatched === '1') return;
    const cfg = await loadInfo();
    if (!cfg) { modal.dataset.spPatched = '1'; return; } // nothing configured: leave the checkout's own content
    modal.dataset.spPatched = '1';
    try { fillExisting(modal, cfg); } catch { /* never break the dialog */ }
  }

  // ------------------------------------------------------------------ 3. our own dialog, when the checkout has none
  /** @param {object} cfg */
  function buildOwnAbout(cfg) {
    const chip = document.createElement('button');
    chip.id = 'sp-about';
    chip.type = 'button';
    chip.textContent = `ⓘ ${cfg.title || '关于本服务器'}`;

    let modal = null;
    const close = () => { modal?.remove(); modal = null; };
    chip.addEventListener('click', () => {
      if (modal) { close(); return; }
      modal = document.createElement('div');
      modal.id = 'sp-about-modal';
      const card = document.createElement('div');
      card.className = 'sp-about-card';
      const h = document.createElement('h2');
      h.textContent = cfg.title || '关于本服务器';
      card.appendChild(h);
      if (cfg.intro) {
        const p = document.createElement('p');
        p.style.color = '#9fb4ac';
        p.textContent = cfg.intro;
        card.appendChild(p);
      }
      if (Array.isArray(cfg.rows) && cfg.rows.length) {
        const dl = document.createElement('dl');
        for (const row of cfg.rows) dl.appendChild(rowNode(row, false));
        card.appendChild(dl);
      }
      if (Array.isArray(cfg.disclaimer) && cfg.disclaimer.length) {
        const h3 = document.createElement('h3');
        h3.textContent = '版权与免责声明';
        card.appendChild(h3);
        for (const text of cfg.disclaimer) {
          const p = document.createElement('p');
          p.style.color = '#8ea79e';
          p.style.fontSize = '12.5px';
          p.textContent = text;
          card.appendChild(p);
        }
      }
      const actions = document.createElement('div');
      actions.className = 'sp-about-actions';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.textContent = '关闭';
      ok.addEventListener('click', close);
      actions.appendChild(ok);
      card.appendChild(actions);
      modal.appendChild(card);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      document.body.appendChild(modal);
    });

    const attach = () => { const stack = chipStack(); if (stack) stack.appendChild(chip); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
    else attach();
  }

  if (aboutUi === 'none') {
    // The original upstream has no such dialog: provide one, but only while a document is configured.
    loadInfo().then((cfg) => { if (cfg && (cfg.rows?.length || cfg.title || cfg.intro)) buildOwnAbout(cfg); }).catch(() => {});
  } else {
    patchAbout();
  }
})();
