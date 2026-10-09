#!/usr/bin/env node
// cloudflare/tools/release.mjs — build the "complete" release zip for this fork: every file of the checkout
// plus the game assets that upstream ships in its own release package.
//
//   node cloudflare/tools/release.mjs                 # tag from APP_VERSION, downloads upstream's pack if needed
//   node cloudflare/tools/release.mjs --from <zip>    # use an already-downloaded upstream pack (no network)
//   node cloudflare/tools/release.mjs --out <dir> --tag v0.2.2-cf --keep-cache
//
// What it does, in order:
//   1. reads APP_VERSION (shared/constants.js) and asks the GitHub API for the release asset of that tag —
//      `Stronghold-Protocol-v<ver>.zip` — so the pack always matches the sources it is bundled with (*never*
//      mix versions: upstream regenerates the asset lists between releases);
//   2. downloads it into .cache/releases/ (resumable) and verifies the sha256 the API reports;
//   3. copies `public/assets/**` + `public/fonts/**` + `data/local-assets.json` out of the pack **verbatim** —
//      the compressed bytes are moved into the output zip as they are, so 500 MB of assets cost no re-encoding;
//   4. adds every file of this checkout (git-tracked when the directory is a checkout, otherwise a walk that
//      skips node_modules / dist / build products / local configs);
//   5. writes <name>-v<ver>.zip with one top-level folder, a .sha256 next to it and a ready-to-paste
//      RELEASE-NOTES file, then re-opens the zip and checks that the pieces are really in there.
//
// Everything is plain Node (the zip reader/writer is in this file) so it behaves the same on Windows and Linux —
// including UTF-8 entry names, which Windows' zip tooling mangles through the ANSI code page.
//
// The zip, its .sha256 and the ready-to-paste release notes are the output; shipping them is a separate, manual
// step — this script never talks to a write API.

import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));   // …/cloudflare/tools
const adapter = dirname(here);                          // …/cloudflare
const log = (...a) => console.log('[release]', ...a);

