// cloudflare/src/announce.js — site announcements for this deployment.
//
// Mirrors the announcement API of the xinhai-ai fork (config/announcements.json + GET /api/announcement,
// GET /api/popup-announcement) so the same document format works here, but keeps everything inside the
// adapter: the upstream game code is not touched.
//
// Storage, in order of preference:
//   * the optional KV binding `ANNOUNCE` (key `announcements`) — publish with
//     `npx wrangler kv key put --binding=ANNOUNCE announcements --path cloudflare/config/announcements.json`
//     and the change is live without a redeploy (a deploy would restart the game server object);
//   * the `[vars] SP_ANNOUNCEMENTS` JSON string — works everywhere, but needs a redeploy to change.
//
// Document format (same as the fork, see cloudflare/config/announcements.example.json):
//   { "announcements": [ { id, type: "scroll" | "popup", text, title?, url?, autoPopup?, level, startAt,
//                          durationSeconds, enabled } ] }
// `startAt` is an ISO timestamp with an explicit timezone; an entry is live between startAt and
// startAt + durationSeconds. Levels: info | warning | urgent.
//
// GET /api/announcement        → the live "scroll" entry (HTTP 200, body = that entry) or 204 when none
// GET /api/popup-announcement  → the live "popup" entry, same rules
// POST /api/announce           → replace the document (needs the SP_ADMIN_TOKEN secret), then push it to
//                                every connected client through the game object

