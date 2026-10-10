#!/usr/bin/env node
// cloudflare/tools/smoke.mjs — end-to-end check of a running deployment.
//
//   node cloudflare/tools/smoke.mjs                       # against http://127.0.0.1:8787 (wrangler dev)
//   node cloudflare/tools/smoke.mjs https://game.example.com
//
// It walks the same path a browser does: the static tree, /healthz, then a real WebSocket session through the
// shared protocol — hello → welcome, room.create → room.state, a second player joining, and a reconnect with
// the session token (the resume path). Every check prints ok/FAIL and the process exits non-zero on failure.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const wsBase = base.replace(/^http/, 'ws');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

let failures = 0;
const ok = (name, extra = '') => console.log(`  ok   ${name}${extra ? ` — ${extra}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL ${name} — ${detail}`); };
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'condition failed'));

/** fetch with a timeout that never throws (returns {status, headers, text} or an error string). */
async function get(path, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { ...init, signal: ctrl.signal, redirect: 'manual' });
    const body = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', cache: res.headers.get('cache-control') || '', etag: res.headers.get('etag'), body };
  } catch (e) {
    return { status: 0, error: e && e.message };
  } finally {
    clearTimeout(t);
  }
}

/** A WebSocket session driven through the shared protocol; `next(type)` resolves with the next frame of that type. */
function session(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    const inbox = [];
    const waiters = [];
    const seen = [];
    const timer = setTimeout(() => reject(new Error(`${label}: timeout connecting`)), timeoutMs);
    const deliver = (msg) => {
      seen.push(msg.t);
      const i = waiters.findIndex((w) => w.type === msg.t);
      if (i >= 0) { const [w] = waiters.splice(i, 1); w.resolve(msg); return; }
      inbox.push(msg);
    };
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(api); });
    ws.addEventListener('message', (ev) => { try { deliver(JSON.parse(ev.data)); } catch { /* ignore */ } });
    ws.addEventListener('error', () => reject(new Error(`${label}: socket error`)));
    ws.addEventListener('close', (ev) => { for (const w of waiters.splice(0)) w.reject(new Error(`${label}: closed code=${ev.code}`)); });
    const api = {
      ws,
      seen,
      send(msg) { ws.send(JSON.stringify(msg)); return api; },
      request(t, extra = {}, waitFor = null) {
        const rid = api.rid = (api.rid || 0) + 1;
        ws.send(JSON.stringify({ t, ...extra, rid }));
        return api.next(waitFor || 'ok', rid);
      },
      next(type, rid = null) {
        const found = inbox.findIndex((m) => m.t === type && (rid == null || m.rid === rid));
        if (found >= 0) return Promise.resolve(inbox.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const w = { type, rid, resolve: res, reject: rej };
          waiters.push(w);
          setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) { waiters.splice(i, 1); rej(new Error(`${label}: no ${type} within ${timeoutMs} ms (saw: ${seen.join(', ')})`)); }
          }, timeoutMs);
        });
      },
      close() { try { ws.close(1000, 'smoke'); } catch { /* ignore */ } },
    };
  });
}

// ------------------------------------------------------------------------------------------------
// 1. static tree (mirrors server/index.js mounts)
// ------------------------------------------------------------------------------------------------

console.log(`\nsmoke test against ${base}\n\n[static]`);
{
  const r = await get('/');
  check(r.status === 200 && r.type.includes('text/html'), 'GET / → index.html', `${r.status} ${r.type}`);
  check(/<div id="app"/.test(r.body || ''), 'index.html looks like the game page');
}
for (const [path, expect] of [
  ['/js/main.js', 'text/javascript'],
  ['/css/theme.css', 'text/css'],
  ['/shared/constants.js', 'text/javascript'],
  ['/sim/constants.js', 'text/javascript'],
  ['/vendor/preact.module.js', 'text/javascript'],
  ['/data/config.json', 'application/json'],
  ['/data/local-assets.json', 'application/json'],
  ['/data.js', 'text/javascript'],
  ['/favicon.ico', null],
]) {
  const r = await get(path);
  if (path === '/favicon.ico') { check(r.status === 404 || r.status === 200, 'GET /favicon.ico → 404 or 200', String(r.status)); continue; }
  check(r.status === 200 && (!expect || r.type.includes(expect)), `GET ${path} → ${expect}`, `${r.status} ${r.type}`);
}
{
  const r = await get('/sim/nodeData.js');
  check(r.status === 404, 'GET /sim/nodeData.js → 404 (Node-only loader is not served)', String(r.status));
  const shim = await get('/data.js');
  check(/simdata\.js/.test(shim.body || ''), '/data.js is the browser data stand-in');
  const long = await get('/css/theme.css', { headers: { Range: 'bytes=0-9' } });
  check(long.status === 206 || long.status === 200 || long.status === 304, 'Range request is answered (206/200/304)', String(long.status));
}

// Game art / audio, when this checkout has them (public/assets is a per-machine download, .gitignore'd).
// The manifest is the same file the browser reads; the first entry of each kind has to be servable, and the
// extension-less audio route (/media/…, shared/media.js) has to resolve back to the real file.
console.log('\n[assets]');
{
  const manifest = JSON.parse(readFileSync(`${repo}data/assets.json`, 'utf8'));
  const paths = [];
  const walk = (o) => {
    if (Array.isArray(o)) for (const v of o) walk(v);
    else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v);
    else if (typeof o === 'string' && /^\/assets\/.*\.[a-z0-9]{2,5}$/i.test(o)) paths.push(o);
  };
  walk(manifest);
  const pick = (ext, prefix = '') => paths.find((p) => p.toLowerCase().endsWith(ext) && p.startsWith(prefix) && existsSync(repo + 'public' + p));
  const img = pick('.png', '/assets/char/') || pick('.png');
  const audio = pick('.mp3', '/assets/audio/') || pick('.mp3');
  if (!img && !audio) {
    console.log('  skip  this checkout has no public/assets (run `node tools/setup.mjs` for the full game)');
  }
  if (img) {
    const r = await get(img);
    check(r.status === 200 && r.type.startsWith('image/'), `GET ${img.split('/').slice(-2).join('/')} → image`, `${r.status} ${r.type}`);
    check(!!r.cache && r.cache.includes('max-age=86400'), '/assets/* carries the 1-day Cache-Control', r.cache || '(none)');
  }
  if (audio) {
    const direct = await get(audio);
    check(direct.status === 200, `GET ${audio.split('/').slice(-2).join('/')} → audio`, `${direct.status} ${direct.type}`);
    const bare = audio.replace(/^\/assets\/audio\//, '').replace(/\.[a-z0-9]+$/i, '');
    const viaMedia = await get(`/media/${bare}`);
    check(viaMedia.status === 200 && viaMedia.type.startsWith('audio/'), `GET /media/${bare} → the extension-less audio route`, `${viaMedia.status} ${viaMedia.type}`);
    const ranged = await get(`/media/${bare}`, { headers: { Range: 'bytes=0-99' } });
    // The Node server answered 206 here; the asset store returns the whole file (200) and ignores Range.
    // Nothing in the client asks for ranges (BGM goes through fetch + Web Audio), so a full response is fine.
    check(ranged.status === 206 || ranged.status === 200, `Range header answered (${ranged.status} — ${ranged.status === 206 ? 'partial' : 'full body; the client never asks for ranges'})`, String(ranged.status));
    const missMedia = await get('/media/bgm/does-not-exist');
    check(missMedia.status === 404, 'GET /media/bgm/does-not-exist → 404', String(missMedia.status));
  }
  const localArt = await get('/data/local-assets.json');
  let art = null;
  try { art = JSON.parse(localArt.body); } catch { /* ignore */ }
  const localArtPresent = existsSync(`${repo}data/local-assets.json`);
  check(localArt.status === 200 && art && (localArtPresent ? art.count > 0 : art.count === 0),
    localArtPresent ? `local-client art manifest served (${art ? art.count : '-'} entries)` : 'empty local-art stand-in served',
    localArtPresent ? 'from data/local-assets.json' : 'because the manifest is absent');
  if (art && art.count > 0 && art.groups) {
    // groups hold { [name]: { path, w, h, kind } } records (docs/ASSETS.md)
    const first = Object.values(art.groups)
      .flatMap((g) => Object.values(g))
      .map((v) => (typeof v === 'string' ? v : v && v.path))
      .find((p) => typeof p === 'string' && p.startsWith('/assets/'));
    if (first) {
      const r = await get(first);
      check(r.status === 200, `local-client art file served (${first.split('/').slice(-1)[0]})`, `${r.status} ${r.type}`);
    } else {
      console.log('  note  local-art manifest has no /assets/ path to probe');
    }
  }
}

// Content packs + language files (0.2.x): the client asks for /packs/index.json at boot and loads
// /i18n/<code>.json + /data/i18n/<code>.json; /packs/<id>/<file> only serves what a manifest names.
console.log('\n[packs]');
{
  const index = await get('/packs/index.json');
  let body = null;
  try { body = JSON.parse(index.body); } catch { /* ignore */ }
  check(index.status === 200 && body && Array.isArray(body.packs), 'GET /packs/index.json → the pack index',
    `${index.status}, ${body && body.packs ? body.packs.length : '-'} pack(s)`);
  check(!!body && body.app === APP_VERSION, 'pack index reports the app version', body ? String(body.app) : '-');
  const langs = (body && body.packs || []).filter((p) => p.type === 'lang').map((p) => p.lang);
  const localLangs = readdirSync(`${repo}public/i18n`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  check(localLangs.every((l) => langs.includes(l)), 'every language of public/i18n is in the index', langs.join(', ') || '(none)');
  const ui = langs.length ? await get(`/i18n/${langs[0]}.json`) : null;
  if (ui) check(ui.status === 200 && ui.type.includes('json'), `GET /i18n/${langs[0]}.json → the language's UI strings`, `${ui.status}`);
  const dataLang = langs.length ? await get(`/data/i18n/${langs[0]}.json`) : null;
  if (dataLang) check(dataLang.status === 200, `GET /data/i18n/${langs[0]}.json → the language's game texts`, String(dataLang.status));
  // the whitelist: files a manifest does not name are never served (the pack folder is not a directory listing)
  const notServed = await get('/packs/README.md');
  check(notServed.status === 404, 'GET /packs/README.md → 404 (not named by any manifest)', String(notServed.status));
  const traversal = await get('/packs/..%2Fdata%2Fconfig.json');
  check(traversal.status === 404, 'GET /packs/..%2Fdata%2Fconfig.json → 404 (traversal refused)', String(traversal.status));
  const langFile = langs.length ? await get(`/packs/${langs[0]}/ui.json`) : null;
  if (langFile) check(langFile.status === 404, 'GET /packs/<lang>/<file> → 404 (language packs are plain files)', String(langFile.status));
}

