// cloudflare/src/media.js — the extension-less audio route on Cloudflare.
//
// The browser plays audio through `/media/bgm/act1` instead of `/assets/audio/bgm/act1.mp3`, so download
// managers stop popping their "下载文件信息" dialog (shared/media.js, public/js/media.js). server/index.js
// resolves that route with node:fs (`serveMedia`); here it is resolved against the static-asset store: try
// the candidate extensions in the order shared/media.js defines, first hit wins. Everything else (Range
// support for seeking, Content-Type, ETag, the 1-day Cache-Control of /assets/…) comes from the asset store
// serving the very file the client would otherwise have asked for.
//
// A served manifest's URL keeps its content-hash segment (0.2.6): `/media/~<hash>/bgm/act1`. The segment is
// stripped before the extension probe, and the answer goes out immutable — the URL changes with the bytes.

import { MEDIA_PREFIX, AUDIO_EXTS } from '../.generated/shared/media.js';
import { splitHashedPath } from '../.generated/shared/assetPaths.js';

/** Request headers that must survive the rewrite so audio seeking and revalidation keep working. */
const FORWARD_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'accept-language'];

const notFound = () => new Response('页面不存在 · Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const forbidden = () => new Response('禁止访问 · Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/**
 * @param {Request} request the original request
 * @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env
 * @param {URL} url
 * @returns {Promise<Response | null>} null when the path is not a /media/ request
 */
export async function serveMedia(request, env, url) {
  if (!url.pathname.startsWith(MEDIA_PREFIX)) return null;
  // Upstream 0.2.6: a served manifest names audio as /assets/~<hash>/audio/…, which public/js/media.js turns
  // into /media/~<hash>/… (shared/assetPaths.js). The segment is the content hash, not a directory — strip it
  // and keep the answer for a year, since the URL changes whenever the bytes do (hashedFileOpts on the Node
  // server; a Worker has no file-system index to re-check the hash against).
  const { hash, path } = splitHashedPath(url.pathname);
  let rest;
  try { rest = decodeURIComponent(path.slice(MEDIA_PREFIX.length)); } catch { return notFound(); }
  const segments = rest.split('/').filter((s) => s.length > 0);
  if (!segments.length || rest.endsWith('/')) return notFound();
  if (segments.some((s) => s === '..' || s === '.')) return forbidden();
  // A leading or trailing dot would address something else (dotfiles, "x..mp3") — the client never asks for it.
  if (segments.some((s) => s.startsWith('.') || s.endsWith('.'))) return notFound();

  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');
  const given = dot > 0 ? last.slice(dot).toLowerCase() : '';
  const wanted = AUDIO_EXTS.includes(given) ? given : '';
  const stem = wanted ? last.slice(0, -wanted.length) : last;
  if (!stem || stem.startsWith('.')) return notFound();

  // An explicit extension wins (`/media/bgm.ogg` → bgm.ogg), otherwise the usual order decides.
  const order = wanted ? [wanted, ...AUDIO_EXTS.filter((e) => e !== wanted)] : AUDIO_EXTS;
  const dir = ['assets', 'audio', ...segments.slice(0, -1)];
  for (const ext of order) {
    const assetPath = '/' + [...dir, stem + ext].map(encodeURIComponent).join('/');
    // eslint-disable-next-line no-await-in-loop
    const res = await env.ASSETS.fetch(assetRequest(request, url, assetPath));
    if (res.status === 200 || res.status === 206 || res.status === 304) return hash ? keepForever(res) : res;
  }
  return notFound();
}

/** The same response with a year-long cache policy — the request URL carries the content hash. */
function keepForever(res) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** A request for the resolved asset URL, keeping the headers that matter for media. */
function assetRequest(request, url, assetPath) {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new Request(new URL(assetPath + url.search, url.origin), { method: request.method, headers });
}
