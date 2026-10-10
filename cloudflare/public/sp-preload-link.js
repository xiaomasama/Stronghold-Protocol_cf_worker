// cloudflare/public/sp-preload-link.js — the resource-preload entry *and* its background downloader.
//
// Injected into dist/index.html by cloudflare/build.mjs (the game's own code is untouched). One small chip in the
// bottom-left does three things:
//
//   * links to /preload (the manual page: progress, skip-existing, SHA-256 verification, failure list);
//   * starts a **background download** right on the game page — press ▶ and it keeps fetching while you play,
//     two files at a time, skipping whatever this browser already has (`only-if-cached` probe, no request at all);
//   * remembers that choice: the next page load resumes automatically where it stopped, so "边玩边下" survives
//     reloads, entering a match, even closing the tab and coming back.
//
// It is deliberately light on the game page: the manifest is fetched only once a download starts, the loop is
// pure `await` chains (no timers, so a hidden tab is not throttled to a crawl), and it stands down whenever the
// /preload page is running its own pass (a heartbeat in localStorage) so the two never fetch the same files.
//
// Flags (localStorage, shared with /preload):
//   sp.bg.on       '1' while the background download is wanted (auto-resume on every page load)
//   sp.bg.i        cursor into the manifest (already handled entries)
//   sp.bg.done     how many entries were fetched or skipped
//   sp.bg.total    manifest size, for the progress readout
//   sp.bg.failed   JSON array of urls that failed
//   sp.preload.ok  set on completion (the chip then shows ✓ and /preload stops nagging)
//   sp.pre.active  heartbeat written by a running /preload page: this downloader waits for it to expire
(() => {
  'use strict';
  const CONCURRENCY = 2;
  const KEY_DISMISS = 'sp.preload.seen';
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const readJson = (k, d) => { try { return JSON.parse(store.get(k, '') || '' ) ?? d; } catch { return d; } };

  if (store.get(KEY_DISMISS) || location.pathname.startsWith('/preload')) return;

  // ------------------------------------------------------------------ chip
  /**
   * The shared bottom-left chip stack (sp-announce.js's 公告 chip and, on the original upstream, sp-tweaks.js's
   * 关于本服务器 chip live in the same one). Whichever script runs first creates it; a chip only carries an
   * `order`, so the vertical arrangement does not depend on when each one appears.
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
      '#sp-chips.sp-away{display:none !important}',   // 全屏旋转提示（0.2.3 的竖屏遮罩）显示期间整列让开
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
    /** 0.2.3 在标题页底栏（.title-foot，左下角）加了「添加到桌面」按钮：整列挂件停在那一行上方 —— 实测它的
     *  顶边而不是写死数值，视图缩放 / 换语言 / 出现「继续对局」按钮都会自动跟上。 */
    const placeAboveFooter = () => {
      let bottom = 40;                                    // CSS 里的兜底值
      const foot = document.querySelector('.title-foot');
      if (foot) {
        const r = foot.getBoundingClientRect();
        if (r.height > 0 && r.bottom > 0) bottom = Math.max(bottom, Math.round(window.innerHeight - r.top + 8));
      }
      if (stack.dataset.spBottom !== String(bottom)) { stack.dataset.spBottom = String(bottom); stack.style.bottom = bottom + 'px'; }
    };
    /** 手机竖屏时游戏会盖一层全屏「请将设备横屏」遮罩（z-index 100，在本挂件之下）：它显示期间整列让开。 */
    const rotateHintOn = () => {
      const el = document.querySelector('.rotate-hint');
      return !!el && getComputedStyle(el).display !== 'none';
    };
    /** 底栏自身尺寸变化（换语言、出现「继续对局」）也要重测。 */
    let footObs = null;
    const watchFooter = () => {
      const foot = document.querySelector('.title-foot');
      if (!foot) { if (footObs) { footObs.disconnect(); footObs = null; } return; }
      if (!footObs && typeof ResizeObserver === 'function') { footObs = new ResizeObserver(() => placeAboveFooter()); footObs.observe(foot); }
    };
    const sync = () => {
      stack.classList.toggle('sp-in-game', !document.querySelector(MENUS));                     // 资源预载：局内隐藏
      stack.classList.toggle('sp-off-title', !document.querySelector('.screen.title-screen'));  // 公告 / 关于本服务器：仅标题页
      stack.classList.toggle('sp-away', rotateHintOn());                                        // 竖屏旋转提示期间整列让开
      watchFooter();
      placeAboveFooter();
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') { if (isScreenNode(r.target)) { sync(); return; } continue; }
        for (const n of r.addedNodes) if (carriesScreen(n)) { sync(); return; }
        for (const n of r.removedNodes) if (carriesScreen(n)) { sync(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('resize', sync);
    // the rotate hint reacts to the orientation media query and to `sp-rotatable`, a class device.js toggles on
    // <html> — outside the observer's body subtree, so both get their own trigger
    try { window.matchMedia('(orientation: portrait)').addEventListener('change', sync); } catch { /* older browser */ }
    new MutationObserver(() => sync()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    sync();
    return stack;
  };

  const style = document.createElement('style');
  style.textContent = [
    '#sp-preload{order:1;display:flex;align-items:center;gap:7px;',
    'padding:6px 10px;border-radius:14px;border:1px solid #2c3a35;background:rgba(10,16,14,.82);',
    'font:500 12.5px/1.2 system-ui,"Noto Sans SC",sans-serif;color:#cfe0d8;',
    'box-shadow:0 2px 12px rgba(0,0,0,.4);backdrop-filter:blur(3px)}',
    '#sp-preload:hover{border-color:#2f6d59}',
    '#sp-preload .sp-p-dot{width:6px;height:6px;border-radius:50%;background:#4ed8af;box-shadow:0 0 6px #4ed8af}',
    '#sp-preload .sp-p-link{color:#cfe0d8;text-decoration:none}',
    '#sp-preload .sp-p-link:hover{color:#eafaf4}',
    '#sp-preload .sp-p-badge{padding:1px 6px;border-radius:9px;background:#3a2a12;border:1px solid #7a5a24;color:#f6c674;font-size:11px}',
    '#sp-preload .sp-p-state{color:#4ed8af;font-variant-numeric:tabular-nums}',
    '#sp-preload .sp-p-bar{position:relative;width:64px;height:5px;border-radius:3px;background:#101715;border:1px solid #2c3a35;overflow:hidden}',
    '#sp-preload .sp-p-bar > i{display:block;height:100%;width:0;background:linear-gradient(90deg,#2f6d59,#4ed8af)}',
    '#sp-preload button{cursor:pointer;border:1px solid #2c3a35;background:transparent;color:#9fb4ac;',
    'border-radius:4px;font:inherit;padding:1px 6px}',
    '#sp-preload button:hover{color:#eafaf4;border-color:#2f6d59}',
  ].join('');
  document.head.appendChild(style);

  const chip = document.createElement('div');
  chip.id = 'sp-preload';
  const dot = document.createElement('span');
  dot.className = 'sp-p-dot';
  const link = document.createElement('a');
  link.className = 'sp-p-link';
  link.href = '/preload';
  link.textContent = '资源预载';
  link.title = '打开预载页：进度、跳过已有、校验 SHA-256';
  const state = document.createElement('span');
  state.className = 'sp-p-state';
  const bar = document.createElement('span');
  bar.className = 'sp-p-bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  const close = document.createElement('button');
  close.type = 'button';
  const CLOSE_HINT = '隐藏首页入口（可在 /preload 页恢复）';
  close.textContent = '×';
  close.title = `两步确认：${CLOSE_HINT}`;
  // 两步确认：误点一下不再等于永久失去后台下载的入口；隐藏后 /preload 页随时可以把它恢复
  let closeArmedAt = 0;
  const disarm = () => { close.textContent = '×'; close.title = `两步确认：${CLOSE_HINT}`; };
  close.addEventListener('click', () => {
    const now = Date.now();
    if (now - closeArmedAt > 3000) {
      closeArmedAt = now;
      close.textContent = '隐藏?';
      close.title = `再点一次确认隐藏；${CLOSE_HINT}`;
      setTimeout(() => { if (Date.now() - closeArmedAt >= 3000) disarm(); }, 3200);
      return;
    }
    store.set(KEY_DISMISS, '1');
    chip.remove();
  });
  chip.append(dot, link, state, bar, toggle, close);

  const attach = () => { const stack = chipStack(); if (stack) stack.appendChild(chip); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  // ------------------------------------------------------------------ state & readout
  let total = Number(store.get('sp.bg.total', '0')) || 0;
  let handled = Number(store.get('sp.bg.done', '0')) || 0;
  let running = false;
  let stopping = false;

  function render() {
    const done = !!store.get('sp.preload.ok');
    if (done) {
      state.textContent = '已完成';
      bar.style.display = 'none';
      toggle.style.display = 'none';
      return;
    }
    bar.style.display = '';
    toggle.style.display = '';
    const pct = total ? Math.min(100, Math.round((handled / total) * 100)) : 0;
    fill.style.width = `${pct}%`;
    state.textContent = running ? `${pct}%` : (handled && total ? `已下载 ${pct}%（暂停）` : '未预载');
    toggle.textContent = running ? '⏸' : '▶';
    toggle.title = running ? '暂停后台下载' : '开始后台下载（边玩边下，刷新后自动继续）';
  }

  // ------------------------------------------------------------------ background downloader
  /** The /preload page is doing its own pass right now: leave the fetching to it. */
  const foregroundBusy = () => {
    const ts = Number(store.get('sp.pre.active', '0')) || 0;
    return Date.now() - ts < 5000;
  };

  let manifest = null;
  async function loadManifest() {
    if (manifest) return manifest;
    const res = await fetch('/data/preload-manifest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const raw = await res.json();
    manifest = Array.isArray(raw.files) ? raw.files : [];
    total = manifest.length;
    store.set('sp.bg.total', String(total));
    return manifest;
  }

  async function cached(url) {
    try {
      const res = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
      return !!res;
    } catch { return false; }
  }

  async function worker(queue, totalCount) {
    while (running) {
      if (foregroundBusy()) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      const item = queue.shift();
      if (!item) return;
      const [url] = item;
      try {
        if (await cached(url)) { /* already here: nothing transferred */ }
        else {
          const res = await fetch(url, { cache: 'default' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await res.arrayBuffer();
        }
      } catch (e) {
        const failed = readJson('sp.bg.failed', []);
        if (failed.length < 200) { failed.push(url); store.set('sp.bg.failed', JSON.stringify(failed)); }
      }
      handled++;
      store.set('sp.bg.done', String(handled));
      // The cursor comes from the shared queue, not a read-modify-write on localStorage: two workers would
      // lose updates (and the counter could run past the end of the manifest).
      store.set('sp.bg.i', String(Math.max(0, totalCount - queue.length)));
      if (handled % 5 === 0) render();
    }
  }

  async function run() {
    if (running) return;
    running = true;
    stopping = false;
    render();
    try {
      const files = await loadManifest();
      let i = Number(store.get('sp.bg.i', '0')) || 0;
      if (i >= files.length) i = 0;                       // manifest replaced → start over (cached files are skipped)
      const queue = files.slice(i);
      handled = i;                                        // resume the readout where it stopped, do not restart it
      store.set('sp.bg.done', String(handled));
      render();
      const workers = Array.from({ length: CONCURRENCY }, () => worker(queue, files.length));
      await Promise.all(workers);
      if (!running || stopping) { render(); return; }
      if (queue.length === 0) {
        store.set('sp.preload.ok', String(manifest.app || '1'));
        store.del('sp.bg.on');
      }
    } catch (e) {
      console.warn('[sp-preload] background download stopped:', e && e.message);
    } finally {
      running = false;
      render();
    }
  }

  toggle.addEventListener('click', () => {
    if (store.get('sp.preload.ok')) return;             // finished: re-preload from /preload (it clears the flag)
    if (running) { stopping = true; running = false; store.del('sp.bg.on'); render(); return; }
    stopping = false;
    store.set('sp.bg.on', '1');
    run();
  });

  render();
  // Resume automatically after a reload — that is what "边玩边下" needs.
  if (store.get('sp.bg.on') && !store.get('sp.preload.ok')) run();
})();
