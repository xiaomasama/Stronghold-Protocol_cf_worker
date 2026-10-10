#!/usr/bin/env node
// cloudflare/tools/export.mjs — pack this adapter into a standalone folder for distribution.
//
//   node tools/export.mjs [targetDir]        (from cloudflare/; default: ../Stronghold-Protocol-Cloudflare)
//
// The adapter is meant to be dropped into a Stronghold-Protocol checkout — the original (sganggs) or a fork such as
// xinhai-ai's — so the published folder mirrors exactly that: a top-level README/VERSION for whoever receives it,
// one `cloudflare/` directory to copy into their checkout, and the project's LICENSE/NOTICE so the license travels
// with it. Build products (dist/, .generated/, the generated modules, node_modules, wrangler state, logs) are left
// out: `npm run build` recreates them.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));   // …/cloudflare/tools
const adapter = dirname(here);                          // …/cloudflare
const repo = dirname(adapter);                          // the checkout the adapter lives in
const target = process.argv[2] ? resolve(process.argv[2]) : join(repo, '..', 'Stronghold-Protocol-Cloudflare');

/** Everything the adapter is made of (relative to cloudflare/). */
const ITEMS = ['.gitignore', 'README.md', 'DEPLOY.md', 'build.mjs', 'wrangler.jsonc', 'package.json', 'package-lock.json', 'src', 'public', 'tools', 'config'];
/** Build products and local state that must not ship. */
const EXCLUDE = new Set(['node_modules', 'dist', '.generated', '.wrangler', '.dev.vars', 'dev.log', 'dev-default.log', 'dev-server.log', 'npm-ci.log',
  // kept local on purpose: the release packager and its write-up are not part of the published adapter
  'release.mjs', 'RELEASE.local.md']);
const EXCLUDE_FILE = /\.generated\.js$|\.out$/;

const log = (...a) => console.log('[export]', ...a);

function copyDir(from, to, base = from) {
  mkdirSync(to, { recursive: true });
  const inConfigDir = basename(from) === 'config';
  for (const d of readdirSync(from, { withFileTypes: true })) {
    // deployment configs are per server; the *.example.json templates ship instead (see .gitignore)
    if (inConfigDir && d.isFile() && d.name.endsWith('.json') && !d.name.endsWith('.example.json')) continue;
    if (EXCLUDE.has(d.name) || EXCLUDE_FILE.test(d.name)) continue;
    const src = join(from, d.name);
    const dst = join(to, d.name);
    if (d.isDirectory()) copyDir(src, dst, base);
    else if (d.isFile()) cpSync(src, dst);
  }
}

// ------------------------------------------------------------------------------------------------
// 1. the adapter itself
// ------------------------------------------------------------------------------------------------

rmSync(join(target, 'cloudflare'), { recursive: true, force: true });
mkdirSync(join(target, 'cloudflare'), { recursive: true });
let files = 0;
for (const item of ITEMS) {
  const src = join(adapter, item);
  if (!existsSync(src)) { log(`skip ${item} (not present)`); continue; }
  if (statSync(src).isDirectory()) copyDir(src, join(target, 'cloudflare', item));
  else cpSync(src, join(target, 'cloudflare', item));
}
const count = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? count(join(dir, d.name)) : 1), 0);
files = count(join(target, 'cloudflare'));
log(`cloudflare/: ${files} files`);

// ------------------------------------------------------------------------------------------------
// 2. what travels with it: the license (GPL-3.0-or-later) and the asset notices
// ------------------------------------------------------------------------------------------------

for (const name of ['LICENSE', 'NOTICE.md']) {
  if (existsSync(join(repo, name))) cpSync(join(repo, name), join(target, name));
}

// ------------------------------------------------------------------------------------------------
// 3. VERSION + README for the person receiving the bundle
// ------------------------------------------------------------------------------------------------

const git = (args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : '';
};
let app = '?';
try {
  const m = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(repo, 'shared', 'constants.js'), 'utf8'));
  if (m) app = m[1];
} catch { /* not a checkout */ }
const commit = git(['rev-parse', '--short', 'HEAD']);
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
// untracked files do not count: the adapter itself lives in an untracked cloudflare/ folder
const dirty = git(['status', '--porcelain', '--untracked-files=no']) ? ' + uncommitted changes' : '';

