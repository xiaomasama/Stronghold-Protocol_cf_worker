// cloudflare/src/req-shim.js — the slice of a node:http IncomingMessage that server/net.js reads.
//
// net.js resolves the client address from `req.socket.remoteAddress` and `req.headers` (clientAddress /
// forwardedAddress). Under workerd there is no peer socket and `headers` is a WHATWG Headers, whose bracket
// access net.js uses. This builds a plain-object stand-in:
//
//   * headers: { [lower-case name]: value } — cf-connecting-ip (or the value the edge Worker forwarded) is
//     present, so `TRUST_PROXY=auto` resolves the real client.
//   * socket.remoteAddress: '' — the request always arrives from Cloudflare's edge, i.e. "a local reverse
//     proxy" in net.js's terms, which is exactly the case its forwarding-header branch describes. An empty
//     peer keeps that branch and yields key: null for a local address, so per-network limits key on the
//     forwarded client address instead of on the edge.
//
// server/index.js used to build this same view from the real socket; nothing else of the request is read.

/** Header the edge Worker uses to pass the client address on (cf-connecting-ip may be dropped on the forward). */
export const REAL_IP_HEADER = 'x-sp-real-ip';

/**
 * @param {Request} request the (possibly forwarded) upgrade request
 * @returns {{ headers: Record<string, string>, socket: { remoteAddress: string }, method: string, url: string }}
 */
export function reqShim(request) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  const real = headers[REAL_IP_HEADER] || headers['cf-connecting-ip'] || headers['x-real-ip'] || '';
  delete headers[REAL_IP_HEADER];
  if (real) {
    // net.js checks cf-connecting-ip first; make the resolved address the one it sees.
    headers['cf-connecting-ip'] = real;
    delete headers['x-forwarded-for'];
  }
  return { headers, socket: { remoteAddress: '' }, method: request.method, url: request.url };
}
