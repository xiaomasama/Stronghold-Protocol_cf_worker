// cloudflare/public/sp-announce.js — the announcement banner of this deployment (adapter-side, injected into
// dist/index.html by cloudflare/build.mjs; the game's own code is untouched).
//
//   * pulls GET /api/announcement (a scrolling notice) and GET /api/popup-announcement (a popup) at boot and
//     every POLL_MS — works even when the push channel cannot connect;
//   * keeps a WebSocket to /announce-ws for instant delivery when the operator publishes (POST /api/announce);
//   * a notice is shown once per browser: dismissing it (or its endAt passing) remembers its id in localStorage;
//   * the bottom-left 「公告」 chip (public/sp-chipstack.js layout) is the way back in — it is there as long as
//     something is live, and opens a panel listing every current notice. So closing the banner never loses it.
//
// Failure is always silent: no endpoint, 204, a dead socket or localStorage disabled leaves the game untouched.
(() => {
  'use strict';
  const POLL_MS = 15000;
  const STORE_KEY = 'sp.announce.seen';
  const LEVELS = { info: '#4ed8af', warning: '#f6a329', urgent: '#e73118' };

  /** @returns {Set<string>} ids this browser already dismissed */
  const seen = () => {
    try { return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set(); }
  };
  const remember = (id) => {
    try {
      const set = seen();
      set.add(id);
      localStorage.setItem(STORE_KEY, JSON.stringify([...set].slice(-100)));
    } catch { /* private mode: it will simply show again */ }
  };

  /**
   * The shared bottom-left chip stack — the same one the 资源预载 chip and (on the original upstream) the
   * 关于本服务器 chip live in. Whichever script runs first creates it; chips only carry an `order`, so their
   * vertical arrangement does not depend on when they appear.
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
    // fixed pixel sizes on purpose: the game UI scales with the viewport (its root font is a clamp of vw/vh),
    // an overlay that inherited that would be as large as the game itself
    '#sp-ann-bar{position:fixed;left:0;right:0;top:0;z-index:2147483000;display:flex;gap:8px;align-items:center;',
    'padding:7px 12px;font:500 13px/1.45 system-ui,"Noto Sans SC",sans-serif;color:#e8f5f0;',
    'background:linear-gradient(180deg,rgba(8,14,12,.94),rgba(8,14,12,.86));border-bottom:1px solid #2c3a35;',
    'box-shadow:0 2px 12px rgba(0,0,0,.45)}',
    '#sp-ann-bar .sp-ann-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor}',
    '#sp-ann-bar .sp-ann-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#sp-ann-bar button{flex:none;cursor:pointer;border:1px solid #2c3a35;background:transparent;color:#9fb4ac;',
    'border-radius:4px;font:inherit;padding:2px 8px}',
    '#sp-ann-chip{order:2;display:flex;align-items:center;gap:7px;padding:6px 10px;border-radius:14px;',
    'border:1px solid #2c3a35;background:rgba(10,16,14,.82);cursor:pointer;backdrop-filter:blur(3px);',
    'font:500 12.5px/1.2 system-ui,"Noto Sans SC",sans-serif;color:#cfe0d8;box-shadow:0 2px 12px rgba(0,0,0,.4)}',
    '#sp-ann-chip:hover{border-color:#2f6d59;color:#eafaf4}',
    '#sp-ann-chip .sp-ann-cdot{width:6px;height:6px;border-radius:50%;flex:none;box-shadow:0 0 6px currentColor}',
    '#sp-ann-chip .sp-ann-badge{padding:1px 6px;border-radius:9px;background:#3a2a12;border:1px solid #7a5a24;',
    'color:#f6c674;font-size:11px}',
    '#sp-ann-modal{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;',
    'background:rgba(4,8,7,.72);font:400 14px/1.6 system-ui,"Noto Sans SC",sans-serif;color:#d8e3de}',
    '#sp-ann-modal .sp-ann-card{width:min(520px,88vw);max-height:82vh;overflow:auto;background:#111614;',
    'border:1px solid #2c3a35;border-radius:6px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '#sp-ann-modal h2{margin:0 0 8px;font-size:18px;letter-spacing:.04em}',
    '#sp-ann-modal p{margin:0 0 14px;white-space:pre-wrap}',
    '#sp-ann-modal a{color:#4ed8af}',
    '#sp-ann-modal .sp-ann-actions{display:flex;gap:10px;justify-content:flex-end;align-items:center}',
    '#sp-ann-modal button{cursor:pointer;border:1px solid #2c3a35;background:transparent;color:#d8e3de;',
    'border-radius:4px;font:inherit;padding:6px 14px}',
    '#sp-ann-modal button.sp-ann-primary{background:#173a30;border-color:#2f6d59;color:#bdf0e0}',
    // the 「公告」 chip's panel: one block per notice
    '#sp-ann-modal .sp-ann-item+.sp-ann-item{margin-top:14px;padding-top:12px;border-top:1px solid #22302b}',
    '#sp-ann-modal .sp-ann-item h3{margin:0 0 6px;font-size:16px;letter-spacing:.03em}',
  ].join('');
  document.head.appendChild(style);

  /** The live notices this page knows about: [scroll, popup]. */
  const state = { scroll: null, popup: null };
  const active = () => [state.scroll, state.popup].filter(Boolean);

  /** The most alarming level among the live notices (urgent > warning > info). */
  const topLevel = (notices) => (notices.some((a) => a.level === 'urgent') ? 'urgent'
    : notices.some((a) => a.level === 'warning') ? 'warning' : 'info');

  // ------------------------------------------------------------------ the banner
  /** @type {HTMLElement | null} */
  let bar = null;
  let barId = null;

  function hideBar() {
    bar?.remove();
    bar = null;
    barId = null;
  }

  /** Show a notice as the top bar. A dismissed notice is not shown again — the chip below is the way back. */
  function showBar(a) {
    if (!a || seen().has(a.id)) return;
    if (barId === a.id) return;
    hideBar();
    barId = a.id;
    bar = document.createElement('div');
    bar.id = 'sp-ann-bar';
    const dot = document.createElement('span');
    dot.className = 'sp-ann-dot';
    dot.style.color = LEVELS[a.level] || LEVELS.info;
    dot.style.background = LEVELS[a.level] || LEVELS.info;
    const text = document.createElement('span');
    text.className = 'sp-ann-text';
    text.textContent = (a.title ? `${a.title}：` : '') + a.text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.title = '收起横幅（公告仍可在左下角「公告」里查看）';
    close.addEventListener('click', () => { remember(a.id); hideBar(); updateChip(); });
    bar.append(dot, text, close);
    document.body.appendChild(bar);
  }

  // ------------------------------------------------------------------ auto-popup
  /** @type {HTMLElement | null} */
  let modal = null;

  function showPopup(a) {
    if (!a || seen().has(a.id) || modal || panel) return;
    modal = document.createElement('div');
    modal.id = 'sp-ann-modal';
    const card = document.createElement('div');
    card.className = 'sp-ann-card';
    const h = document.createElement('h2');
    h.textContent = a.title || '公告';
    h.style.color = LEVELS[a.level] || LEVELS.info;
    const p = document.createElement('p');
    p.textContent = a.text;
    const actions = document.createElement('div');
    actions.className = 'sp-ann-actions';
    if (a.url) {
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看详情';
      actions.appendChild(link);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'sp-ann-primary';
    ok.textContent = '知道了';
    const dismiss = () => { remember(a.id); modal?.remove(); modal = null; updateChip(); };
    ok.addEventListener('click', dismiss);
    modal.addEventListener('click', (e) => { if (e.target === modal) dismiss(); });
    actions.appendChild(ok);
    card.append(h, p, actions);
    modal.appendChild(card);
    document.body.appendChild(modal);
  }

  // ------------------------------------------------------------------ the chip (a permanent way back in)
  /** @type {HTMLElement | null} */
  let chip = null;
  let chipDot = null;
  let chipBadge = null;

  /** One notice block for the panel: title, text, optional 查看详情. */
  function noticeBlock(a) {
    const box = document.createElement('div');
    box.className = 'sp-ann-item';
    const h = document.createElement('h3');
    h.textContent = a.title || '公告';
    h.style.color = LEVELS[a.level] || LEVELS.info;
    const p = document.createElement('p');
    p.textContent = a.text;
    box.append(h, p);
    if (a.url) {
      const link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看详情';
      box.appendChild(link);
    }
    return box;
  }

  /** @type {HTMLElement | null} */
  let panel = null;
  let panelKey = '';
  /** @param {() => void} onClose */
  let panelKeyHandler = null;

  function closePanel() {
    panel?.remove();
    panel = null;
    panelKey = '';
    if (panelKeyHandler) { document.removeEventListener('keydown', panelKeyHandler); panelKeyHandler = null; }
  }

  /** The chip: present while anything is live, badge 「新」 until this browser has read it. */
  function updateChip() {
    const notices = active();
    if (!notices.length) {
      chip?.remove();
      chip = null;
      closePanel();
      return;
    }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'sp-ann-chip';
      chip.title = '查看当前公告';
      chipDot = document.createElement('span');
      chipDot.className = 'sp-ann-cdot';
      const label = document.createElement('span');
      label.textContent = '公告';
      chipBadge = document.createElement('span');
      chipBadge.className = 'sp-ann-badge';
      chipBadge.textContent = '新';
      chip.append(chipDot, label, chipBadge);
      chip.addEventListener('click', openPanel);
      const stack = chipStack();
      if (!stack) { chip = null; return; } // no <body> yet: the next update retries
      stack.appendChild(chip);
    }
    const color = LEVELS[topLevel(notices)] || LEVELS.info;
    chipDot.style.color = color;
    chipDot.style.background = color;
    const unread = notices.some((a) => !seen().has(a.id));
    chipBadge.style.display = unread ? '' : 'none';
  }

  /** The panel: every live notice in one card. Opening it counts as reading (the 「新」 badge clears). */
  function openPanel() {
    const notices = active();
    if (!notices.length) return;
    const key = notices.map((a) => a.id).join('|');
    if (panel && panelKey === key) { closePanel(); return; } // the chip toggles
    for (const a of notices) remember(a.id);
    modal?.remove();  // the auto-popup and the panel are the same overlay slot
    modal = null;
    closePanel();
    panelKey = key;
    panel = document.createElement('div');
    panel.id = 'sp-ann-modal';
    const card = document.createElement('div');
    card.className = 'sp-ann-card';
    const actions = document.createElement('div');
    actions.className = 'sp-ann-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'sp-ann-primary';
    ok.textContent = '关闭';
    ok.addEventListener('click', closePanel);
    actions.appendChild(ok);
    if (notices.length === 1) {
      // exactly the auto-popup's shape, so one notice reads the same either way
      const a = notices[0];
      const h = document.createElement('h2');
      h.textContent = a.title || '公告';
      h.style.color = LEVELS[a.level] || LEVELS.info;
      const p = document.createElement('p');
      p.textContent = a.text;
      card.append(h, p);
      if (a.url) {
        const link = document.createElement('a');
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '查看详情';
        card.appendChild(link);
      }
      card.appendChild(actions);
    } else {
      const h = document.createElement('h2');
      h.textContent = `公告（${notices.length}）`;
      card.appendChild(h);
      for (const a of notices) card.appendChild(noticeBlock(a));
      card.appendChild(actions);
    }
    panel.appendChild(card);
    panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(); });
    panelKeyHandler = (e) => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('keydown', panelKeyHandler);
    document.body.appendChild(panel);
    updateChip(); // the 新 badge is gone now
  }

  // ------------------------------------------------------------------ wiring
  function apply(msg) {
    if (!msg || msg.t !== 'announce') return;
    state.scroll = msg.scroll || null;
    state.popup = msg.popup || null;
    if (state.scroll) showBar(state.scroll); else if (barId) hideBar();
    showPopup(state.popup);
    updateChip();
  }

  async function poll() {
    try {
      const [scroll, popup] = await Promise.all([
        fetch('/api/announcement', { cache: 'no-store' }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null),
        fetch('/api/popup-announcement', { cache: 'no-store' }).then((r) => (r.status === 200 ? r.json() : null)).catch(() => null),
      ]);
      apply({ t: 'announce', scroll, popup });
    } catch { /* ignore */ }
  }

  // Instant delivery. Polling above is the baseline; this channel is best-effort.
  function connect() {
    let ws;
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/announce-ws`); } catch { return; }
    ws.addEventListener('message', (ev) => {
      try { apply(JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    ws.addEventListener('close', () => setTimeout(connect, 30000));
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } });
  }

  const start = () => {
    poll();
    setInterval(poll, POLL_MS);
    connect();
    // the popup may arrive before the app renders; keep the banner above the game's own layers
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
