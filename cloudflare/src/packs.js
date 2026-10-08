// cloudflare/src/packs.js — the content-pack routes (0.2.x, docs/PACKS.md).
//
// Mirrors the pack branch of server/http/static.js:
//
//   GET /packs/index.json      → the pack index of this deployment (generated at build time: a Worker cannot
//                                scan the file system the way server/packs.js does)
//   GET /packs/<id>/<file>     → a file of a folder pack, but **only one its manifest names** — that whitelist
//                                is what keeps a pack folder from becoming a directory listing; the bytes come
//                                from the asset store (build.mjs copies packs/ into dist/)
//
// Language packs are plain files (/i18n/<code>.json under public/, /data/i18n/<code>.json under data/) and are
// served by the asset store like any other static file — same as the Node server, which only ever answers
// `servable()` for folder packs.

import { PACKS_URL, PACK_INDEX_FILE } from '../.generated/shared/packs.js';
import { PACK_INDEX, PACK_SERVABLE } from './packs.generated.js';

/** Request headers worth forwarding to the asset store (revalidation and ranges). */
const FORWARD_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'accept-language'];

const notFound = () => new Response('页面不存在 · Not found', {
  status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
});

/**
 * @param {Request} request
 * @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env
 * @param {URL} url
 * @returns {Promise<Response | null>} null when the path is not a /packs/ request
 */
export async function servePacks(request, env, url) {
  if (!url.pathname.startsWith(PACKS_URL)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('不支持的请求方法 · Method not allowed', {
      status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { return notFound(); }
  const parts = decoded.slice(PACKS_URL.length).split('/');

  // the live index (server/packs.js index()); the Node server answers it with no-store as well
  if (parts.length === 1 && parts[0] === PACK_INDEX_FILE) {
    return Response.json(PACK_INDEX, { headers: { 'Cache-Control': 'no-store' } });
  }

  // only <packId>/<rel> paths a manifest names (no empty / "." / ".." segments)
  const valid = parts.length >= 2 && !parts.some((s) => s === '' || s === '.' || s === '..');
  const key = valid ? `${parts[0]}/${parts.slice(1).join('/')}` : null;
  if (!key || !PACK_SERVABLE.has(key)) return notFound();

  const assetPath = '/' + [PACKS_URL.slice(1, -1), ...parts].map(encodeURIComponent).join('/');
  return env.ASSETS.fetch(assetRequest(request, url, assetPath));
}

/** A request for the pack file in the asset store, keeping the headers that matter. */
function assetRequest(request, url, assetPath) {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new Request(new URL(assetPath + url.search, url.origin), { method: request.method, headers });
}
