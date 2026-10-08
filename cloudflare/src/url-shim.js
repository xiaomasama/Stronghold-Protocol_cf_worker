// cloudflare/src/url-shim.js — `node:url` replacement, wired up by `alias` in wrangler.jsonc.
//
// Why: server/data.js computes its ROOT at module scope from `import.meta.url`:
//
//     export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
//     export const DATA_DIR = path.join(ROOT, 'data');
//
// Wrangler bundles the Worker with esbuild, and in the bundled module `import.meta.url` is undefined, so
// `fileURLToPath(undefined)` throws and `server/data.js` could not be imported at all.
//
// The fallback path is not arbitrary: it mirrors the repository layout inside the Workers virtual file
// system, so that
//
//     fileURLToPath(undefined) = /tmp/stronghold/server/data.js
//     ROOT                     = /tmp/stronghold        (server/data.js)
//     DATA_DIR                 = /tmp/stronghold/data   ← where src/data-boot.js materializes data/*.json
//
// …which matters because server/sim/simdata.js loads the game data at module scope under Node
// (server/sim/nodeData.js `loadGenerated` → `getData()` with no directory), *before* the Durable Object
// boots: with DATA_DIR pointing at the materialized files, that early call loads the real data (exactly as on
// a Node server) instead of caching an empty object into the singleton. src/data-preroll.js makes sure the
// files are in the VFS before any of that runs. server/sim/nodeData.js's own ROOT (the docs/research
// fallback) resolves to /tmp and finds nothing — the same "no research fallback" case as a data-less
// checkout.
//
// `new URL(...)` is the platform global and is not affected by this alias; nothing else in the bundled graph
// imports node:url.

/** What `import.meta.url` would have been: a path that makes ROOT/DATA_DIR land on the materialized VFS dir. */
export const BUNDLE_IMPORT_META_URL = '/tmp/stronghold/server/data.js';

const isWindows = () => typeof process !== 'undefined' && process.platform === 'win32';

/** Node's fileURLToPath, plus the undefined fallback described above. */
export function fileURLToPath(url) {
  if (url === undefined || url === null) return BUNDLE_IMPORT_META_URL;
  if (url instanceof URL) {
    if (url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
    return decodeURIComponent(url.pathname);
  }
  const s = String(url);
  if (!s.startsWith('file:')) throw new TypeError('The URL must be of scheme file');
  let pathname = decodeURIComponent(s.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1); // file:///C:/x → C:/x
  return pathname === '' ? '/' : pathname;
}

/** Node's pathToFileURL for absolute paths and POSIX-style paths. */
export function pathToFileURL(p) {
  const s = String(p);
  const pathname = s.startsWith('/') ? s : `/${s}`;
  const encoded = pathname.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  const url = new URL(`file://${isWindows() ? '/' : ''}${encoded}`);
  return url;
}

export function urlToHttpOptions(url) {
  const u = url instanceof URL ? url : new URL(String(url));
  return {
    protocol: u.protocol,
    hostname: u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname,
    hash: u.hash,
    search: u.search,
    pathname: u.pathname,
    path: `${u.pathname}${u.search}`,
    href: u.href,
    port: u.port,
  };
}

export default { fileURLToPath, pathToFileURL, urlToHttpOptions };
