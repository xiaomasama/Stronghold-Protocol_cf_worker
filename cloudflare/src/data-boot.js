// cloudflare/src/data-boot.js — hands server/data.js its game data inside the Workers virtual file system.
//
// server/data.js (untouched) loads every `data/*.json` with node:fs — `fs.readdirSync(dir, {withFileTypes})`
// plus `fs.readFileSync(path.join(dir, file), 'utf8')` — and keeps the parsed result in a module-level
// singleton that server/lobby.js and server/match/* read back through `getData()`.
//
// Workers has no real file system: only `/bundle` (read-only, the bundled modules) and `/tmp` (writable) exist.
// So the build script emits `./data-modules.generated.js`, which imports every data/*.json as *text* (the Text
// rule in wrangler.jsonc), and this module writes those files into DATA_VFS_DIR before anything reads them.
//
// The directory is exactly what server/data.js computes as its DATA_DIR (see src/url-shim.js), which matters
// twice over:
//
//   * server/sim/simdata.js loads the data at *module scope* under Node (server/sim/nodeData.js
//     `loadGenerated` → `getData()` with no arguments) — imported by server/match/effectsMeta.js, i.e. as soon
//     as the Durable Object module graph initializes, before GameServer.boot() runs. src/data-preroll.js
//     materializes the files first, so that early call loads the real data instead of caching {} into the
//     singleton ("no chess pool — ending the match", the failure this arrangement exists to prevent).
//   * boot() then calls getData({ dir }) — normally the singleton is already there; resetData() guards the
//     case where it was filled from somewhere else.

import fs from 'node:fs';
import path from 'node:path';
import { getData, resetData } from '../.generated/server/data.js';
import { DATA_TEXT } from './data-modules.generated.js';

/**
 * Where the bundled JSON is materialized inside the Worker — must stay in sync with the DATA_DIR that
 * src/url-shim.js's fallback path produces for server/data.js (`/tmp/stronghold` + `/data`).
 */
export const DATA_VFS_DIR = '/tmp/stronghold/data';

/** @type {Readonly<Record<string, any>> | null} */
let cached = null;

/**
 * Write the bundled data files into the VFS. Never throws: a data file that cannot be written is logged by
 * name, so the resulting "missing data file" warning of server/data.js has a visible cause.
 *
 * Not cached: the Workers /tmp is scoped to the request that wrote it ("unique to each request"), so a write
 * from an earlier request — or from the preroll's module initialization in a different one — is invisible
 * later. Materializing and reading therefore have to happen inside the same call (see bootData).
 * @param {{ info?: Function, warn?: Function, error?: Function }} [log]
 * @returns {number} how many files were written
 */
export function materializeData(log = console, { quiet = false } = {}) {
  const names = Object.keys(DATA_TEXT);
  try {
    fs.mkdirSync(DATA_VFS_DIR, { recursive: true });
  } catch { /* already there */ }
  let written = 0;
  for (const name of names) {
    try {
      fs.writeFileSync(path.join(DATA_VFS_DIR, name), DATA_TEXT[name]);
      written++;
    } catch (e) {
      log.error?.(`[data-boot] cannot materialize ${name}: ${e && e.message}`);
    }
  }
  if (!quiet) log.info?.(`[data-boot] ${written}/${names.length} data files written to ${DATA_VFS_DIR}`);
  return written;
}

/**
 * Load the game data singleton. Called once per Durable Object instance, before the lobby is constructed.
 * The write and the read must stay in this one synchronous block (see materializeData).
 * @param {{ info?: Function, warn?: Function, error?: Function }} [log]
 */
export function bootData(log = console) {
  if (cached) return cached;
  materializeData(log, { quiet: true });
  resetData(); // drop anything an early caller cached (from a request whose /tmp is gone)
  cached = getData({ dir: DATA_VFS_DIR, log });
  const keys = Object.keys(cached).length;
  if (keys === 0) log.error?.(`[data-boot] game data is EMPTY — ${DATA_VFS_DIR} holds no readable *.json`);
  else log.info?.(`[data-boot] game data: ${keys} keys (${Object.keys(DATA_TEXT).length} files bundled)`);
  return cached;
}

/** Tests / tools: drop the cached singleton so the next bootData() loads again. */
export function resetBootData() {
  cached = null;
  resetData();
}
