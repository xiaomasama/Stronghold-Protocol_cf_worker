// cloudflare/public/preload.js — the resource preload / verify page (cloudflare/public/preload.html).
//
// The page reads /data/preload-manifest.json, which the *server* generates at build time: every URL the client
// will ask for, with the size and SHA-256 of the bytes this deployment actually serves. That is what makes the
// two guarantees below possible without the page having to know how the client builds asset URLs.
//
//   * 开始预载 — an `only-if-cached` probe first: a resource already in this browser is skipped without a network
//     request; only the rest is downloaded (and drained, so the cache entry is committed).
//   * 校验资源 — probe, then read the cached body and compare length + SHA-256 with the manifest: proof that what
//     the game will load is byte-identical to what the server holds.
//
// A run always ends with a prominent result line and a document.title prefix (so a background tab reports it too).
(() => {
  'use strict';
  const CONCURRENCY = 6;
  const el = (id) => document.getElementById(id);
  const ui = {
    go: el('go'), verify: el('verify'), stop: el('stop'), retry: el('retry'), list: el('list'),
    result: el('result'), fill: el('fill'), pct: el('pct'), now: el('now'), total: el('total'), bytes: el('bytes'),
    skipped: el('skipped'), done: el('done'), passed: el('passed'), failed: el('failed'),
    elapsed: el('elapsed'), speed: el('speed'), warnbox: el('warnbox'), missingBox: el('missingBox'),
    failbox: el('failbox'), faillist: el('faillist'), state: el('state'),
    chipState: el('chipState'), chipToggle: el('chipToggle'),
  };

  /** @type {{ files: [string, number, string][], missing: string[] } | null} */
  let manifest = null;
  let canProbe = null; // whether `only-if-cached` works in this browser
  const state = { mode: null, running: false, total: 0, bytes: 0, i: 0, skipped: 0, done: 0, passed: 0, failed: [], startedAt: 0, hashing: false };

  const mib = (n) => `${(n / 1048576).toFixed(1)} MiB`;
  const fmt = (n) => n.toLocaleString('en-US');

  /** Is `url` already in this browser's cache? (no network request at all) */
  async function cached(url) {
    if (canProbe === false) return false;
    try {
      const res = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
      canProbe = true;
      return !!res && (res.ok || res.type === 'opaque');
    } catch {
      // A cache miss rejects with a TypeError; an unsupported browser rejects the same way. Probing a URL the
      // page itself just loaded tells the two apart (see detectProbe()).
      return false;
    }
  }

  /**
   * Does this browser honour `only-if-cached`? Probe a URL the page has just put in the cache (the entry must be
   * *fresh* for the probe to hit, which is true for the assets: they carry max-age=86400).
   */
  async function detectProbe() {
    try {
      await (await fetch('/js/main.js', { cache: 'default' })).arrayBuffer();
      const res = await fetch('/js/main.js', { cache: 'only-if-cached', mode: 'same-origin' }).catch(() => null);
      canProbe = !!res;
    } catch { canProbe = false; }
    if (!canProbe) {
      ui.warnbox.hidden = false;
      ui.warnbox.textContent = '提示：此浏览器不支持缓存探测（only-if-cached），脚本资源仍会复用缓存（条件请求 304），但需要一次网络往返。';
    }
  }

  /** Did the last fetch of `url` come from the cache? (Resource Timing: 0 transferred bytes) */
  function fromCache(url) {
    try {
      const list = performance.getEntriesByName(url, 'resource');
      const e = list[list.length - 1];
      return !!e && e.transferSize === 0 && e.decodedBodySize > 0;
    } catch { return false; }
  }

  function setResult(kind, html) {
    ui.result.className = kind;
    ui.result.innerHTML = html;
    if (kind === 'ok') document.title = '✓ 完成 · 资源预载';
    else if (kind === 'bad') document.title = '✗ 有失败 · 资源预载';
    else document.title = '运行中 · 资源预载';
  }

  function render() {
    // `passed` is a subset of skipped+done in verify mode: the progress term counts each file once.
    const processed = Math.min(state.total || Infinity, state.skipped + state.done + state.failed.length);
    const pctDone = state.total ? Math.min(1, processed / state.total) : 0;
    ui.fill.style.width = `${(pctDone * 100).toFixed(1)}%`;
    ui.pct.textContent = `${(pctDone * 100).toFixed(0)}%`;
    ui.total.textContent = state.total ? fmt(state.total) : '—';
    ui.bytes.textContent = state.bytes ? mib(state.bytes) : '—';
    ui.skipped.textContent = fmt(state.skipped);
    ui.done.textContent = fmt(state.done);
    ui.passed.textContent = fmt(state.passed);
    ui.failed.textContent = fmt(state.failed.length);
    const secs = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
    ui.elapsed.textContent = `${secs.toFixed(1)}s`;
    ui.speed.textContent = secs > 0.5 && processed ? `${(processed / secs).toFixed(1)} 个/秒` : '—';
    ui.failbox.hidden = state.failed.length === 0;
    ui.faillist.innerHTML = '';
    for (const f of state.failed.slice(0, 80)) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = f.why;
      li.append(code, ' ', document.createTextNode(f.url));
      ui.faillist.appendChild(li);
    }
    ui.retry.disabled = state.running || state.failed.length === 0;
    ui.stop.disabled = !state.running;
    ui.go.disabled = state.running;
    ui.verify.disabled = state.running;
    ui.state.textContent = state.running
      ? (state.mode === 'verify' ? '校验中…' : '预载中…')
      : (state.total ? '就绪' : '正在读取清单…');
    ui.state.className = !state.running && state.total && !state.failed.length ? 'done' : '';
  }

  const sha256 = async (buf) => {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  /** One queue item: [url, size, sha256] */
  async function work([url, size, hash]) {
    if (state.mode === 'verify') {
      // Verification reads the bytes: fetch with `default` (a stale entry is revalidated, a missing one downloaded)
      // and judge what came back — that is the thing the game will get.
      let buf;
      try {
        const res = await fetch(url, { cache: 'default' });
        if (!res.ok) { state.failed.push({ url, why: `HTTP ${res.status}` }); return; }
        buf = await res.arrayBuffer();
      } catch (e) { state.failed.push({ url, why: String((e && e.message) || e) }); return; }
      if (fromCache(url)) state.skipped++; else state.done++;
      if (buf.byteLength !== size) { state.failed.push({ url, why: `长度不符 ${buf.byteLength}≠${size}` }); return; }
      if (hash && crypto.subtle) {
        state.hashing = true;
        let got;
        try { got = await sha256(buf); } catch { got = null; }
        if (got && got !== hash) { state.failed.push({ url, why: '哈希不符' }); return; }
      }
      state.passed++;
      return;
    }
    // Fast path: a *fresh* cached entry is skipped without any request at all.
    if (await cached(url)) { state.skipped++; return; }
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) { state.failed.push({ url, why: `HTTP ${res.status}` }); return; }
      await res.arrayBuffer();  // drain: some browsers only commit the cache entry once the body is consumed
      // A stale-but-cached entry was revalidated (304, nothing transferred) rather than downloaded.
      if (fromCache(url)) state.skipped++; else state.done++;
    } catch (e) {
      state.failed.push({ url, why: String((e && e.message) || e) });
    }
  }

  async function workerItems(queue) {
    while (state.running) {
      const item = queue.shift();
      if (!item) return;
      ui.now.textContent = item[0];
      // Heartbeat: the game page's background downloader (public/sp-preload-link.js) stands down while a /preload
      // pass is running. Written per item because a hidden tab throttles timers but not this loop.
      try { localStorage.setItem('sp.pre.active', String(Date.now())); } catch { /* private mode */ }
      try { await work(item); } catch (e) { state.failed.push({ url: item[0], why: String((e && e.message) || e) }); }
      render();
    }
  }

  async function run(mode) {
    if (state.running || !manifest) return;
    const queue = state.queue && state.queue.length ? state.queue : manifest.files.slice();
    state.mode = mode;
    state.running = true;
    state.total = manifest.files.length;
    state.bytes = manifest.bytes || 0;
    state.i = 0;
    state.skipped = 0;
    state.done = 0;
    state.passed = 0;
    state.failed = [];
    state.startedAt = performance.now();
    setResult('busy', mode === 'verify' ? '正在校验缓存中的资源…' : '正在预载（已在本机的会跳过）…');
    render();
    const workers = Array.from({ length: CONCURRENCY }, () => workerItems(queue));
    await Promise.all(workers);
    state.running = false;
    ui.now.textContent = '';
    state.queue = null;
    try { localStorage.removeItem('sp.pre.active'); localStorage.removeItem('sp.bg.on'); } catch { /* private mode */ }
    const secs = ((performance.now() - state.startedAt) / 1000).toFixed(1);
    const tail = `（${fmt(state.skipped)} 个未发请求直接跳过，${fmt(state.done)} 个已获取，用时 ${secs}s）`;
    // Tell the landing page's chip (public/sp-preload-link.js) that this browser is warmed up.
    if (!state.failed.length) { try { localStorage.setItem('sp.preload.ok', String(manifest.app || '1')); } catch { /* private mode */ } }
    if (mode === 'verify') {
      const ok = state.failed.length === 0;
      const hashed = crypto.subtle ? '大小 + SHA-256' : '大小（此环境不支持 WebCrypto 哈希，仅比长度）';
      setResult(ok ? 'ok' : 'bad', ok
        ? `✓ 校验通过：${fmt(state.passed)} 个文件全部与服务器一致（${hashed}），用时 ${secs}s。`
        : `✗ 校验完成：通过 ${fmt(state.passed)}，不符 ${fmt(state.failed.length)}（见下方列表，含原因），用时 ${secs}s。`);
    } else {
      const ok = state.failed.length === 0;
      setResult(ok ? 'ok' : 'bad', ok
        ? `✓ 预载完成：共 ${fmt(state.total)} 个文件，${fmt(state.skipped)} 个已在本机（未发请求即跳过），${fmt(state.done)} 个已获取${tail}。`
        : `预载结束：跳过 ${fmt(state.skipped)}，已获取 ${fmt(state.done)}，失败 ${fmt(state.failed.length)}（见下方列表）${tail}。`);
    }
    render();
  }

  async function load() {
    ui.state.textContent = '正在读取清单…';
    try {
      const res = await fetch('/data/preload-manifest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const files = Array.isArray(raw.files) ? raw.files.filter((f) => Array.isArray(f) && f.length >= 2) : [];
      manifest = { files, missing: Array.isArray(raw.missing) ? raw.missing : [], bytes: files.reduce((n, f) => n + (f[1] || 0), 0), app: raw.app || '' };
    } catch (e) {
      manifest = null;
      setResult('bad', `读取清单失败：${e && e.message} —— 服务器还没有 <code>/data/preload-manifest.json</code>，请先在服务器上重新构建（<code>npm run build</code>）并部署。`);
      ui.state.textContent = '清单不可用';
      return;
    }
    state.total = manifest.files.length;
    state.bytes = manifest.bytes;
    state.skipped = state.done = state.passed = 0;
    state.failed = [];
    state.startedAt = 0;
    state.running = false;
    try {
      if (localStorage.getItem('sp.bg.on') && !localStorage.getItem('sp.preload.ok')) {
        ui.warnbox.hidden = false;
        ui.warnbox.textContent = '游戏页的后台下载正在进行（边玩边下）。在这里点「开始预载」会由本页接管，后台下载随即暂停。';
      }
    } catch { /* private mode */ }
    ui.missingBox.hidden = manifest.missing.length === 0;
    if (manifest.missing.length) {
      ui.missingBox.textContent = `服务器上还缺 ${fmt(manifest.missing.length)} 个清单里的文件（例如 ${manifest.missing.slice(0, 2).join('、')}）——`
        + '跑 node tools/setup.mjs 补齐后重新构建部署；在那之前这些会以失败计入。';
    }
    try {
      const ok = localStorage.getItem('sp.preload.ok');
      if (ok && manifest.app && ok !== String(manifest.app)) localStorage.removeItem('sp.preload.ok'); // new build → ask again
    } catch { /* private mode */ }
    setResult('busy', `清单就绪：${fmt(manifest.files.length)} 个文件 / ${mib(manifest.bytes)}${manifest.app ? `（对应服务器 ${manifest.app}）` : ''}。点击「开始预载」或「校验资源」。`);
    document.title = '资源预载';
    render();
  }

  ui.go.addEventListener('click', () => { state.queue = null; run('preload'); });
  ui.verify.addEventListener('click', () => { state.queue = null; run('verify'); });
  ui.stop.addEventListener('click', () => { state.running = false; });
  ui.retry.addEventListener('click', () => {
    state.queue = state.failed.map((f) => {
      const hit = manifest.files.find((x) => x[0] === f.url);
      return hit || [f.url, 0, null];
    });
    run(state.mode === 'verify' ? 'verify' : 'preload');
  });
  ui.list.addEventListener('click', () => { load(); });

  // ---- the landing-page「资源预载」chip: /preload is also where a hidden one comes back
  const KEY_CHIP_HIDDEN = 'sp.preload.seen';   // the same localStorage key the chip writes when hidden
  const renderChipToggle = () => {
    let hidden = false;
    try { hidden = localStorage.getItem(KEY_CHIP_HIDDEN) === '1'; } catch { /* private mode */ }
    ui.chipState.textContent = hidden ? '· 当前：已隐藏（首页不显示入口）' : '· 当前：显示';
    ui.chipState.className = hidden ? 'off' : 'on';
    ui.chipToggle.textContent = hidden ? '在首页恢复挂件' : '隐藏首页挂件';
  };
  ui.chipToggle.addEventListener('click', () => {
    try {
      if (localStorage.getItem(KEY_CHIP_HIDDEN) === '1') localStorage.removeItem(KEY_CHIP_HIDDEN);
      else localStorage.setItem(KEY_CHIP_HIDDEN, '1');
    } catch { /* private mode */ }
    renderChipToggle();
  });
  renderChipToggle();

  load().then(detectProbe);
})();