// Site announcements + the adapter's preload page (src/announce.js, public/sp-announce.js, public/preload.html)
console.log('\n[announce & preload]');
{
  const scroll = await get('/api/announcement');
  let body = null;
  try { body = JSON.parse(scroll.body); } catch { /* ignore */ }
  check(scroll.status === 204 || (scroll.status === 200 && body && typeof body.id === 'string'),
    scroll.status === 204 ? 'GET /api/announcement → 204 (no live notice)' : 'GET /api/announcement → a live notice',
    scroll.status === 204 ? '204' : `${scroll.status} id=${body && body.id}`);
  if (body && body.id) {
    check(!!body.text && !!body.level && Number.isFinite(body.startAt), 'notice carries text/level/startAt');
    check(scroll.cache === 'no-store', 'notice is served no-store', scroll.cache || '(none)');
  }
  const popup = await get('/api/popup-announcement');
  check(popup.status === 204 || popup.status === 200, 'GET /api/popup-announcement → 204/200', String(popup.status));
  const post = await fetch(base + '/api/announce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ announcements: [] }) })
    .then((r) => r.status).catch(() => 0);
  check(post === 403 || post === 400, 'POST /api/announce without a token → refused', String(post));
  const pre = await get('/preload');
  check(pre.status === 200 && pre.type.includes('text/html') && /资源预载/.test(pre.body || ''), 'GET /preload → the resource preload page', `${pre.status} ${pre.type}`);
  const chip = await get('/sp-preload-link.js');
  check(chip.status === 200 && chip.type.includes('javascript'), 'GET /sp-preload-link.js → the landing-page entry to /preload', `${chip.status} ${chip.type}`);
  const script = await get('/sp-announce.js');
  check(script.status === 200 && script.type.includes('javascript'), 'GET /sp-announce.js → the announcement client', `${script.status} ${script.type}`);
  const tweaks = await get('/sp-tweaks.js');
  check(tweaks.status === 200 && tweaks.type.includes('javascript'), 'GET /sp-tweaks.js → the landing-page tweaks (hide the fork preload UI, custom 关于本服务器)', `${tweaks.status} ${tweaks.type}`);
  const info = await get('/api/server-info');
  let infoBody = null;
  try { infoBody = JSON.parse(info.body); } catch { /* ignore */ }
  check(info.status === 204 || (info.status === 200 && infoBody),
    info.status === 204 ? 'GET /api/server-info → 204 (nothing configured; the checkout content stays)' : 'GET /api/server-info → this server own info',
    info.status === 204 ? '204' : `${info.status}, ${(infoBody && infoBody.rows || []).length} row(s)`);
  const infoPost = await fetch(base + '/api/server-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [] }) })
    .then((r) => r.status).catch(() => 0);
  check(infoPost === 403 || infoPost === 400, 'POST /api/server-info without a token → refused', String(infoPost));
  const preManifest = await get('/data/preload-manifest.json');
  let pm = null;
  try { pm = JSON.parse(preManifest.body); } catch { /* ignore */ }
  const preOk = preManifest.status === 200 && pm && Array.isArray(pm.files) && pm.files.length > 0
    && Array.isArray(pm.files[0]) && typeof pm.files[0][2] === 'string';
  check(preOk, 'GET /data/preload-manifest.json → the preload/verify manifest (size + sha256)',
    preOk ? `${pm.files.length} files, ${(pm.files.reduce((n, f) => n + (f[1] || 0), 0) / 1048576).toFixed(1)} MiB${Array.isArray(pm.missing) && pm.missing.length ? `, ${pm.missing.length} missing` : ''}` : `${preManifest.status}`);
  const page = await get('/');
  // Either the adapter injected its banner client (original upstream) or the checkout ships its own announcement
  // client and the adapter deliberately stays out of the way (xinhai-ai's fork).
  const upstreamClient = existsSync(`${repo}public/js/ui/announcement.js`);
  check(/sp-announce\.js/.test(page.body || '') || upstreamClient,
    upstreamClient ? 'announcements handled by the upstream client (no injection)' : 'the served index.html is wired to the announcement client');
  check(/sp-preload-link\.js/.test(page.body || ''), 'the served index.html carries the /preload entry (injected on every upstream)');
  check(/sp-tweaks\.js/.test(page.body || ''), 'the served index.html carries the landing-page tweaks');
  // The in-match damage panel is an optional client extra: deleting public/sp-damage.js drops it from the build,
  // so the two checks below only run when the file is part of this checkout.
  if (existsSync(join(repo, 'cloudflare', 'public', 'sp-damage.js'))) {
    const dmg = await get('/sp-damage.js');
    check(dmg.status === 200 && dmg.type.includes('javascript') && /__SP_RUNNER__/.test(dmg.body || ''),
      "GET /sp-damage.js → the in-match damage panel (reads the game's own battle runner)", `${dmg.status} ${dmg.type}`);
    check(/sp-damage\.js/.test(page.body || ''), 'the served index.html is wired to the damage panel');
  } else {
    ok('the in-match damage panel is not part of this build (cloudflare/public/sp-damage.js absent)');
  }
  // The tweaks script needs to know whether the checkout ships a 「关于本服务器」 dialog of its own: build.mjs
  // probes the checkout and bakes the answer into the script tag (checkout → patch it, none → build our own).
  const sw = await get('/sw.js');
  const swOk = sw.status === 200 && sw.type.includes('javascript')
    && /const APP = '[^']+';/.test(sw.body || '') && /const BUILD = '[^']+';/.test(sw.body || '')
    && !/'__SP_(APP|BUILD)__'/.test(sw.body || '');       // the constants are baked (the header comment may name them)
  check(swOk, 'GET /sw.js → the Service Worker with baked cache names', `${sw.status} ${sw.type}`);
  check((sw.cache || '').includes('no-cache'), 'sw.js is served no-cache (updates can land)', sw.cache || '(none)');
  const spSw = await get('/sp-sw.js');
  check(spSw.status === 200 && spSw.type.includes('javascript') && /__SP_SW__/.test(spSw.body || ''),
    'GET /sp-sw.js → the Service Worker registration client', `${spSw.status} ${spSw.type}`);
  check(/sp-sw\.js/.test(page.body || ''), 'the served index.html registers the Service Worker');
  const aboutTag = /<script src="\/sp-tweaks\.js" defer data-about-ui="(checkout|none)"><\/script>/.exec(page.body || '');
  check(!!aboutTag, 'the tweaks script declares which upstream it runs on (data-about-ui)',
    aboutTag ? `data-about-ui="${aboutTag[1]}"` : 'missing — stale dist? run npm run build');
  if (aboutTag) {
    // The same probe build.mjs runs: does any JS under public/js or shared mention 「关于本服务器」?
    const mentionsAbout = (dir, depth = 0) => {
      if (depth > 4) return false;
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) { if (mentionsAbout(abs, depth + 1)) return true; }
        else if (e.isFile() && e.name.endsWith('.js')) {
          try { if (/关于本服务器/.test(readFileSync(abs, 'utf8'))) return true; } catch { /* unreadable → skip */ }
        }
      }
      return false;
    };
    const aboutExpected = mentionsAbout(join(repo, 'public', 'js')) || mentionsAbout(join(repo, 'shared'));
    check(aboutTag[1] === (aboutExpected ? 'checkout' : 'none'),
      aboutExpected ? 'the flag says the checkout ships its own 关于本服务器 dialog (adapter patches it)'
        : 'the flag says the checkout has no 关于本服务器 dialog (adapter provides one when configured)',
      `flag=${aboutTag[1]} expected=${aboutExpected ? 'checkout' : 'none'}`);
  }
}