writeFileSync(join(target, 'VERSION'), [
  `# Stronghold-Protocol · Cloudflare adapter`,
  `adapter:    cloudflare/ (see cloudflare/README.md)`,
  `built:      ${new Date().toISOString()}`,
  `upstream:   ${app}${commit ? ` @ ${commit}` : ''}${branch ? ` (${branch}${dirty})` : ''}`,
  `compat:     verified against sganggs/Stronghold-Protocol 0.2.1 and xinhai-ai/Stronghold-Protocol 0.2.0`,
  `deploy:     Cloudflare Workers + one Durable Object; see cloudflare/DEPLOY.md`,
  '',
].join('\n'));

writeFileSync(join(target, 'README.md'), [
  '# Stronghold-Protocol · Cloudflare Workers 适配层（发布包）',
  '',
  '把《卫戍协议：盟约》搬到 Cloudflare Workers 上的适配层：**不改动游戏仓库的任何文件**，',
  '只往检出里放一个 `cloudflare/` 目录。原版（[sganggs](https://github.com/sganggs/Stronghold-Protocol)）',
  '与分支 [xinhai-ai](https://github.com/xinhai-ai/Stronghold-Protocol) 都验证过。',
  '',
  '## 用法（三步）',
  '',
  '```bash',
  '# 1. 准备一个 Stronghold-Protocol 检出（原版或 fork），装好依赖与素材',
  'git clone https://github.com/sganggs/Stronghold-Protocol.git',
  'cd Stronghold-Protocol && npm ci && node tools/setup.mjs   # 素材约 270 MB，可跳过（用占位图）',
  '',
  '# 2. 把本包里的 cloudflare/ 整个拷到检出根目录，然后',
  'cd cloudflare && npm install && npm run build',
  '',
  '# 3. 本地跑通后发布',
  'npx wrangler dev                     # http://127.0.0.1:8787',
  'node tools/smoke.mjs http://127.0.0.1:8787',
  'npx wrangler login && npx wrangler deploy',
  '```',
  '',
  '## 里面有什么',
  '',
  '| 路径 | 说明 |',
  '|---|---|',
  '| `cloudflare/` | 适配层本体（拷进检出即可用） |',
  '| `cloudflare/DEPLOY.md` | **完整部署与运维手册**：准备、构建、本地验证、登录、部署、验证、域名、成本、公告、预载、延迟优化、排错、回滚 |',
  '| `cloudflare/README.md` | 总览：架构（一个 Durable Object = 原来的一个 Node 进程）、为什么是 Workers 而不是 Pages、实测结论、已知差异 |',
  '| `cloudflare/config/announcements.example.json` | 站点公告的示例文档（fork 沿用其 `config/announcements.json`） |',
  '| `cloudflare/tools/smoke.mjs` | 端到端自检（静态资源、内容包、语言包、公告、预载、建房/加入/断线重连） |',
  '| `cloudflare/tools/match-drive.mjs` | 真打一局，验证服务端战斗模拟 |',
  '| `cloudflare/tools/stop-dev.mjs` | 停掉本目录的 dev 进程（构建/安装前用） |',
  '| `cloudflare/tools/export.mjs` | 重新导出这个发布包 |',
  '',
  '## 兼容性',
  '',
  '- **原版 sganggs**：0.2.1 实测通过（构建期会把 `server/sim/content` 里的计算型动态导入改写成字面量，',
  '  否则内容模块在 Worker 里会静默失效；写法一变构建就报错）。',
  '- **fork xinhai-ai**：0.2.0 实测通过（它的源码本身就是字面量加载器，无需改写；它自带的公告客户端会接管公告显示，',
  '  适配层不注入自己的横幅；公告数据延续其 `config/announcements.json`）。',
  '',
  '## 许可',
  '',
  '与上游项目相同：**GPL-3.0-or-later**（见 `LICENSE`）。本包**不含任何游戏素材**；素材版权归上海鹰角网络 / Yostar，',
  '仅限非商业同人使用（见 `NOTICE.md`）。',
  '',
].join('\n'));

log(`README.md + VERSION written (upstream ${app}${commit ? ` @ ${commit}` : ''})`);
log(`done → ${target}`);
log('next: copy the cloudflare/ folder into a Stronghold-Protocol checkout and follow cloudflare/DEPLOY.md');
