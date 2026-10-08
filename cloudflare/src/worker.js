// cloudflare/src/worker.js — the Workers entry point (thin: routing only).
//
// Route map, mirroring the static mounts of server/index.js:
//   /ws            → the GameServer Durable Object (WebSocket upgrade; the object runs server/net.js)
//   /healthz       → the same object (build tag + live counters, see server/index.js handleRequest)
//   /media/<path>  → extension-less audio, resolved against the asset store (src/media.js)
//   everything else→ the static asset store (dist/, assembled by build.mjs)
//
// The Worker itself never touches the game data or the lobby: only the Durable Object boots them, so a static
// request costs nothing but the fetch to the asset store.

// Imported first, and deliberately so: it writes the game data into the Workers VFS before the simulation's
// own module-scope data load runs (see src/data-preroll.js).
import './data-preroll.js';
import { GameServer } from './game-server.js';
import { serveMedia } from './media.js';
import { servePacks } from './packs.js';
import { serveAnnounceApi } from './announce.js';
import { serveServerInfoApi } from './server-info.js';
import { REAL_IP_HEADER } from './req-shim.js';

export { GameServer };

/** Single object name: one game server, like one Node process (see cloudflare/README.md). */
const DEFAULT_INSTANCE = 'main';

/** Location hints the runtime accepts (`DurableObjectLocationHint` in worker-configuration.d.ts). */
const LOCATION_HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me']);

/**
 * The Durable Object that runs the game.
 *
 * `SP_DO_LOCATION_HINT` (a `[vars]` entry) is the deployment's one latency lever: the object lives in a single
 * Cloudflare location, every player's WebSocket is routed there, and **an object never moves once created**.
 * A hint only applies while the object is being created, so moving to another region means a new object — set
 * the hint and change `SP_DO_NAME` (`main` → `main-2`); the old object is simply abandoned, which costs
 * nothing here because the game server keeps no storage (rooms and matches live in memory, exactly like the
 * Node server: a restart ends running matches). Verify with `GET /where` — `edge.colo` and `do.colo` should
 * be in the same region; a cross-region pair is what makes a distant deployment feel laggy.
 */
function gameStub(env) {
  const name = typeof env.SP_DO_NAME === 'string' && env.SP_DO_NAME.trim() ? env.SP_DO_NAME.trim() : DEFAULT_INSTANCE;
  const hint = typeof env.SP_DO_LOCATION_HINT === 'string' ? env.SP_DO_LOCATION_HINT.trim().toLowerCase() : '';
  return env.GAME.getByName(name, LOCATION_HINTS.has(hint) ? { locationHint: hint } : undefined);
}

const methodNotAllowed = () => new Response('不支持的请求方法 · Method not allowed', {
  status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
});

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: Function }, GAME: { idFromName: Function, get: Function, getByName: Function }, SP_DO_NAME?: string, SP_DO_LOCATION_HINT?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = gameStub(env);

    if (url.pathname === '/ws') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('需要 WebSocket 升级 · WebSocket upgrade required', { status: 426, headers: { Upgrade: 'websocket' } });
      }
      // Forward the upgrade unchanged except for the client address: cf-connecting-ip reaches the object too,
      // but a rebuilt Request keeps the handshake (measured) and makes the address independent of that.
      return stub.fetch(withClientIp(request));
    }

    if (url.pathname === '/announce-ws') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return methodNotAllowed();
      return stub.fetch(withClientIp(request));
    }

    if (url.pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      return stub.fetch(new Request('https://game.internal/healthz', { method: request.method }));
    }

    // GET /where — where the player's edge is and where the game object actually lives (latency diagnosis).
    if (url.pathname === '/where') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      const cf = request.cf || {};
      const doInfo = await stub.fetch(new Request('https://game.internal/diag')).then((r) => r.json()).catch((e) => ({ error: String(e && e.message || e) }));
      return Response.json({
        edge: {
          colo: cf.colo ?? null,
          // Cloudflare's own measurement of the client's round trip to the edge — the part of the latency that
          // no Durable Object placement can remove. A browser on HTTP/3 reports the QUIC figure (the TCP one
          // stays 0, which is not a zero-latency connection).
          clientTcpRttMs: cf.clientTcpRtt ?? null,
          clientQuicRttMs: cf.clientQuicRtt ?? null,
          httpProtocol: cf.httpProtocol ?? null,
          country: cf.country ?? null,
          city: cf.city ?? null,
          region: cf.region ?? null,
          asn: cf.asn ?? null,
          timezone: cf.timezone ?? null,
        },
        durableObject: doInfo,
        instance: typeof env.SP_DO_NAME === 'string' && env.SP_DO_NAME.trim() ? env.SP_DO_NAME.trim() : DEFAULT_INSTANCE,
        locationHint: typeof env.SP_DO_LOCATION_HINT === 'string' && env.SP_DO_LOCATION_HINT.trim() ? env.SP_DO_LOCATION_HINT.trim().toLowerCase() : null,
        note: 'edge.colo is the Cloudflare location serving you (clientTcpRttMs = your measured round trip to it); durableObject.colo is where the game server lives. Same region (e.g. both SJC or both HKG) = optimal; far apart adds a cross-region hop. See cloudflare/DEPLOY.md 「延迟优化」.',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // /preload → the adapter's preload page (a bare path is nicer to hand out than /preload.html)
    if (url.pathname === '/preload' || url.pathname === '/preload/') {
      return env.ASSETS.fetch(new Request(new URL('/preload.html' + url.search, url.origin), { method: request.method, headers: request.headers }));
    }

    const media = await serveMedia(request, env, url);
    if (media) return media;

    // Site announcements (src/announce.js): /api/announcement, /api/popup-announcement, POST /api/announce.
    const announce = await serveAnnounceApi(request, env, url,
      (doc) => stub.fetch(new Request('https://game.internal/announce-push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc ?? null),
      })).then((r) => r.json()),
      (type) => stub.fetch(new Request(`https://game.internal/announce-get?type=${type}`, { method: request.method })));
    if (announce) return announce;

    // 「关于本服务器」 (src/server-info.js): the deployment's own contact/rules rows.
    const serverInfo = await serveServerInfoApi(request, env, url);
    if (serverInfo) return serverInfo;

    // Content packs (0.2.x, docs/PACKS.md): the live index, and only the files a pack's manifest names —
    // mirrors server/http/static.js. Language packs are ordinary files at /i18n/… and /data/i18n/… .
    const packs = await servePacks(request, env, url);
    if (packs) return packs;

    return env.ASSETS.fetch(request);
  },
};

/** @param {Request} request */
function withClientIp(request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '';
  if (!ip) return request;
  const headers = new Headers(request.headers);
  headers.set(REAL_IP_HEADER, ip);
  return new Request(request, { headers });
}
