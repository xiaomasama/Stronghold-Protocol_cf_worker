#!/usr/bin/env node
// cloudflare/tools/match-drive.mjs — drive a real match over the WebSocket and report what the server did.
//
//   node cloudflare/tools/match-drive.mjs [base] [--bots=3] [--combat=server|client] [--seconds=240]
//
// It plays the part of a browser: create a room, fill it with bots, ready up, start, then answer every phase
// (INFO_CHECK → g.infoReady, BAND_DRAFT → g.bandSkip, SP_DRAFT → g.choice, PREP → g.ready) and watch.
//
// What this verifies that the smoke test does not: the *server-side battle simulation* — the 8 ms-sliced
// bot/headless fields of the match engine — runs inside the Durable Object. With --combat=server every field
// is simulated on the server, so a COMBAT phase that starts *and finishes* is proof; with --combat=client
// (the default) the bots' fields are still simulated server-side while the human field waits for a browser
// report, so the match is expected to stay in COMBAT.
//
// It also polls /healthz while the match runs, to show the object stays responsive under the simulation
// (the match engine slices its work precisely so that other messages are not starved).

import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION } from '../../shared/constants.js';

/** Valid band ids for `g.band` (the draft is untimed in co-op: the human's turn has to be played). */
const BAND_IDS = Object.keys(JSON.parse(readFileSync(new URL('../../data/bands.json', import.meta.url), 'utf8')));

const argv = process.argv.slice(2);
const base = (argv.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8790').replace(/\/$/, '');
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const bots = Number(opt('bots', '3'));
const combat = opt('combat', 'client');
const seconds = Number(opt('seconds', '240'));
const wsBase = base.replace(/^http/, 'ws');

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...a) => console.log(stamp(), ...a);

const counts = new Map();
const errors = [];
const retryErrors = [];
const phases = [];
const healthLatencies = [];
let lastPhase = null;
let lastRound = 0;
let combatStarts = 0;
let combatEnds = 0;
let finished = false;
let started = false;
let startSent = false;
let botsSeated = 0;
let readySent = false;
let answeredPrepRound = 0;
let bandIndex = 0;
let lastAction = { phase: null, at: 0 };

const ws = new WebSocket(`${wsBase}/ws`);
let rid = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, rid: ++rid }));

ws.addEventListener('open', () => {
  log('socket open — hello');
  send({ t: 'hello', name: 'match-drive', version: PROTOCOL_VERSION });
});
ws.addEventListener('close', (ev) => { log(`socket closed code=${ev.code} reason=${ev.reason}`); finish(); });
ws.addEventListener('error', () => log('socket error'));

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  counts.set(msg.t, (counts.get(msg.t) || 0) + 1);

  if (msg.t === 'welcome') {
    log(`welcome playerId=${msg.playerId}`);
    send({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY' });
    return;
  }
  if (msg.t === 'error') {
    const retryable = ['BAD_TARGET', 'BAD_FIELD', 'WRONG_PHASE', 'RATE', 'NOT_YOUR_TURN', 'BAD_CHOICE'].includes(msg.code);
    log(`ERROR frame code=${msg.code} detail=${msg.detail || ''}${retryable ? ' (driving on)' : ''}`);
    if (retryable) retryErrors.push(msg); else errors.push(msg);
    if (retryable && lastPhase === 'BAND_DRAFT') { const bandId = BAND_IDS[bandIndex++ % BAND_IDS.length]; send({ t: 'g.band', bandId }); }
    return;
  }
  if (msg.t === 'room.state') {
    if (msg.match) return;
    botsSeated = (msg.seats || []).filter((s) => s && s.isBot).length;
    if (botsSeated < bots) { send({ t: 'room.addBot' }); return; }
    if (!readySent) { readySent = true; log(`room ${msg.code}: ${botsSeated} bots seated — ready + start`); send({ t: 'room.ready', ready: true }); setTimeout(() => { startSent = true; send({ t: 'room.start' }); }, 500); }
    return;
  }
  if (msg.t === 'm.result') { log('m.result — match over'); finish(); return; }
  if (msg.t !== 'm.public') return;

  if (msg.phase !== lastPhase) {
    if (lastPhase === 'COMBAT') combatEnds++;
    phases.push(`${msg.phase}@r${msg.round}`);
    log(`phase ${lastPhase || '-'} → ${msg.phase} (round ${msg.round}, ` +
      `deadline ${msg.deadline ? Math.round((msg.deadline - msg.serverNow) / 1000) + 's' : 'none'}, combat=${msg.combatMode})`);
    lastPhase = msg.phase;
    if (msg.phase === 'COMBAT') combatStarts++;
    started = true;
    act(msg, true);
  } else if (Date.now() - lastAction.at > 3000) {
    // the phase is waiting on this player (a draft turn, the prep ready flag, …): nudge it again
    act(msg, false);
  }
  if (msg.round !== lastRound) { log(`round ${lastRound} → ${msg.round}`); lastRound = msg.round; }
});

