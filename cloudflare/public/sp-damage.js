// cloudflare/public/sp-damage.js — the in-match damage panel (adapter-side; injected into dist/index.html by
// cloudflare/build.mjs; the game's own code is untouched).
//
// Bottom-left, only while a battle screen is up, toggled by its own header chip (remembered in localStorage), and
// small enough to live in the strip left of the board — the game's own bottom-left toolbar keeps its space.
// Between battles the last battle's numbers stay on screen as 「上一场」.
//
// Where the numbers come from — all of it is the game's own live state, nothing is recomputed here:
//   * the browser battle runner that plays the match on screen (public/js/battle/runner.js, also exposed as
//     `globalThis.__SP_RUNNER__` by the game itself, 0.2.1 and 0.2.2) holds the running sim — its `_entries` map
//     (the game's own test/E2E hook) is where the Battle objects live, `state()` says which one is on screen:
//       - every ally unit carries `stats.dmg` — damage it dealt to the enemy ("HP removed from the other side"),
//         so the readout is attributed **per source**: operators (`kind: 'op'`), their summons (`kind: 'token'`
//         with `ownerUnit`, credited to the owner) and devices (`kind: 'device'`, which no player owns), with a
//         「其它」 row for anything that only shows up in a player's total.
//       - `battle._perPlayer[playerId]` carries damageDealt / bossDamage / healingDone / deaths, `battle.time` is
//         the elapsed battle time (→ DPS) and `battle.killed` / `leakedCount` / `total` are the field's counters.
//       - bond effects mostly act as buffs on the operators they boost (dmgDealtMul and friends), so their damage
//         shows up under those operators; the field's active bond layers are listed from `state().bondLayers`.
//   * names come from the client's own data (`/js/data.js`: chess, devices, bonds) and, when the client ships it,
//     its i18n (`/shared/i18n.js` t). A missing module just leaves ids on screen.
//
// The 交流 wheel's panel opens right over this corner, so the whole widget stands down while it is up.
//
// The panel describes the battle *on screen* (your own field; teammates' fields have their own runner entry and are
// deliberately not mixed in). Best-effort throughout: no runner, no battle or a hidden tab leaves the game as it was.

