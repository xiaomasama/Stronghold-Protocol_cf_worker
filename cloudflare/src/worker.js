// cloudflare/src/worker.js — the Workers entry point (thin: routing only).
//
// Route map, mirroring the static mounts of server/index.js:
//   /ws            → the GameServer Durable Object (WebSocket upgrade; the object runs server/net.js)
//   /healthz       → the same object (build tag + live counters, see server/index.js handleRequest)
//   /media/<path>  → extension-less audio, resolved against the asset store (src/media.js)
//   /plugins/index.json, /cs/<cs16>/index.json → the plugin catalogue and the vanilla content set's index, baked at
//                    build time (0.3.0; no plugins are installed — see the route comments)
//   /packs/<id>/<file>, /packs/index.json → the content packs (src/packs.js)
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
import { splitHashedPath } from '../.generated/shared/assetPaths.js';
import { csUrlPart } from '../.generated/shared/plugins/identity.js';
import { VANILLA_CONTENT, PLUGIN_INDEX } from './content.generated.js';

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

    // The plugin catalogue and the vanilla content set's index (0.3.0, DESIGN §32; server/http/static.js). Both are
    // built from the plugin registry there; this deployment ships no plugins, so the catalogue is the zero-plugin
    // document the build baked with upstream's own builder (build.mjs §4b), and /cs/<cs16>/index.json answers for the
    // one content set that exists — the vanilla one, at the hash /healthz and welcome.content report.
    // Everything else under /cs/ (a set with gameplay plugins), /vs/ (a visual set) and /p/ (plugin files) falls
    // through to the asset store and 404s: there is nothing to serve. See cloudflare/README.md 「已知差异」.
    if (url.pathname === '/plugins/index.json') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      return new Response(JSON.stringify(PLUGIN_INDEX), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === `/cs/${csUrlPart(VANILLA_CONTENT.cs)}/index.json`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed();
      return new Response(JSON.stringify(VANILLA_CONTENT.index), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // the URL names the content: static.js answers this with IMMUTABLE_JSON and an ETag of the same form
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag': `"cs-${csUrlPart(VANILLA_CONTENT.cs)}-v${PLUGIN_INDEX.version}"`,
        },
      });
    }

    // Content-hashed asset URLs (upstream 0.2.6, shared/assetPaths.js): the served data/assets.json names every
    // file as /assets/~<hash>/… (fonts likewise, audio as /media/~<hash>/…), so a browser may keep it for a year.
    // The hash is not part of the path on disk — strip the segment, serve the file, and say immutable. The hash
    // itself is not re-checked against the file (server/http/assetIndex.js does that with a file-system scan a
    // Worker does not have, and a wrong hash would only cost a cache entry); what the manifests this deployment
    // writes name is what build.mjs §2c hashed, and an unknown path 404s like any other.
    if (url.pathname.startsWith('/assets/~') || url.pathname.startsWith('/fonts/~')) {
      const { hash, path } = splitHashedPath(url.pathname);
      if (hash) {
        const target = new URL(url);
        target.pathname = path;
        const res = await env.ASSETS.fetch(new Request(target, { method: request.method, headers: request.headers }));
        if (res.status === 200) {
          const headers = new Headers(res.headers);
          headers.set('Cache-Control', 'public, max-age=31536000, immutable');
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        }
        return res;
      }
    }

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