/** Play this player's part of a phase (the driver is the only human in the room). */
function act(msg, phaseChanged) {
  const now = Date.now();
  if (phaseChanged && msg.phase === 'BAND_DRAFT') bandIndex = 0;
  switch (msg.phase) {
    case 'INFO_CHECK':
      if (phaseChanged) send({ t: 'g.infoReady' });
      break;
    case 'BAND_DRAFT':
      // an untimed cooperative draft waits for the human: take the next untaken band
      if (phaseChanged || now - lastAction.at > 3000) {
        const bandId = BAND_IDS[bandIndex % BAND_IDS.length];
        bandIndex++;
        send({ t: 'g.band', bandId });
      }
      break;
    case 'SP_DRAFT':
    case 'ROUND_START':
      if (phaseChanged) send({ t: 'g.choice', idx: 0 });
      break;
    case 'PREP':
      if (msg.round !== answeredPrepRound) { answeredPrepRound = msg.round; send({ t: 'g.ready', ready: true }); }
      else if (now - lastAction.at > 3000) send({ t: 'g.ready', ready: true });
      break;
    default:
      break;
  }
  lastAction = { phase: msg.phase, at: now };
}

async function pollHealth() {
  for (;;) {
    if (finished) return;
    const t = Date.now();
    try { const res = await fetch(`${base}/healthz`); await res.json(); healthLatencies.push(Date.now() - t); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function verdict() {
  if (errors.length) return `FAILED — ${errors.length} error frame(s)`;
  if (combatStarts === 0) return 'INCONCLUSIVE — never reached COMBAT';
  if (combat === 'server' && combatEnds > 0) return 'OK — a server-side battle started AND finished inside the Durable Object';
  if (combat === 'server') return 'PARTIAL — COMBAT started but did not finish within the time budget';
  return 'OK — COMBAT reached; the bot fields run on the server, the human field awaits a browser by design';
}

function finish() {
  if (finished) return;
  finished = true;
  const sorted = [...healthLatencies].sort((a, b) => a - b);
  const p = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
  console.log('\n----------- summary -----------');
  console.log('phases       :', phases.join(' → ') || '(none)');
  console.log('rounds       :', lastRound);
  console.log('COMBAT       :', combatStarts, 'started /', combatEnds, 'left');
  console.log('frames       :', [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)');
  console.log('error frames :', errors.length ? errors.map((e) => `${e.code}(${e.detail || ''})`).join(', ') : 'none'
    + (retryErrors.length ? `  [${retryErrors.length} driving retries: ${[...new Set(retryErrors.map((e) => e.code))].join(', ')}]` : ''));
  console.log('healthz polls:', `${healthLatencies.length} — p50=${p(0.5)}ms p90=${p(0.9)}ms max=${sorted[sorted.length - 1] ?? 0}ms`);
  console.log(`wall time    : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('verdict      :', verdict());
  process.exit(errors.length || (combat === 'server' && combatEnds === 0) ? 1 : 0);
}

setTimeout(finish, seconds * 1000);
void pollHealth();