export const ANNOUNCEMENT_MAX_TEXT = 500;
export const ANNOUNCEMENT_MAX_COUNT = 100;
export const ANNOUNCEMENT_LEVELS = ['info', 'warning', 'urgent'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** An HTTP(S) URL without credentials. */
export function validAnnouncementUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Validate a whole document at once (a half-written edit never replaces the last good one).
 * @param {unknown} doc
 * @returns {Array<object>} the entries, with numeric startAt/endAt
 */
export function parseAnnouncements(doc) {
  if (!isObj(doc) || !Array.isArray(doc.announcements)) throw new Error('announcements must be an array');
  if (doc.announcements.length > ANNOUNCEMENT_MAX_COUNT) throw new Error(`at most ${ANNOUNCEMENT_MAX_COUNT} entries`);
  const ids = new Set();
  return doc.announcements.map((row) => {
    if (!isObj(row)) throw new Error('invalid announcement');
    const { id, text, startAt, durationSeconds, level = 'info', enabled = true, type = 'scroll' } = row;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error('ids must be unique (1..64 of A-Za-z0-9_-)');
    ids.add(id);
    if (type !== 'scroll' && type !== 'popup') throw new Error(`${id}: type must be scroll or popup`);
    if (typeof text !== 'string' || !text.trim() || [...text].length > ANNOUNCEMENT_MAX_TEXT || CONTROL.test(text)) {
      throw new Error(`${id}: text must contain 1..${ANNOUNCEMENT_MAX_TEXT} printable characters`);
    }
    if (typeof startAt !== 'string' || !TIME.test(startAt) || !Number.isFinite(Date.parse(startAt))) {
      throw new Error(`${id}: startAt requires an ISO date with an explicit timezone`);
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) {
      throw new Error(`${id}: durationSeconds must be 1..86400`);
    }
    if (typeof level !== 'string' || !ANNOUNCEMENT_LEVELS.includes(level)) throw new Error(`${id}: invalid level`);
    if (typeof enabled !== 'boolean') throw new Error(`${id}: enabled must be boolean`);
    const out = { id, type, text: text.trim().replace(/\s+/g, ' '), level, enabled, startAt: Date.parse(startAt) };
    out.endAt = out.startAt + durationSeconds * 1000;
    if (row.title !== undefined) {
      if (typeof row.title !== 'string' || !row.title.trim() || row.title.trim().length > 80 || CONTROL.test(row.title)) {
        throw new Error(`${id}: title must contain 1..80 printable characters`);
      }
      out.title = row.title.trim();
    }
    if (row.url !== undefined) {
      if (!validAnnouncementUrl(row.url)) throw new Error(`${id}: url must be an HTTP(S) URL without credentials`);
      if (type !== 'popup') throw new Error(`${id}: url is only supported for popup announcements`);
      out.url = row.url;
    }
    if (row.autoPopup !== undefined) {
      if (typeof row.autoPopup !== 'boolean') throw new Error(`${id}: autoPopup must be boolean`);
      if (type !== 'popup') throw new Error(`${id}: autoPopup is only supported for popup announcements`);
      out.autoPopup = row.autoPopup;
    }
    return out;
  });
}

/** The entry of `type` that is live right now (null when none). */
export function liveAnnouncement(entries, type, now) {
  for (const e of entries) {
    if (!e.enabled || e.type !== type) continue;
    if (now >= e.startAt && now < e.endAt) return e;
  }
  return null;
}

/**
 * Read the current document: the KV binding when present, otherwise the `SP_ANNOUNCEMENTS` var.
 * Never throws — a broken document means "no announcements", and the reason is logged.
 * @param {{ ANNOUNCE?: { get: (k: string) => Promise<string | null> }, SP_ANNOUNCEMENTS?: string }} env
 * @param {{ warn?: Function }} [log]
 */
export async function readAnnouncements(env, log = console) {
  let raw = null;
  try {
    if (env && env.ANNOUNCE && typeof env.ANNOUNCE.get === 'function') raw = await env.ANNOUNCE.get('announcements');
  } catch (e) {
    log.warn?.('[announce] KV read failed', e && e.message);
  }
  if (raw == null && env && typeof env.SP_ANNOUNCEMENTS === 'string' && env.SP_ANNOUNCEMENTS.trim()) {
    raw = env.SP_ANNOUNCEMENTS;
  }
  if (raw == null || raw === '') {
    // The repository's config/announcements.json, baked in at build time (a fork feature) — the last fallback, so
    // an operator of such a fork can keep editing that file.
    try {
      const { DEFAULT_ANNOUNCEMENTS } = await import('./announce-config.generated.js');
      if (DEFAULT_ANNOUNCEMENTS) return parseAnnouncements(DEFAULT_ANNOUNCEMENTS);
    } catch { /* module missing (older adapter build): nothing to fall back to */ }
    return [];
  }
  try {
    return parseAnnouncements(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch (e) {
    log.warn?.('[announce] ignoring an invalid document:', e && e.message);
    return [];
  }
}

/**
 * Validate a document and store it: in KV when the binding exists, otherwise only in memory (the caller keeps
 * it in the Durable Object, so publishing works without KV — it just does not survive an object restart).
 * @returns {Promise<{ entries: Array<object>, stored: 'kv' | 'memory' }>}
 */
export async function writeAnnouncements(env, doc) {
  const entries = parseAnnouncements(doc); // throws with a readable reason
  if (env && env.ANNOUNCE && typeof env.ANNOUNCE.put === 'function') {
    await env.ANNOUNCE.put('announcements', JSON.stringify(doc));
    return { entries, stored: 'kv' };
  }
  return { entries, stored: 'memory' };
}

/** The public body of one announcement (never echoes internal fields beyond the format). */
export function announcementBody(entry, now) {
  return {
    id: entry.id, type: entry.type, ...(entry.title ? { title: entry.title } : {}),
    text: entry.text, ...(entry.url ? { url: entry.url } : {}),
    ...(entry.autoPopup !== undefined ? { autoPopup: entry.autoPopup } : {}),
    level: entry.level, startAt: entry.startAt, endAt: entry.endAt, serverNow: now,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/**
 * The announcement endpoints (called from src/worker.js).
 * @returns {Promise<Response | null>} null when the path is not an announcement route
 */
export async function serveAnnounceApi(request, env, url, push, read) {
  const p = url.pathname;
  if (p !== '/api/announcement' && p !== '/api/popup-announcement' && p !== '/api/announce') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && !(p === '/api/announce' && request.method === 'POST')) {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405, headers: { 'Allow': p === '/api/announce' ? 'GET, HEAD, POST' : 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (p === '/api/announce' && request.method === 'POST') {
    const token = env && typeof env.SP_ADMIN_TOKEN === 'string' ? env.SP_ADMIN_TOKEN : '';
    const given = request.headers.get('Authorization') || '';
    if (!token || given !== `Bearer ${token}`) return json({ error: 'FORBIDDEN' }, 403);
    let doc;
    try { doc = await request.json(); } catch { return json({ error: 'BAD_REQUEST', detail: 'body must be JSON' }, 400); }
    try {
      const { entries, stored } = await writeAnnouncements(env, doc);
      // tell the game object to broadcast exactly what was published (KV reads are eventually consistent)
      const pushed = typeof push === 'function'
        ? await push(doc).catch((e) => { console.warn('[announce] push failed', e && e.message); return null; })
        : null;
      return json({ ok: true, count: entries.length, stored, subscribers: pushed ? pushed.subscribers : null });
    } catch (e) {
      return json({ error: 'BAD_REQUEST', detail: String(e && e.message || e) }, 400);
    }
  }

  // Reads are answered by the game object: it is the one place that knows about a document published a moment
  // ago (KV is eventually consistent), and it also holds the KV-less in-memory copy.
  const type = p === '/api/popup-announcement' ? 'popup' : 'scroll';
  if (typeof read === 'function') return read(type);
  const now = Date.now();
  const entries = await readAnnouncements(env);
  const live = liveAnnouncement(entries, type, now);
  if (!live) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  return json(announcementBody(live, now));
}
