// cloudflare/src/ws-shim.js — a `ws`-compatible facade over the server end of a workerd WebSocketPair.
//
// server/net.js (untouched) uses only a small part of the `ws` WebSocket: readyState, bufferedAmount,
// send(data, cb), close(code, reason), terminate(), ping() and the 'message' / 'pong' / 'error' / 'close'
// events. workerd's WebSocket has the transport and the events, but none of the Node side: no `on()`, no
// ping/pong API, no `terminate()`. This class adapts them, so Network/Lobby/Match stay byte-identical.
//
// Two deliberate translations:
//   * ping() → a 'pong' emitted on the microtask queue. net.js marks a socket dead when a heartbeat's ping
//     is unanswered (server/net.js Network.heartbeat). workerd cannot send protocol pings from script and
//     does not surface pongs; it *does* fire 'close' itself when the peer vanishes. Reporting the pong keeps
//     the heartbeat from terminating live sockets that the runtime is already watching.
//   * close(code, reason) → the WHATWG rule (1000 or 3000–4999) may reject reserved codes like 1001/1008/1009
//     that the server sends. Try the original code first; on rejection fall back to 4100 + (code - 1000),
//     which the browser client treats exactly like the original (public/js/net.js only special-cases 4001 and
//     4002, both custom codes it receives verbatim).
//
// The 64 KB inbound frame cap (`new WebSocketServer({ maxPayload })` in server/index.js) is enforced here:
// workerd hands over complete messages of up to 32 MiB, `ws` used to close the socket at the cap.

/** Inbound frame cap, mirroring server/index.js WS_MAX_PAYLOAD. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** Reserved code → custom code the platform's close() accepts (see the header). */
const fallbackCode = (code) => (Number.isInteger(code) && code >= 1000 && code <= 2999 ? 4100 + (code - 1000) : 4000);

/** UTF-8 byte length of a string (only called near the cap; see Frame). */
function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** The Buffer-shaped view net.js expects of an inbound frame: `.length` (bytes) and `.toString('utf8')`. */
class Frame {
  /** @param {string | ArrayBuffer} raw @param {number} maxPayload */
  constructor(raw, maxPayload) {
    this._raw = raw;
    this._text = typeof raw === 'string' ? raw : null;
    this._bytes = typeof raw === 'string'
      ? (raw.length > maxPayload ? raw.length : raw.length * 4 <= maxPayload ? raw.length : utf8Length(raw))
      : (raw instanceof ArrayBuffer ? raw.byteLength : 0);
  }
  get length() { return this._bytes; }
  toString() {
    if (this._text === null) {
      try { this._text = new TextDecoder().decode(this._raw); } catch { this._text = ''; }
    }
    return this._text;
  }
}

export class WsShim {
  /**
   * @param {WebSocket} server the DO-side end of a WebSocketPair
   * @param {{ maxPayload?: number, onFrame?: (data: Frame, isBinary: boolean) => void }} [opts]
   */
  constructor(server, { maxPayload = MAX_PAYLOAD_BYTES } = {}) {
    this._ws = server;
    this._maxPayload = maxPayload;
    /** @type {Map<string, Function[]>} */
    this._listeners = new Map();
    /** ws's readyState (net.js only ever compares against OPEN) */
    this.readyState = WS_OPEN;
    /** ws's send-queue size; workerd buffers internally and reports nothing, and the 16 MB guard is unreachable here */
    this.bufferedAmount = 0;
    this._closeSent = false;
    server.addEventListener('message', (ev) => {
      const raw = ev.data;
      const data = new Frame(raw, this._maxPayload);
      if (data.length > this._maxPayload) {
        // ws closed the connection with 1009 on an over-long frame, without delivering it.
        this.close(1009, 'Max payload size exceeded');
        return;
      }
      this._emit('message', data, typeof raw !== 'string');
    });
    server.addEventListener('close', () => { this.readyState = WS_CLOSED; this._emit('close'); });
    server.addEventListener('error', (ev) => { this._emit('error', ev); });
  }

  /** @param {'message' | 'pong' | 'error' | 'close'} event @param {Function} fn */
  on(event, fn) {
    const list = this._listeners.get(event);
    if (list) list.push(fn); else this._listeners.set(event, [fn]);
    return this;
  }

  _emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list) return;
    for (const fn of list) { try { fn(...args); } catch { /* a listener never breaks the socket */ } }
  }

  /**
   * Queue a text or binary frame. Mirrors ws: the callback runs once the frame is handed to the transport.
   * @param {string | ArrayBuffer | ArrayBufferView} data @param {(err?: Error) => void} [cb]
   */
  send(data, cb) {
    if (this.readyState !== WS_OPEN) { if (cb) cb(new Error('socket is not open')); return false; }
    try {
      this._ws.send(data);
      if (cb) cb();
      return true;
    } catch (e) {
      if (cb) cb(e instanceof Error ? e : new Error('send failed'));
      return false;
    }
  }

  /** Server-initiated close; a rejected reserved code falls back to its custom equivalent (see the header). */
  close(code, reason) {
    if (this._closeSent) return;
    this._closeSent = true;
    this.readyState = WS_CLOSING;
    const wanted = Number.isInteger(code) ? code : 1000;
    try { this._ws.close(wanted, reason); return; } catch { /* reserved code for close() — try the fallback */ }
    try { this._ws.close(fallbackCode(wanted), reason); } catch { /* ignore */ }
  }

  /** ws's abrupt drop. The close handshake is the only lever here, and the client reconnects on it all the same. */
  terminate() {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._closeSent = true;
    try { this._ws.close(1011, 'terminated'); return; } catch { /* ignore */ }
    try { this._ws.close(4111, 'terminated'); } catch { /* ignore */ }
  }

  /** Reported as an immediate pong — see the header. */
  ping() {
    queueMicrotask(() => { if (this.readyState === WS_OPEN) this._emit('pong'); });
  }
}

export { WS_OPEN, WS_CLOSING, WS_CLOSED };
