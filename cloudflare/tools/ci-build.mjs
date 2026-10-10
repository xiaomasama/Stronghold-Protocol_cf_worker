#!/usr/bin/env node
// cloudflare/tools/ci-build.mjs — the build step for Cloudflare Workers Builds (Git integration).
//
// Settings in the dashboard ("Settings → Builds → Connect", root directory = cloudflare/):
//
//   Root directory   cloudflare                      ← wrangler.jsonc lives here; the whole repo is still checked out
//   Build command    node tools/ci-build.mjs         ← this file
//   Deploy command   npx wrangler deploy             ← the default, correct as it is
//
// This file exists because the assets the game is served with are **not in the repository** (public/assets,
// public/fonts, data/local-assets.json are all .gitignore'd — 500 MB of game data does not belong in git), so a
// bare `node build.mjs` in a fresh CI checkout would assemble a placeholder-only dist and then *replace* the live
// site with it. The guard below refuses to build when the assets are missing.
//
// What it runs, skipping work that is already done (so the same command is also handy locally):
//   1. `npm ci` at the repository root — the game's own dependencies; their postinstall (tools/vendor.mjs) copies
//      PixiJS / three.js / Preact into public/vendor/, which the browser client loads. Skipped when node_modules
//      already exists.
//   2. `node tools/setup.mjs` — fetches the public mirror of the game assets and fonts (≈270 MB, skips what is
//      already on disk). Skipped when public/assets is already populated. This is the step that takes the time in
//      CI; everything else is a couple of minutes.
//   3. a check on the asset tree: the build refuses to run when public/assets is empty, and warns (does not fail)
//      when the locally-extracted official art (public/assets/local + data/local-assets.json, ~74 MB, extracted
//      from the Arknights client on your own machine) is missing — that part cannot be reproduced in CI, see
//      DEPLOY.md「用 Workers Builds 从仓库自动构建部署」.
//   4. `node build.mjs` — assembles dist/ and the generated modules.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));   // …/cloudflare/tools
const adapter = dirname(here);                          // …/cloudflare
const repo = dirname(adapter);                          // the checkout
const log = (...a) => console.log('[ci-build]', ...a);
const run = (cmd, args, cwd, timeoutMs) => {
  log(`$ ${cmd} ${args.join(' ')}   (in ${cwd === repo ? '.' : cwd})`);
  // Windows needs a shell for `npm` (it is npm.cmd) — quote the arguments for it; POSIX spawns directly
  const win = process.platform === 'win32';
  const q = (a) => (win && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const r = spawnSync(cmd, win ? args.map(q) : args, { cwd, stdio: 'inherit', shell: win, timeout: timeoutMs });
  if (r.status !== 0) { console.error(`[ci-build] FAILED: ${cmd} ${args.join(' ')} (exit ${r.status}${r.error ? `, ${r.error.message}` : ''})`); process.exit(r.status || 1); }
};

const countFiles = (dir, depth = 0) => {
  if (depth > 6) return 0;
  let n = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) n += countFiles(join(dir, d.name), depth + 1);
    else if (d.isFile()) n += 1;
  }
  return n;
};

// 1) the game's dependencies + public/vendor
if (existsSync(join(repo, 'node_modules'))) log('root node_modules present — skipping `npm ci`');
else run('npm', ['ci'], repo, 10 * 60 * 1000);

// 2) the game assets
const assets = join(repo, 'public', 'assets');
const populated = existsSync(assets) && readdirSync(assets).length > 0;
if (populated) log(`public/assets present (${countFiles(assets)} files) — skipping tools/setup.mjs`);
else run('node', [join('tools', 'setup.mjs')], repo, 15 * 60 * 1000);

// 3) the guard: never assemble (and therefore never deploy) a placeholder-only site
if (!existsSync(assets) || readdirSync(assets).length === 0) {
  console.error('[ci-build] public/assets is empty — refusing to build. Run `node tools/setup.mjs` (needs network) '
    + 'or make sure the build environment can fetch the assets.');
  process.exit(1);
}
const sizeOf = (dir, depth = 0) => {
  if (depth > 6) return 0;
  let n = 0;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) n += sizeOf(join(dir, d.name), depth + 1);
    else if (d.isFile()) { try { n += statSync(join(dir, d.name)).size; } catch { /* ignore */ } }
  }
  return n;
};
log(`assets: ${countFiles(assets)} files, ${(sizeOf(assets) / 1048576).toFixed(1)} MiB`);
const localArt = join(assets, 'local');
const localManifest = join(repo, 'data', 'local-assets.json');
if (!existsSync(localArt) || !existsSync(localManifest)) {
  log('NOTE: the locally-extracted official art is missing (public/assets/local + data/local-assets.json).');
  log('      The build will use placeholders for those pieces (3D boards and a few official UI bits).');
  log('      That art comes from an Arknights client on a local machine — commit it or ship it as an asset to keep it.');
} else {
  log(`locally-extracted art: present (${countFiles(localArt)} files)`);
}

// 4) assemble dist/
run('node', ['build.mjs'], adapter, 15 * 60 * 1000);
log('done — `npx wrangler deploy` takes it from here');