// ---- options --------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
if (flag('help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }

const repo = opt('repo', dirname(adapter));             // the checkout to package (defaults to the one this lives in)

const UPSTREAM = 'sganggs/Stronghold-Protocol';
const appVersion = (() => {
  try { return (/'([^']+)'/.exec(/APP_VERSION = '([^']+)'/.exec(readFileSync(join(repo, 'shared', 'constants.js'), 'utf8'))?.[0] ?? '')?.[1]) ?? null; } catch { return null; }
})();
if (!appVersion) { console.error('[release] cannot read APP_VERSION from shared/constants.js — run this inside a Stronghold-Protocol checkout'); process.exit(1); }

const tag = opt('tag', `v${appVersion}-cf`);
const name = opt('name', 'Stronghold-Protocol_cf_worker');       // the single top-level folder in the zip
const outDir = opt('out', join(repo, '..', `${name}-release`));
const cacheDir = join(repo, '.cache', 'releases');
const explicitPack = opt('from', null);
const keepCache = flag('keep-cache');
const noVerify = flag('no-verify');

// ---- zip primitives (read + write; no dependencies) ------------------------------------------------------

/** CRC-32 (the zip checksum), table built once. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Decode a name from a zip entry: UTF-8 when the flag says so, the Info-ZIP Unicode Path extra field first,
 *  and GBK as a last resort (the code page Windows tools fall back to). */
const decodeName = (raw, utf8Flag, extra) => {
  for (let p = 0; p + 4 <= extra.length;) {                     // 0x7075 = Info-ZIP Unicode Path
    const id = extra.readUInt16LE(p); const size = extra.readUInt16LE(p + 2);
    if (id === 0x7075 && size >= 5 && extra[p + 4] === 1) {
      try { return extra.subarray(p + 5, p + 2 + size).toString('utf8'); } catch { /* keep looking */ }
    }
    p += 4 + size;
  }
  if (utf8Flag) return raw.toString('utf8');
  try { return new TextDecoder('gbk', { fatal: false }).decode(raw); } catch { return raw.toString('latin1'); }
};

/** List a zip's central directory. Returns { file, entries, zip64 } — entries carry everything needed to copy
 *  an entry's compressed bytes without inflating them. */
function readZip(path) {
  const fd = openSync(path, 'r');
  const size = statSync(path).size;
  const tailLen = Math.min(size, 66 * 1024 + 22);
  const tail = Buffer.alloc(tailLen);
  readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { closeSync(fd); throw new Error(`${path}: not a zip (no end-of-central-directory record)`); }
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let zip64 = false;
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {   // zip64: read the real values
    for (let i = eocd - 20; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x07064b50) {                                 // zip64 EOCD locator
        const z64 = Number(tail.readBigUInt64LE(i + 8));
        const buf = Buffer.alloc(56);
        readSync(fd, buf, 0, 56, z64);
        if (buf.readUInt32LE(0) !== 0x06064b50) throw new Error(`${path}: zip64 record missing`);
        count = Number(buf.readBigUInt64LE(32)); cdSize = Number(buf.readBigUInt64LE(40)); cdOffset = Number(buf.readBigUInt64LE(48));
        zip64 = true; break;
      }
    }
  }
  const cd = Buffer.alloc(cdSize);
  readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  for (let p = 0; p + 46 <= cd.length;) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const time = cd.readUInt16LE(p + 12); const date = cd.readUInt16LE(p + 14);
    const crc = cd.readUInt32LE(p + 16);
    const compSize = cd.readUInt32LE(p + 20);
    const rawSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    const localOffset = cd.readUInt32LE(p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const nm = decodeName(rawName, (flags & 0x800) !== 0, Buffer.from(extra));
    entries.push({
      rawName, name: nm, method, time, date, crc,
      compSize, size: rawSize, localOffset,
      dir: nm.endsWith('/') || (externalAttrs & 0x10) !== 0,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { fd, size, entries, zip64 };
}

/** Where an entry's data starts in the file: its local header is shorter than the central one. */
function dataOffset(fd, entry) {
  const head = Buffer.alloc(30);
  readSync(fd, head, 0, 30, entry.localOffset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  return entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

const dosTime = (d) => ({ time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff });

/** Streaming zip writer: entries are handed over one by one, the central directory is written at close(). */
function zipWriter(path) {
  const fd = openSync(path, 'w');
  const central = [];
  let offset = 0;
  const write = (buf) => { writeSync(fd, buf); offset += buf.length; };
  let count = 0;

  const add = ({ name: entryName, method, crc, compSize, size, time, date, data, from }) => {
    const nameBuf = Buffer.from(entryName, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);                                             // UTF-8 names
    local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compSize, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);       // no extra field
    const localOffset = offset;
    write(local); write(nameBuf);
    if (from) {                                                                // copy compressed bytes verbatim
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      let left = compSize; let pos = from.start;
      while (left > 0) {
        const n = readSync(from.fd, chunk, 0, Math.min(chunk.length, left), pos);
        if (n <= 0) throw new Error(`${entryName}: source ended early`);
        writeSync(fd, chunk, 0, n); offset += n; left -= n; pos += n;
      }
    } else write(data);
    central.push({ nameBuf, method, time, date, crc, compSize, size, localOffset });
    count++;
    if (count > 0xfffe) throw new Error('more than 65534 entries — this writer does not emit zip64');
    return { offset: localOffset, compSize };
  };

  const close = () => {
    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x800, 8); h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12); h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16); h.writeUInt32LE(e.compSize, 20); h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(0, 34); h.writeUInt32LE(0, 36);                           // no attrs / comment
      h.writeUInt32LE(e.localOffset, 42);
      write(h); write(e.nameBuf);
    }
    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
    write(eocd);
    closeSync(fd);
    if (offset > 0xffffffff) throw new Error('output over 4 GiB — this writer does not emit zip64');
    return { count, bytes: offset };
  };
  return { add, close, fd };
}

// ---- 1. the upstream pack -------------------------------------------------------------------------------

/** Ask the API for the release asset of this version: url + size + sha256, so the download can be verified. */
function upstreamAsset(version) {
  const api = `https://api.github.com/repos/${UPSTREAM}/releases/tags/v${version}`;
  const res = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-s', '-m', '30', '-H', 'Accept: application/vnd.github+json', api], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const rel = JSON.parse(res.stdout);
    const asset = (rel.assets || []).find((a) => a.name === `Stronghold-Protocol-v${version}.zip`);
    if (!asset) return null;
    return { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: (asset.digest || '').replace(/^sha256:/, '') || null, tag: rel.tag_name, published: rel.published_at };
  } catch { return null; }
}

