#!/usr/bin/env node
// cloudflare/tools/stop-dev.mjs — stop every `wrangler dev` / workerd process of this adapter.
//
//   npm run dev:stop        (from cloudflare/)
//
// Why this exists: on Windows a running `wrangler dev` keeps handles on `cloudflare/node_modules` and
// `cloudflare/dist`, so the next `npm install` fails with
//   EBUSY: resource busy or locked, rename …node_modules\miniflare\…
// and the next `npm run build` fails with
//   EPERM: Permission denied … \cloudflare\dist
// Stopping dev first is the fix. It also frees the port when a dev server was left behind by a closed
// terminal (the usual "port already in use" case).
//
// Only processes whose command line points into this cloudflare/ directory are stopped — a dev server of
// some other project, or this script itself, is left alone.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));           // …/cloudflare/tools
const adapterDir = dirname(here);                               // …/cloudflare
const self = process.pid;
const isWindows = process.platform === 'win32';

/** PIDs of node/workerd processes whose command line mentions this adapter directory. */
function findProcesses() {
  if (isWindows) {
    const ps = [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='workerd.exe'\" | " +
      'Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ];
    const r = spawnSync('powershell', ps, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { return []; }
    if (!Array.isArray(rows)) rows = [rows];
    return rows
      .filter((p) => p && typeof p.CommandLine === 'string' && p.CommandLine.includes(adapterDir))
      .map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name || '?'), cmd: p.CommandLine }));
  }
  // POSIX: pgrep/pkill are in procps (Linux) and available on macOS
  const r = spawnSync('pgrep', ['-af', adapterDir], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const sp = line.indexOf(' ');
    return { pid: Number(line.slice(0, sp)), name: 'node', cmd: line.slice(sp + 1) };
  });
}

const targets = findProcesses().filter((p) => p.pid && p.pid !== self);

if (!targets.length) {
  console.log('[dev:stop] no wrangler dev / workerd process of this adapter is running');
  process.exit(0);
}

console.log(`[dev:stop] stopping ${targets.length} process(es) holding ${adapterDir}`);
for (const p of targets) {
  const label = `${p.name} pid=${p.pid}`;
  const r = isWindows
    ? spawnSync('taskkill', ['/PID', String(p.pid), '/F', '/T'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('kill', ['-TERM', String(p.pid)], { encoding: 'utf8' });
  const failed = r.status !== 0 || /找不到进程|not found|No such process/i.test(`${r.stdout || ''}${r.stderr || ''}`);
  console.log(`  ${failed ? 'skip  ' : 'stopped'} ${label}${failed ? ' — already gone' : ''}`);
}
console.log('[dev:stop] done — `npm run build` and `npm install` can run again');
