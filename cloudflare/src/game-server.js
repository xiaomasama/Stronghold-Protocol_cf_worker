// cloudflare/src/game-server.js — the Durable Object that runs the game server itself.
//
// One instance ("main") holds what server/index.js holds in one Node process: the session registry, the
// lobby (rooms + matches) and the Network socket layer. server/net.js, server/lobby.js and server/match/*
// are imported and used exactly as they are; only the two things workerd does differently are adapted:
//
//   * sockets: the DO side of a WebSocketPair is wrapped in WsShim (src/ws-shim.js), which provides the
//     `ws` surface net.js expects. `server.accept()` must be called — without it workerd opens the socket
//     but delivers nothing (measured with wrangler dev, see cloudflare/README.md).
//   * the request: net.js reads the client address from a node:http IncomingMessage; reqShim (src/req-shim.js)
//     builds that view from the Worker request, which carries the real client IP.
//
// Everything is in memory, matching the original server ("服务器无状态: 房间和对局只存在内存里"): a DO
// restart loses running matches exactly like restarting the Node process does. While a match runs, the match
// engine's own timers keep the object pinned in memory, so a match keeps playing even when every player is
// disconnected — the same behavior as the Node server.
//
// Long-lived state and cost: the object stays in memory while sockets are open or timers are pending, and is
// evicted when idle (no sockets, no timers). Per-network limits come from net.js (clientAddress), and the
// limits that used to be enforced at upgrade time in server/index.js (`admission`) are enforced here instead.

// Imported first, and deliberately so: it writes the game data into the Workers VFS before the simulation's
// own module-scope data load runs (see src/data-preroll.js).
import './data-preroll.js';
import { Network, SessionRegistry, NET_DEFAULTS } from '../.generated/server/net.js';
import { Lobby } from '../.generated/server/lobby.js';
import { PROTOCOL_VERSION, APP_VERSION } from '../.generated/shared/constants.js';
import { KITS, MODULES } from '../.generated/server/sim/content/index.js';
import { bootData } from './data-boot.js';
import { reqShim } from './req-shim.js';
import { WsShim } from './ws-shim.js';
import { BUILD_TAG } from './build-info.generated.js';
import { readAnnouncements, parseAnnouncements, liveAnnouncement, announcementBody } from './announce.js';

/** Env vars that Match/Lobby read through process.env (server/match/Match.js `env()`); set as `[vars]`. */
const ENV_PASSTHROUGH = ['SP_VERIFY', 'SP_COMBAT', 'SP_FULL', 'SP_DRAFT', 'DEBUG'];

/** Lobby tunables that may be overridden per deployment (LOBBY_DEFAULTS keys). */
const LOBBY_OPTIONS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs'];