// ------------------------------------------------------------------------------------------------
// 2. /healthz
// ------------------------------------------------------------------------------------------------

console.log('\n[healthz]');
{
  const r = await get('/healthz');
  let body = null;
  try { body = JSON.parse(r.body); } catch { /* ignore */ }
  check(r.status === 200 && body && body.ok === true, 'GET /healthz → ok', `${r.status}`);
  check(body && body.version === PROTOCOL_VERSION, 'protocol version matches', body ? String(body.version) : '-');
  check(body && body.app === APP_VERSION, `app version reported (${APP_VERSION})`, body ? String(body.app) : '-');
  check(body && typeof body.build === 'string' && body.build.length > 0, 'build tag present', body ? body.build : '-');
  check(body && typeof body.rooms === 'number' && typeof body.sockets === 'number', 'lobby counters present',
    body ? `rooms=${body.rooms} sockets=${body.sockets} sessions=${body.sessions}` : '-');
  // The sim's content modules are loaded through dynamic imports that a bundler can break silently
  // (server/sim/content/index.js) — 9 domains + the hand-authored kits must be there.
  check(body && body.content && body.content.domains === 9, 'sim content modules loaded (9 domains)',
    body && body.content ? `${body.content.domains} domains, ${body.content.kits} kits` : '-');
  check(body && body.content && body.content.kits > 100, 'hand-authored kits loaded', body && body.content ? String(body.content.kits) : '-');
  // The data files the match engine reads (data/*.json): 15 expected + tuning/local-assets when present.
  check(body && body.dataKeys >= 15, 'game data loaded into the singleton', body ? `${body.dataKeys} keys` : '-');
}

