// cloudflare/src/data-preroll.js — writes the bundled game data into the Workers VFS at module-initialization
// time, before the simulation's own module-scope data load runs.
//
// Why this file exists: server/sim/simdata.js, imported (transitively) by server/match/effectsMeta.js, loads
// the generated data *at module scope* under Node — `server/sim/nodeData.js loadGenerated()` calls
// `server/data.js getData()` with no arguments, which loads from DATA_DIR and caches the result in the
// singleton. Module initialization happens before GameServer's constructor, so if DATA_DIR were still empty at
// that moment the sim would cache an empty data set and the match would abort with "no chess pool".
//
// Import order is what buys that: ESM evaluates a module's dependencies in source order, depth first, so both
// entry points (src/worker.js, src/game-server.js) import this file *first* — everything it depends on is
// initialized before the rest of their graphs, including server/sim/simdata.js. bootData() then re-checks the
// singleton defensively (src/data-boot.js).

import { materializeData } from './data-boot.js';

/** Set once the data files have been written into the VFS. */
export const prerolled = materializeData() > 0;