const sha256File = (path) => new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

async function fetchPack(version) {
  const asset = upstreamAsset(version);
  if (!asset) log(`GitHub API did not answer for v${version} — falling back to the conventional asset URL (no digest to verify)`);
  const meta = asset || {
    name: `Stronghold-Protocol-v${version}.zip`,
    url: `https://github.com/${UPSTREAM}/releases/download/v${version}/Stronghold-Protocol-v${version}.zip`,
    size: null, digest: null,
  };
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, meta.name);
  const complete = () => {
    if (!existsSync(dest)) return false;
    const s = statSync(dest).size;
    if (meta.size ? s === meta.size : s > 1024 * 1024) return true;
    return false;
  };
  if (complete()) {
    log(`using the cached pack ${relative(repo, dest)} (${(statSync(dest).size / 1048576).toFixed(1)} MiB)`);
  } else {
    // github.com is unreachable on some networks while api.github.com works — try the known live proxies too
    const urls = [meta.url, ...['https://ghproxy.net/', 'https://gh-proxy.com/'].map((p) => p + meta.url)];
    log(`downloading ${meta.name}${meta.size ? ` (${(meta.size / 1048576).toFixed(1)} MiB)` : ''} — resumable, via curl`);
    for (let round = 1; round <= 6; round++) {
      for (const url of urls) {
        const args = ['-sL', '--retry', '2', '--retry-all-errors', '-C', '-', '-m', '1800', '-o', dest, url];
        const res = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { stdio: 'inherit' });
        if (complete()) break;
        log(`  ${res.status === 0 ? 'short response' : `curl exit ${res.status}`} — ${existsSync(dest) ? (statSync(dest).size / 1048576).toFixed(1) : 0} MiB so far, retrying`);
      }
      if (complete()) break;
    }
    if (!complete()) {
      console.error(`[release] could not download the pack. Download\n  ${meta.url}\nyourself (a VPN, or any ghproxy mirror) and re-run with:\n  node cloudflare/tools/release.mjs --from <path-to-zip>`);
      process.exit(1);
    }
    log(`pack ready: ${(statSync(dest).size / 1048576).toFixed(1)} MiB`);
  }
  if (meta.digest && !noVerify) {
    const got = await sha256File(dest);
    if (got !== meta.digest) { console.error(`[release] sha256 mismatch — the pack is not the published asset\n  expected ${meta.digest}\n  got      ${got}`); process.exit(1); }
    log(`sha256 matches the GitHub API digest (${got.slice(0, 16)}…)`);
  }
  return { path: dest, meta };
}

// ---- 2. which files belong in the release ---------------------------------------------------------------

const WALK_SKIP = new Set(['dist', '.git', '.generated', '.cache', '.wrangler', '.upstream', '.release', '__pycache__', '.venv', 'venv']);
const WALK_SKIP_PATH = [/^public[\\/]assets([\\/]|$)/, /^public[\\/]fonts([\\/]|$)/, /^data[\\/]local-assets\.json$/, /^cloudflare[\\/]config[\\/](?!.*\.example\.json$).+\.json$/, /\.log$/, /^cloudflare[\\/](dist|\.generated|node_modules|\.wrangler)[\\/]/];
const withNodeModules = flag('with-node-modules');   // upstream's own packages bundle node_modules; ours needs `npm ci`

/** The checkout's own files: git-tracked when possible (that is what the repository publishes), else a walk. */
function repoFiles() {
  if (!withNodeModules && existsSync(join(repo, '.git'))) {
    const res = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status === 0 && res.stdout) {
      const files = res.stdout.split('\0').filter(Boolean).map((p) => p.split('/').join(sep));
      log(`file list: ${files.length} git-tracked files`);
      return files;
    }
  }
  const out = [];
  const walk = (dir, rel) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (d.name === 'node_modules' && !(withNodeModules && rel === '')) continue;   // only the checkout's own
        if (!WALK_SKIP.has(d.name) && !WALK_SKIP_PATH.some((re) => re.test(r))) walk(join(dir, d.name), r);
      } else if (!WALK_SKIP_PATH.some((re) => re.test(r))) out.push(r.split('/').join(sep));
    }
  };
  walk(repo, '');
  log(`file list: ${out.length} files (directory walk${withNodeModules ? ', node_modules included' : ''})`);
  return out;
}

// ---- 3. the pack's asset entries ------------------------------------------------------------------------