/** Network tunables that may be overridden per deployment (NET_DEFAULTS keys). */
const NET_OPTIONS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'abuseDropsPerSec',
  'maxConnections', 'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy'];

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export class GameServer {
  /**
   * @param {DurableObjectState} state
   * @param {Record<string, any>} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {{ registry: SessionRegistry, lobby: Lobby, network: Network, startedAt: number } | null} */
    this.server = null;
    /** @type {{ at: number, info: object } | null} cached /diag answer (the location never changes) */
    this._where = null;
    /** @type {Set<{ ws: WebSocket }>} announcement push subscribers (public/sp-announce.js) */
    this.subs = new Set();
    /** @type {{ at: number, entries: object[] } | null} the document published through POST /api/announce */
    this._announce = null;
  }

  /**
   * The current announcement document. Precedence: a document published through POST /api/announce (kept for
   * 60 s — KV reads are eventually consistent, so the pushed copy is the truthful one right after a publish),
   * then the KV binding, then the SP_ANNOUNCEMENTS var.
   */
  async announcements() {
    const log = { warn: (...a) => console.warn(...a) };
    if (this._announce && Date.now() - this._announce.at < 60000) return this._announce.entries;
    const kv = await readAnnouncements(this.env, log);
    if (this._announce && !kv.length) return this._announce.entries; // no KV bound: the pushed copy is all we have
    return kv;
  }

  /** Accept a published document: answer the push with it and remember it (see announcements()). */
  acceptAnnouncements(doc) {
    try {
      this._announce = { at: Date.now(), entries: parseAnnouncements(doc) };
    } catch { this._announce = null; }
  }

  /** Send the current document to one subscriber (as {t:'announce', scroll?, popup?}). */
  async sendAnnouncements(sub) {
    const entries = await this.announcements();
    const now = Date.now();
    const scroll = liveAnnouncement(entries, 'scroll', now);
    const popup = liveAnnouncement(entries, 'popup', now);
    try {
      sub.ws.send(JSON.stringify({ t: 'announce', scroll: scroll ? announcementBody(scroll, now) : null, popup: popup ? announcementBody(popup, now) : null }));
    } catch { this.subs.delete(sub); }
  }

  /** Push the current document to every subscriber (after POST /api/announce). */
  async broadcastAnnouncements() {
    let sent = 0;
    for (const sub of [...this.subs]) {
      // eslint-disable-next-line no-await-in-loop
      await this.sendAnnouncements(sub);
      sent++;
    }
    if (sent) console.log(`[announce] pushed to ${sent} client(s)`);
    return sent;
  }

  /**
   * The Cloudflare location this object runs in — asked of Cloudflare's trace endpoint, because egress from a
   * Durable Object leaves through its own colo. That colo is exactly where every player's WebSocket is routed.
   * Cached for a few minutes: the answer never changes, the call is a subrequest.
   */
  async locate() {
    if (this._where && Date.now() - this._where.at < 300_000) return this._where.info;
    let info;
    try {
      const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
      const text = await res.text();
      /** @type {Record<string,string>} */
      const map = {};
      for (const line of text.trim().split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
      }
      info = { colo: map.colo ?? null, country: map.loc ?? null, ip: map.ip ?? null, fetchedAt: new Date().toISOString() };
    } catch (e) {
      info = { colo: null, error: String((e && e.message) || e) };
    }
    this._where = { at: Date.now(), info };
    return info;
  }

  /**
   * Boot once per instance: load the game data, then build the same object graph server/index.js builds.
   * The data load is the only expensive step (a few MB of JSON parsed once) and is shared by every entry
   * point below.
   */
  boot() {
    if (this.server) return this.server;
    const startedAt = Date.now();
    for (const key of ENV_PASSTHROUGH) {
      const v = this.env && this.env[key];
      if (typeof v === 'string' && v !== '') process.env[key] = v; // process.env is writable in workerd
    }
    const log = makeLogger(this.env);
    const data = bootData(log);
    const registry = new SessionRegistry({});
    const lobbyOptions = pickNumbers(this.env, LOBBY_OPTIONS);
    const lobby = new Lobby({
      registry,
      log,
      getData: () => data,
      options: lobbyOptions,
    });
    const network = new Network({ registry, handler: lobby, log, options: pickNumbers(this.env, NET_OPTIONS) });
    this.server = { registry, lobby, network, startedAt, log };
    log.info?.(`[do] up in ${Date.now() - startedAt} ms`);
    return this.server;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    const { registry, lobby, network, startedAt } = this.boot();

    // GET /healthz — the shape server/index.js serves (public/js/ui/buildGuard.js reads `build`), plus the
    // content-module counters: the sim's dynamic content imports are the one thing a bundler can break
    // silently, so they are reported here and asserted by cloudflare/tools/smoke.mjs.
    if (url.pathname === '/healthz') {
      return json({
        ok: true,
        version: PROTOCOL_VERSION,
        app: APP_VERSION,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        build: BUILD_TAG,
        sockets: network.connectionCount,
        sessions: registry.size,
        ...lobby.stats(),
        content: { kits: Object.keys(KITS).length, domains: MODULES.filter(([, mod]) => typeof mod?.install === 'function').length },
        dataKeys: Object.keys(lobby.getData()).length,
      });
    }

    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    // GET /diag — where this object lives. Egress from the object leaves through its own colo, so Cloudflare's
    // trace endpoint reports the location the players' WebSockets are routed to (src/worker.js `/where`).
    if (url.pathname === '/diag') return json({ ...(await this.locate()), name: this.state.id?.name ?? null });

    // The announcement push channel (src/announce.js, public/sp-announce.js): a *separate* socket per page, so
    // the game's own protocol and its WebSocket stay untouched. Every subscriber is dropped when it closes.
    if (url.pathname === '/announce-ws') {
      if (upgrade !== 'websocket') return json({ ok: false, error: 'websocket required' }, 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const sub = { ws: server };
      this.subs.add(sub);
      server.addEventListener('close', () => { this.subs.delete(sub); });
      server.addEventListener('error', () => { this.subs.delete(sub); });
      // the current document, so a page that connects after a publish is up to date as well
      this.sendAnnouncements(sub).catch(() => { /* ignore */ });
      return new Response(null, { status: 101, webSocket: client });
    }

    // Internal: the Worker reads the live notice through the object (src/worker.js /api/announcement).
    if (url.pathname === '/announce-get') {
      const type = url.searchParams.get('type') === 'popup' ? 'popup' : 'scroll';
      const entries = await this.announcements();
      const live = liveAnnouncement(entries, type, Date.now());
      if (!live) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      return json(announcementBody(live, Date.now()));
    }

    // Internal: the Worker asks for a broadcast after POST /api/announce (src/worker.js).
    if (url.pathname === '/announce-push') {
      let doc = null;
      try { doc = await request.json(); } catch { /* no body: just re-send the current document */ }
      if (doc) this.acceptAnnouncements(doc);
      const n = await this.broadcastAnnouncements();
      return json({ ok: true, subscribers: this.subs.size, sent: n });
    }

    if (url.pathname !== '/ws' || upgrade !== 'websocket') return json({ ok: false, error: 'not found' }, 404);

    // Upgrade-time admission, exactly as server/index.js did before handing over to ws: refused clients get
    // a failed handshake (429/503), which the browser client answers with its normal reconnect backoff.
    const req = reqShim(request);
    const refused = network.admission(req);
    if (refused === 'per-address') return new Response('Too Many Requests', { status: 429 });
    if (refused) return new Response('Service Unavailable', { status: 503 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept(); // required under workerd: an unaccepted socket opens but never delivers a message
    network.handleConnection(new WsShim(server), req);
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** console-based logger, matching the shape server/index.js passes around. */
function makeLogger(env) {
  const debug = env && env.DEBUG ? (...a) => console.debug(...a) : () => {};
  return { info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a), debug };
}

/** Numeric deployment overrides (`SP_*` vars are strings). */
function pickNumbers(env, keys) {
  const out = {};
  for (const key of keys) {
    const v = env && env[key];
    if (v == null || v === '') continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out[key] = n;
    else if (key === 'trustProxy') out[key] = v; // 'auto' | true | false
  }
  return out;
}

export { NET_DEFAULTS };