// ------------------------------------------------------------------------------------------------
// 3. the game protocol over the WebSocket
// ------------------------------------------------------------------------------------------------

console.log('\n[websocket]');
try {
  // player 1: hello → create a room
  const a = await session('A');
  a.send({ t: 'hello', name: 'smoke-A', version: PROTOCOL_VERSION });
  const welcomeA = await a.next('welcome');
  check(!!welcomeA.playerId && !!welcomeA.token, 'hello → welcome (session minted)', `playerId=${welcomeA.playerId}`);
  check(welcomeA.resumed === false, 'fresh session is not flagged resumed');

  a.send({ t: 'ping', c: 1 });
  const pongMsg = await a.next('pong');
  check(typeof pongMsg.s === 'number', 'ping → pong', `serverNow=${pongMsg.s}`);

  a.send({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', rid: 2 });
  const stateA = await a.next('room.state');
  check(!!stateA.code && stateA.code.length >= 4, 'room.create → room.state', `code=${stateA.code}`);
  const code = stateA.code;
  const humansA = (stateA.seats || []).filter((s) => s && !s.isBot).length;
  check(humansA === 1, 'one human seat is taken', `${humansA}`);

  // player 2: join by code
  const b = await session('B');
  b.send({ t: 'hello', name: 'smoke-B', version: PROTOCOL_VERSION });
  const welcomeB = await b.next('welcome');
  b.send({ t: 'room.join', code, rid: 3 });
  const stateB = await b.next('room.state');
  const humansB = (stateB.seats || []).filter((s) => s && !s.isBot).length;
  check(humansB === 2, 'player B joined the same room', `humans=${humansB}`);

  // player 2 reconnects with its token (the resume path)
  b.close();
  await new Promise((r) => setTimeout(r, 300));
  const c = await session('C');
  c.send({ t: 'hello', name: 'smoke-B', token: welcomeB.token, version: PROTOCOL_VERSION });
  const welcomeC = await c.next('welcome');
  check(welcomeC.resumed === true && welcomeC.playerId === welcomeB.playerId, 'reconnect with token resumes the session',
    `playerId=${welcomeC.playerId} resumed=${welcomeC.resumed}`);
  const stateC = await c.next('room.state');
  check(stateC.code === code, 'resumed session is back in its room', `code=${stateC.code}`);

  const health2 = await get('/healthz');
  const h2 = JSON.parse(health2.body);
  check(h2.rooms >= 1 && h2.sockets >= 1, '/healthz sees the live room and sockets', `rooms=${h2.rooms} sockets=${h2.sockets}`);

  // player 1 renames itself (repeated hello on a live socket) and leaves
  a.send({ t: 'hello', name: 'smoke-A2', version: PROTOCOL_VERSION });
  await a.next('welcome');
  a.send({ t: 'room.leave', rid: 4 });
  await a.next('ok', 4);
  ok('room.leave accepted');

  c.close();
  await new Promise((r) => setTimeout(r, 400));
  const health3 = await get('/healthz');
  const h3 = JSON.parse(health3.body);
  check(h3.sockets <= h2.sockets, 'sockets closed again', `sockets=${h3.sockets}`);
} catch (e) {
  bad('websocket session', e && e.message);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