const PACK_WANT = [/^public\/assets\//, /^public\/fonts\//, /^data\/local-assets\.json$/];

// ---- main -----------------------------------------------------------------------------------------------

const zipPath = join(outDir, `${name}-v${appVersion}.zip`);
const notesPath = join(outDir, `RELEASE-NOTES-${tag}.md`);
mkdirSync(outDir, { recursive: true });

let pack;
if (explicitPack) {
  // a locally downloaded pack gets the same treatment as one this script fetched: size and sha256 against the API
  const asset = upstreamAsset(appVersion);
  pack = {
    path: explicitPack,
    meta: { name: explicitPack.split(/[\\/]/).pop(), size: statSync(explicitPack).size, digest: asset?.digest ?? null, expected: asset?.size ?? null },
  };
  log(`using the pack given on the command line: ${explicitPack} (${(pack.meta.size / 1048576).toFixed(1)} MiB)`);
  if (pack.meta.expected && pack.meta.size !== pack.meta.expected) {
    console.error(`[release] that file is ${pack.meta.size} B, but upstream's ${upstreamAssetName(appVersion)} is ${pack.meta.expected} B — wrong or incomplete download`);
    process.exit(1);
  }
  if (pack.meta.digest && !noVerify) {
    const got = await sha256File(explicitPack);
    if (got !== pack.meta.digest) { console.error(`[release] sha256 mismatch — this file is not the published asset\n  expected ${pack.meta.digest}\n  got      ${got}`); process.exit(1); }
    log(`sha256 matches the GitHub API digest (${got.slice(0, 16)}…)`);
  }
} else {
  pack = await fetchPack(appVersion);
}

const src = readZip(pack.path);
log(`pack holds ${src.entries.length} entries${src.zip64 ? ' (zip64)' : ''}`);
// the pack wraps everything in one top-level folder (upstream: `Stronghold-Protocol/`) — keep that mapping
const top = (() => {
  const first = src.entries.find((e) => !e.dir);
  if (!first) return '';
  const seg = first.name.split('/')[0];
  return src.entries.every((e) => e.name.startsWith(`${seg}/`)) ? `${seg}/` : '';
})();
const wanted = src.entries.filter((e) => !e.dir && PACK_WANT.some((re) => re.test(e.name.slice(top.length))));
const totalRaw = wanted.reduce((n, e) => n + e.size, 0);
if (!wanted.length) { console.error(`[release] the pack has no public/assets, public/fonts or data/local-assets.json — is ${pack.path} really upstream's complete package?`); process.exit(1); }
log(`pack assets: ${wanted.length} files, ${(totalRaw / 1048576).toFixed(1)} MiB uncompressed`);

// a sanity check that shows up in the log when the versions do not line up
const packAssetsJson = src.entries.find((e) => e.name === `${top}data/assets.json`);
if (packAssetsJson) {
  const mine = join(repo, 'data', 'assets.json');
  if (existsSync(mine)) {
    const same = statSync(mine).size === packAssetsJson.size;
    if (!same) log(`note: the pack's data/assets.json (${packAssetsJson.size} B) differs from the checkout's (${statSync(mine).size} B) — the checkout's copy is kept (upstream's docs say so too)`);
  }
}

const files = repoFiles();
log(`writing ${relative(process.cwd(), zipPath)} …`);
if (existsSync(zipPath)) rmSync(zipPath);
const zip = zipWriter(zipPath);

/** Add a file of the checkout: deflated in memory (sources are small). */
let added = 0;
const addRepoFile = (relPath) => {
  const abs = join(repo, relPath);
  const st = statSync(abs);
  if (!st.isFile()) return false;
  const raw = readFileSync(abs);
  const packed = deflateRawSync(raw, { level: 6 });
  const { time, date } = dosTime(st.mtime);
  zip.add({ name: `${name}/${relPath.split(sep).join('/')}`, method: 8, crc: crc32(raw), compSize: packed.length, size: raw.length, time, date, data: packed });
  if (++added % 2000 === 0) log(`  ${added} files…`);
  return true;
};

for (const relPath of files) { try { addRepoFile(relPath); } catch (e) { log(`  skipped ${relPath}: ${e.message}`); } }
log(`checkout: ${added} files added`);

/** Add a pack entry by copying its compressed bytes (no re-encode). */
let copied = 0;
for (const e of wanted) {
  const entryName = `${name}/${e.name.slice(top.length)}`;
  const start = dataOffset(src.fd, e);
  if (e.method !== 0 && e.method !== 8) { log(`  skipped ${e.name}: compression method ${e.method}`); continue; }
  zip.add({ name: entryName, method: e.method, crc: e.crc, compSize: e.compSize, size: e.size, time: e.time, date: e.date, from: { fd: src.fd, start } });
  if (++copied % 2000 === 0) log(`  ${copied} assets…`);
}
log(`assets: ${copied} files copied verbatim`);

const { count, bytes } = zip.close();
closeSync(src.fd);
log(`zip written: ${count} entries, ${(bytes / 1048576).toFixed(1)} MiB`);

// ---- 4. verify by reading it back -----------------------------------------------------------------------
{
  const check = readZip(zipPath);
  const names = new Set(check.entries.map((e) => e.name));
  const required = [`${name}/README.md`, `${name}/cloudflare/build.mjs`, `${name}/cloudflare/DEPLOY.md`, `${name}/data/local-assets.json`, `${name}/${wanted[0].name.slice(top.length)}`];
  const missing = required.filter((n) => !names.has(n));
  closeSync(check.fd);
  if (missing.length) { console.error(`[release] the zip is missing: ${missing.join(', ')}`); process.exit(1); }
  log(`verified: ${check.entries.length} entries, assets and checkout both present`);
}

const digest = await sha256File(zipPath);
writeFileSync(`${zipPath}.sha256`, `${digest}  ${name}-v${appVersion}.zip\n`, 'utf8');

const commit = (() => { try { const r = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } })();
const upstreamAssetName = `Stronghold-Protocol-v${appVersion}.zip`;
const localPack = explicitPack ? `（本地文件 \`${explicitPack.split(/[\\/]/).pop()}\`）` : '';
const packLine = `上游 release 的 \`${upstreamAssetName}\`${localPack}${pack.meta.digest ? `，sha256 \`${pack.meta.digest}\` 已核对` : ''}`;
writeFileSync(notesPath, `# Stronghold-Protocol_cf_worker ${tag}

