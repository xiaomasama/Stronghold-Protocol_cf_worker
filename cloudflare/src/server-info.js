// cloudflare/src/server-info.js — the "关于本服务器" document of this deployment.
//
// Same storage story as the announcements (src/announce.js): the optional KV binding ANNOUNCE (key `server-info`),
// then the SP_SERVER_INFO var, then the repo's cloudflare/config/server-info.json baked in at build time. No
// document configured = the client leaves the checkout's own modal content alone.
//
//   GET  /api/server-info  → the document (200) or 204 when nothing is configured
//   POST /api/server-info  → replace it (Authorization: Bearer <SP_ADMIN_TOKEN>), then push it to open pages
//
// Document shape (see cloudflare/config/server-info.example.json):
//   { "title": "关于本服务器",
//     "intro": "一句话介绍",
//     "rows": [ { "label": "联系邮箱", "value": "you@example.com", "href": "mailto:you@example.com", "hint": "…" } ],
//     "disclaimer": ["第一段", "第二段"] }   // optional: replaces the legal block

const MAX_TEXT = 500;
const MAX_ROWS = 20;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (v, n = MAX_TEXT) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, n) : '');

/** An HTTP(S), mailto: or relative link the modal may use. */
export function validHref(value) {
  const s = clip(value, 2048);
  if (!s || /[\s\u0000-\u001f\u007f]/.test(s)) return false;
  if (s.startsWith('/') && !s.startsWith('//')) return true;
  try {
    const url = new URL(s);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Validate a whole document; throws a readable reason. */
export function parseServerInfo(doc) {
  if (!isObj(doc)) throw new Error('the document must be an object');
  const out = {};
  const title = clip(doc.title, 80);
  if (title) out.title = title;
  const intro = clip(doc.intro);
  if (intro) out.intro = intro;
  if (doc.rows !== undefined) {
    if (!Array.isArray(doc.rows)) throw new Error('rows must be an array');
    if (doc.rows.length > MAX_ROWS) throw new Error(`at most ${MAX_ROWS} rows`);
    out.rows = doc.rows.map((row, i) => {
      if (!isObj(row)) throw new Error(`rows[${i}] must be an object`);
      const label = clip(row.label, 40);
      const value = clip(row.value, 200);
      if (!label || !value) throw new Error(`rows[${i}] needs label and value`);
      const entry = { label, value };
      if (row.href !== undefined && row.href !== '') {
        if (!validHref(row.href)) throw new Error(`rows[${i}].href must be an http(s), mailto: or /path link`);
        entry.href = clip(row.href, 2048);
      }
      const hint = clip(row.hint, 300);
      if (hint) entry.hint = hint;
      return entry;
    });
  }
  if (doc.disclaimer !== undefined && doc.disclaimer !== null) {
    if (!Array.isArray(doc.disclaimer)) throw new Error('disclaimer must be an array of paragraphs');
    if (doc.disclaimer.length > 12) throw new Error('at most 12 disclaimer paragraphs');
    out.disclaimer = doc.disclaimer.map((p) => clip(p, 2000));
  }
  if (!out.title && !out.intro && !out.rows && !out.disclaimer) throw new Error('the document is empty');
  return out;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** The configured document, or null. Never throws: a broken document means "not configured". */
export async function readServerInfo(env, log = console) {
  let raw = null;
  try {
    if (env && env.ANNOUNCE && typeof env.ANNOUNCE.get === 'function') raw = await env.ANNOUNCE.get('server-info');
  } catch (e) {
    log.warn?.('[server-info] KV read failed', e && e.message);
  }
  if (raw == null && env && typeof env.SP_SERVER_INFO === 'string' && env.SP_SERVER_INFO.trim()) raw = env.SP_SERVER_INFO;
  if (raw == null) {
    try {
      const { DEFAULT_SERVER_INFO } = await import('./server-info-config.generated.js');
      if (DEFAULT_SERVER_INFO) raw = DEFAULT_SERVER_INFO;
    } catch { /* older build without the module */ }
  }
  if (raw == null || raw === '') return null;
  try { return parseServerInfo(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch (e) {
    log.warn?.('[server-info] ignoring an invalid document:', e && e.message);
    return null;
  }
}

/** Store a document: KV when bound, otherwise refused with a hint. */
export async function writeServerInfo(env, doc) {
  const parsed = parseServerInfo(doc); // throws with a readable reason
  if (!env || !env.ANNOUNCE || typeof env.ANNOUNCE.put !== 'function') {
    throw new Error('no KV binding ANNOUNCE — create it with npm run kv:create, or set the SP_SERVER_INFO var and redeploy');
  }
  await env.ANNOUNCE.put('server-info', JSON.stringify(parsed));
  return parsed;
}

/**
 * GET /api/server-info (200 with the document, 204 without) and POST /api/server-info (admin token).
 * @returns {Promise<Response | null>} null when the path is not this endpoint
 */
export async function serveServerInfoApi(request, env, url, push) {
  if (url.pathname !== '/api/server-info') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), {
      status: 405, headers: { 'Allow': 'GET, HEAD, POST', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (request.method === 'POST') {
    const token = env && typeof env.SP_ADMIN_TOKEN === 'string' ? env.SP_ADMIN_TOKEN : '';
    if (!token || (request.headers.get('Authorization') || '') !== `Bearer ${token}`) return json({ error: 'FORBIDDEN' }, 403);
    let doc;
    try { doc = await request.json(); } catch { return json({ error: 'BAD_REQUEST', detail: 'body must be JSON' }, 400); }
    try {
      const parsed = await writeServerInfo(env, doc);
      if (typeof push === 'function') await push().catch(() => null); // tell open pages to re-read it
      return json({ ok: true, rows: (parsed.rows || []).length });
    } catch (e) {
      return json({ error: 'BAD_REQUEST', detail: String(e && e.message || e) }, 400);
    }
  }
  const info = await readServerInfo(env);
  if (!info) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  return json(info);
}