(() => {
  'use strict';
  const ON_KEY = 'sp.dmg.on';        // '1' = readout open
  const REFRESH_MS = 250;            // the game's own detail card re-reads the sim 4×/s too
  const MAX_ROWS = 7;

  const store = {
    get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const fmt = (n) => Number(Math.round(n || 0)).toLocaleString('en-US');
  /** 12345 → 1.2万 (the header chip has room for a few characters) */
  const compact = (n) => {
    const v = Math.round(n || 0);
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
    return String(v);
  };

  // ------------------------------------------------------------------ the game's own modules, loaded lazily
  /** @type {{ currentBattle?: () => any, state?: () => any } | null} */
  let runner = globalThis.__SP_RUNNER__ || null;
  let dataMod = null;                 // { getChess, data } from /js/data.js
  let tFn = null;                     // t from /shared/i18n.js (0.2.2; absent on older checkouts)
  let storeMod = null;                // { store } from /js/store.js
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    if (!runner) import('/js/battle/runner.js').then((m) => { runner = m.battleRunner || runner; }).catch(() => {});
    import('/js/data.js').then((m) => { dataMod = m; }).catch(() => {});
    import('/js/store.js').then((m) => { storeMod = m; }).catch(() => {});
    import('/shared/i18n.js').then((m) => { if (typeof m.t === 'function') tFn = m.t; }).catch(() => {});
  };

  /**
   * The live sim of the battle on screen. `runner.currentBattle()` only carries the *identity* of it
   * (battleId / fieldId / kind / spec / time — that is what the renderer mounts), while the Battle itself
   * lives in the runner's `_entries` map, the hook the game exposes for its own tests and E2E introspection.
   * `state()` names the battle on screen, so the right entry is picked by `battleId`.
   */
  const battle = () => {
    ask();
    const r = runner;
    if (!r || !r._entries) return null;
    try {
      const st = typeof r.state === 'function' ? r.state() : null;
      const id = st && !st.loading ? st.battleId : null;
      const entries = r._entries;
      if (id && typeof entries.get === 'function') {
        const e = entries.get(id);
        if (e && e.battle) return e.battle;
      }
      const list = typeof entries.values === 'function' ? [...entries.values()] : (Array.isArray(entries) ? entries : []);
      for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].battle) return list[i].battle;
      return null;
    } catch { return null; }
  };
  const myPlayerId = () => { try { return storeMod?.store?.getState?.().me?.playerId ?? null; } catch { return null; } };
  const localize = (name) => (typeof name === 'string' ? (tFn ? tFn(name) : name) : null);
  const fromTable = (table, id) => {
    try {
      const row = dataMod?.data?.get?.(table);
      const entry = row && typeof row === 'object' ? row[id] : null;
      return entry && typeof entry.name === 'string' ? entry.name : null;
    } catch { return null; }
  };
  /** A unit's display name: operators/standing-in chess, devices, enemies — else the id itself. */
  const nameOf = (defId) => localize(fromTable('chess', defId)) || localize(fromTable('devices', defId))
    || localize(fromTable('enemies', defId)) || defId;

  // ------------------------------------------------------------------ what the panel shows
  /** Everything the readout needs, or null while there is no battle on screen. */
  function readStats() {
    const b = battle();
    if (!b) return null;
    const perPlayer = b._perPlayer && typeof b._perPlayer === 'object' ? b._perPlayer : {};
    const me = myPlayerId();
    let playerTotal = 0, boss = 0, heal = 0, deaths = 0, mine = me ? (perPlayer[me] ? Number(perPlayer[me].damageDealt) || 0 : null) : null;
    for (const pp of Object.values(perPlayer)) {
      if (!pp) continue;
      playerTotal += Number(pp.damageDealt) || 0;
      boss += Number(pp.bossDamage) || 0;
      heal += Number(pp.healingDone) || 0;
      deaths += Number(pp.deaths) || 0;
    }
    // per-source damage: operators (summons folded into their owner), devices, everything else by its own name
    const sources = new Map();
    const add = (key, label, dmg) => {
      const cur = sources.get(key);
      if (cur) cur.dmg += dmg; else sources.set(key, { key, label, dmg, kind: key.split(':')[0] });
    };
    let attributed = 0;
    for (const u of Array.isArray(b.units) ? b.units : []) {
      if (!u || u.side !== 'ally') continue;
      const dmg = Number(u && u.stats && u.stats.dmg) || 0;
      if (!(dmg > 0)) continue;
      if (u.ownerId != null) attributed += dmg;                 // the same events a player's damageDealt counts
      if (u.kind === 'op' && typeof u.defId === 'string') add(`op:${u.defId}`, nameOf(u.defId), dmg);
      else if (u.kind === 'token') {
        const owner = u.ownerUnit && typeof u.ownerUnit.defId === 'string' ? u.ownerUnit.defId : null;
        if (owner) add(`op:${owner}`, nameOf(owner), dmg);       // a summon is its operator's damage
        else if (typeof u.defId === 'string') add(`token:${u.defId}`, `${nameOf(u.defId)}·召唤物`, dmg);
      } else if (u.kind === 'device' && typeof u.defId === 'string') add(`device:${u.defId}`, `${nameOf(u.defId)}·装置`, dmg);
      else if (typeof u.defId === 'string') add(`unit:${u.defId}`, nameOf(u.defId), dmg);
    }
    const unattributed = Math.max(0, playerTotal - attributed);
    if (unattributed > 0 && playerTotal > 0 && unattributed / playerTotal > 0.005) add('rest:unattributed', '其它（未归属）', unattributed);
    const rows = [...sources.values()].sort((a, b2) => b2.dmg - a.dmg);
    const total = rows.reduce((n, r) => n + r.dmg, 0);
    const ops = rows.slice(0, MAX_ROWS).map((r) => ({ key: r.key, label: r.label, dmg: r.dmg, share: total > 0 ? r.dmg / total : 0 }));
    const restDmg = rows.slice(MAX_ROWS).reduce((n, r) => n + r.dmg, 0);
    const time = Number(b.time) || 0;
    return {
      time,
      dps: time > 0 ? total / time : 0,
      total, boss, heal, deaths,
      mine: typeof mine === 'number' ? mine : null,
      played: playerTotal,
      killed: Number(b.killed) || 0,
      leaked: Number(b.leakedCount) || 0,
      totalEnemies: Number(b.total) || 0,
      ops,
      restDmg,
      bonds: readBonds(),
    };
  }

  /** The field's active bond layers (my own when I am a player of it, else the strongest of each bond). */
  function readBonds() {
    try {
      const st = runner && typeof runner.state === 'function' ? runner.state() : null;
      const map = st && st.bondLayers && typeof st.bondLayers === 'object' ? st.bondLayers : null;
      if (!map) return [];
      const me = myPlayerId();
      const mine = me && map[me] && typeof map[me] === 'object' ? map[me] : null;
      const layers = new Map();
      for (const [pid, per] of Object.entries(mine ? { [me]: mine } : map)) {
        if (!per || typeof per !== 'object') continue;
        for (const [bondId, n] of Object.entries(per)) {
          const v = Number(n) || 0;
          if (v > 0) layers.set(bondId, Math.max(layers.get(bondId) || 0, v));
        }
      }
      return [...layers.entries()]
        .sort((a, b2) => b2[1] - a[1])
        .slice(0, 5)
        .map(([bondId, n]) => ({ label: localize(fromTable('bonds', bondId)) || bondId, layers: n }));
    } catch { return []; }
  }

  // ------------------------------------------------------------------ the widget
  const style = document.createElement('style');
  style.textContent = [
    // fixed pixel sizes on purpose: the game UI scales with the viewport, our overlay must not.
    // `bottom` here is only the fallback: placeAboveToolbar() measures the game's own bottom-left toolbar
    // (the 交流 button and friends) and parks the widget just above it, so the chip can never shave its top edge.
    '#sp-dmg{position:fixed;left:10px;bottom:46px;z-index:2147482500;display:none;flex-direction:column;align-items:flex-start;',
    'gap:5px;font:500 12px/1.35 system-ui,"Noto Sans SC",sans-serif;color:#cfe0d8;pointer-events:none}',
    '#sp-dmg.sp-in-match{display:flex}',
    '#sp-dmg.sp-away{display:none !important}',   // 交流轮盘打开时整条让开（轮盘就挂在左下角这位置上）
    '#sp-dmg>*{pointer-events:auto}',
    '#sp-dmg-head{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:12px;border:1px solid #2c3a35;',
    'background:rgba(10,16,14,.82);cursor:pointer;backdrop-filter:blur(3px);box-shadow:0 2px 12px rgba(0,0,0,.4)}',
    '#sp-dmg-head:hover{border-color:#2f6d59;color:#eafaf4}',
    '#sp-dmg-head .sp-dmg-ico{color:#f6a329}',
    '#sp-dmg-head .sp-dmg-sum{color:#eafaf4;font-variant-numeric:tabular-nums}',
    '#sp-dmg-head .sp-dmg-caret{color:#8ea79e}',
    '#sp-dmg-body{width:206px;max-height:42vh;overflow:auto;padding:8px 10px;border-radius:8px;border:1px solid #2c3a35;',
    'background:rgba(8,13,11,.86);backdrop-filter:blur(3px);box-shadow:0 6px 20px rgba(0,0,0,.5);display:none}',
    '#sp-dmg.sp-open #sp-dmg-body{display:block}',
    '#sp-dmg-body .sp-dmg-cap{color:#8ea79e;font-size:11px;margin-bottom:5px}',
    '#sp-dmg-body dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:1px 8px}',
    '#sp-dmg-body dt{color:#8ea79e;font-weight:400}',
    '#sp-dmg-body dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}',
    '#sp-dmg-body dd .sp-dmg-sub{color:#8ea79e;font-size:11px;margin-left:4px}',
    '#sp-dmg-body hr{border:0;border-top:1px solid #22302b;margin:6px 0 5px}',
    '#sp-dmg-body .sp-dmg-sec{color:#8ea79e;font-size:11px;margin:0 0 3px}',
    '#sp-dmg-ops{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}',
    '#sp-dmg-ops li{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:baseline}',
    '#sp-dmg-ops .sp-dmg-op{color:#cfe0d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#sp-dmg-ops .sp-dmg-op.is-device{color:#a9b8b2}',
    '#sp-dmg-ops .sp-dmg-v{font-variant-numeric:tabular-nums;color:#eafaf4}',
    '#sp-dmg-ops .sp-dmg-p{color:#8ea79e;font-size:11px;min-width:30px;text-align:right}',
    '#sp-dmg-body .sp-dmg-bonds{color:#cfe0d8}',
    '#sp-dmg-body .sp-dmg-empty{color:#8ea79e}',
  ].join('');
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sp-dmg';
  const head = document.createElement('div');
  head.id = 'sp-dmg-head';
  head.title = '伤害统计：点一下开/关（会记住）';
  const ico = document.createElement('span'); ico.className = 'sp-dmg-ico'; ico.textContent = '⚔';
  const label = document.createElement('span'); label.textContent = '伤害统计';
  const sum = document.createElement('span'); sum.className = 'sp-dmg-sum';
  const caret = document.createElement('span'); caret.className = 'sp-dmg-caret'; caret.textContent = '▸';
  head.append(ico, label, sum, caret);

  const body = document.createElement('div');
  body.id = 'sp-dmg-body';
  const cap = document.createElement('div'); cap.className = 'sp-dmg-cap';
  const list = document.createElement('dl');
  /** one row: <dt>label</dt><dd>value<span class=sub>…</span></dd> */
  const row = (text, withSub = false) => {
    const dt = document.createElement('dt'); dt.textContent = text;
    const dd = document.createElement('dd');
    const v = document.createElement('span');
    dd.appendChild(v);
    let sub = null;
    if (withSub) { sub = document.createElement('span'); sub.className = 'sp-dmg-sub'; dd.appendChild(sub); }
    list.append(dt, dd);
    return { dt, dd, v, sub };
  };
  const rTotal = row('总输出');
  const rMine = row('我的', true);
  const rBoss = row('对领袖');
  const rHeal = row('治疗');
  const rCounts = row('击杀 / 漏怪', true);
  const rDeaths = row('阵亡');
  const br1 = document.createElement('hr');
  const secOps = document.createElement('div'); secOps.className = 'sp-dmg-sec'; secOps.textContent = '输出来源';
  const ops = document.createElement('ul'); ops.id = 'sp-dmg-ops';
  const br2 = document.createElement('hr');
  const secBonds = document.createElement('div'); secBonds.className = 'sp-dmg-sec'; secBonds.textContent = '羁绊';
  const bonds = document.createElement('div'); bonds.className = 'sp-dmg-bonds';
  const empty = document.createElement('div'); empty.className = 'sp-dmg-empty'; empty.textContent = '等待战斗开始…';
  body.append(cap, list, br1, secOps, ops, br2, secBonds, bonds, empty);
  root.append(head, body);

  let open = store.get(ON_KEY) === '1';
  const paintOpen = () => {
    root.classList.toggle('sp-open', open);
    caret.textContent = open ? '▾' : '▸';
    // a tap must wake the refresh up too — sync() owns the interval (it is the only place that starts/stops it),
    // and without this the readout stayed a single snapshot until the next screen change
    sync();
    if (open) tick();
  };
  head.addEventListener('click', () => { open = !open; store.set(ON_KEY, open ? '1' : '0'); paintOpen(); });

  const attach = () => { if (document.body) document.body.appendChild(root); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  // ------------------------------------------------------------------ refreshing
  let timer = null;
  let last = null;                   // the last battle's numbers, kept on screen between battles as 「上一场」
  let lastKey = '';
  function tick() {
    try { tickInner(); } catch (e) { if (!tick.warned) { tick.warned = true; console.warn('[sp-damage] refresh failed', e); } }
  }
  function tickInner() {
    const live = battle() ? readStats() : null;
    if (live) last = live;
    const st = live || last;
    if (!st) {
      sum.textContent = '';
      cap.textContent = '没有正在进行的战斗';
      list.style.display = 'none'; br1.style.display = 'none'; secOps.style.display = 'none';
      ops.style.display = 'none'; br2.style.display = 'none'; secBonds.style.display = 'none'; bonds.style.display = 'none';
      empty.style.display = '';
      return;
    }
    const after = !live;
    list.style.display = ''; br1.style.display = ''; secOps.style.display = ''; empty.style.display = 'none';
    sum.textContent = compact(st.total);
    cap.textContent = `${after ? '上一场' : '本场'} · ${st.time.toFixed(1)}s · DPS ${fmt(st.dps)}`;
    rTotal.v.textContent = fmt(st.total);
    rMine.dt.style.display = rMine.dd.style.display = st.mine == null ? 'none' : '';
    if (st.mine != null) {
      rMine.v.textContent = fmt(st.mine);
      rMine.sub.textContent = st.total > 0 ? `${Math.round((st.mine / st.total) * 100)}%` : '';
    }
    rBoss.v.textContent = fmt(st.boss);
    rHeal.v.textContent = fmt(st.heal);
    rCounts.v.textContent = `${st.killed} / ${st.leaked}`;
    rCounts.sub.textContent = st.totalEnemies ? `共 ${st.totalEnemies}` : '';
    rDeaths.v.textContent = fmt(st.deaths);
    const key = st.ops.map((o) => o.key).join('|') + '|' + (st.restDmg > 0 ? 'rest' : '');
    if (key !== lastKey) {
      lastKey = key;
      ops.textContent = '';
      for (const o of st.ops) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = `sp-dmg-op${o.key.startsWith('device:') ? ' is-device' : ''}`;
        name.textContent = o.label;
        name.title = o.key;
        const v = document.createElement('span'); v.className = 'sp-dmg-v';
        const p = document.createElement('span'); p.className = 'sp-dmg-p';
        li.append(name, v, p);
        li._cells = { v, p };
        ops.appendChild(li);
      }
      if (st.restDmg > 0) {
        const li = document.createElement('li');
        const name = document.createElement('span'); name.className = 'sp-dmg-op'; name.textContent = '其余项合计';
        const v = document.createElement('span'); v.className = 'sp-dmg-v';
        const p = document.createElement('span'); p.className = 'sp-dmg-p'; p.textContent = '';
        li.append(name, v, p);
        li._cells = { v, p };
        ops.appendChild(li);
      }
      ops.style.display = st.ops.length || st.restDmg > 0 ? '' : 'none';
    }
    const rows = ops.children;
    for (let i = 0; i < st.ops.length && i < rows.length; i++) {
      const li = rows[i];
      if (!li || !li._cells) continue;
      li._cells.v.textContent = fmt(st.ops[i].dmg);
      li._cells.p.textContent = `${Math.round(st.ops[i].share * 100)}%`;
    }
    const restLi = st.restDmg > 0 ? rows[st.ops.length] : null;
    if (restLi && restLi._cells) restLi._cells.v.textContent = fmt(st.restDmg);
    if (st.bonds.length) {
      bonds.textContent = st.bonds.map((b) => `${b.label} ${b.layers}`).join(' · ');
      br2.style.display = ''; secBonds.style.display = ''; bonds.style.display = '';
    } else {
      br2.style.display = 'none'; secBonds.style.display = 'none'; bonds.style.display = 'none';
    }
  }

  /** The 交流 wheel's panel is rendered right above its button — i.e. exactly over this widget's corner. */
  const wheelOpen = () => !!document.querySelector('.ewheel__panel');
  /** The full-screen portrait rotate hint (0.2.3) sits below this widget in z-order: stand down for it too. */
  const rotateHintOn = () => {
    const el = document.querySelector('.rotate-hint');
    return !!el && getComputedStyle(el).display !== 'none';
  };

  /**
   * Park the widget just above the game's own bottom-left toolbar (交流 / ⚙ / 图鉴 / 全屏). The toolbar's place
   * moves with the viewport scale, rotation and safe areas, so it is measured instead of assumed — a fixed
   * `bottom` shaved the 交流 button's top edge by a few pixels on a 1280×720 viewport.
   */
  const placeAboveToolbar = () => {
    let bottom = 46;                                   // the toolbar is not on screen yet (or a menu screen): keep clear of it
    const btn = document.querySelector('.ewheel__btn') || document.querySelector('.ewheel');
    if (btn) {
      const r = btn.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, Math.round(window.innerHeight - r.top + 8));
    }
    if (root.dataset.spBottom !== String(bottom)) {
      root.dataset.spBottom = String(bottom);
      root.style.bottom = `${bottom}px`;
    }
  };

  /**
   * Start/stop the refresh with the screen: the panel only exists in a match, the timer only while it is open and
   * nothing else claims the corner (the wheel).
   */
  const sync = () => {
    const inMatch = !!document.querySelector('.screen.gm');
    const away = wheelOpen() || rotateHintOn();
    placeAboveToolbar();
    root.classList.toggle('sp-in-match', inMatch);
    root.classList.toggle('sp-away', away);
    const shouldRun = inMatch && open && !away;
    if (shouldRun && !timer) { tick(); timer = setInterval(tick, REFRESH_MS); }
    if (!shouldRun && timer) { clearInterval(timer); timer = null; }
    if (inMatch && !open && !away) { tick(); sum.textContent = ''; last = null; lastKey = ''; }   // collapsed: no timer
  };
  const isScreenNode = (n) => n.nodeType === 1 && n.classList && n.classList.contains('screen');
  const isWheelNode = (n) => n.nodeType === 1 && n.classList && (n.classList.contains('ewheel__panel') || n.classList.contains('ewheel'));
  const carriesScreen = (n) => n.nodeType === 1 && (isScreenNode(n) || isWheelNode(n) || !!n.querySelector('.screen') || !!n.querySelector('.ewheel__panel'));
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') { if (isScreenNode(r.target) || isWheelNode(r.target)) { sync(); return; } continue; }
      for (const n of r.addedNodes) if (carriesScreen(n)) { sync(); return; }
      for (const n of r.removedNodes) if (carriesScreen(n)) { sync(); return; }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('resize', sync);
  // the rotate hint and `sp-rotatable` (a class device.js toggles on <html>) sit outside the body subtree
  try { window.matchMedia('(orientation: portrait)').addEventListener('change', sync); } catch { /* older browser */ }
  new MutationObserver(() => sync()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  paintOpen();
  sync();
})();