把《卫戍协议：盟约》部署到 Cloudflare Workers 的**完整包**：上游 v${appVersion} 的全部源码 + \`cloudflare/\` 适配层，
外加游戏素材（\`public/assets\`、\`public/fonts\`、\`data/local-assets.json\`），解压即可构建部署。

- 上游版本：v${appVersion}${pack.meta.tag ? `（release ${pack.meta.tag}）` : ''}${commit ? `，本仓库提交 \`${commit}\`` : ''}
- 素材来源：${packLine}
- 本包 sha256：\`${digest}\`

## 快速开始

\`\`\`bash
# 1) 依赖（仓库根目录）
npm ci
# 2) 适配层依赖（只是 wrangler）
cd cloudflare && npm ci
# 3) 组装并部署
npm run build
npx wrangler deploy           # 首次会要求 wrangler login
\`\`\`

公告 / 关于本服务器想用 KV（改内容不用重新部署）：\`npm run kv:create\`，见 \`cloudflare/DEPLOY.md\` §12.7。
本地先跑一局：\`npm run dev\`（默认 http://127.0.0.1:8787，另开终端 \`node tools/smoke.mjs\` 自检）。

## 已知事项

- 素材随包提供，**不必**再跑 \`node tools/setup.mjs\`（它只在缺素材时用，会跳过已存在的文件）。
- 部署的静态资源随版本上传（约 570 MB / 1 万余文件），首次 \`wrangler deploy\` 较慢，之后只传变化的部分。
- 适配层是纯增量目录，不修改上游任何文件；上游代码的许可见包内 \`LICENSE\` / \`NOTICE.md\`。
`, 'utf8');

console.log('');
log(`done → ${zipPath}`);
log(`      ${(statSync(zipPath).size / 1048576).toFixed(1)} MiB, sha256 ${digest.slice(0, 16)}… (also in ${relative(process.cwd(), `${zipPath}.sha256`)})`);
log(`      release notes → ${relative(process.cwd(), notesPath)}`);
log('the three files are ready to ship — this script does not publish anything');
if (!keepCache && !explicitPack) log('(the upstream pack stays in .cache/releases/ — delete it when you are done, or pass --keep-cache to silence this)');
