// lib/http-helpers.mjs — small node:http primitives shared by the router:
// JSON body reading with a size cap, JSON responses, cookie parse/serialize,
// and the rightmost-trusted-hop client-IP extraction (§3.4).
//
// Zero runtime dependencies by design.

export const MAX_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.code = 'TOO_LARGE';
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super('invalid JSON body');
    this.code = 'INVALID_JSON';
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!rejected) {
          rejected = true;
          req.pause();
          reject(new BodyTooLargeError());
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (rejected) return;
      rejected = true;
      reject(err);
    });
  });
}

// Reads and parses a JSON body, tolerantly: an empty body is `{}` (mirrors
// the planner's handleRetry contract — POSTs with no body are legal on every
// mutation route here too). Throws BodyTooLargeError / InvalidJsonError,
// which callers map to 413 / 400 respectively.
export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new InvalidJsonError();
  }
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body === undefined ? {} : body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendRedirect(res, status, location, extraHeaders = {}) {
  res.writeHead(status, { Location: location, 'Content-Length': 0, ...extraHeaders });
  res.end();
}

// ---------------------------------------------------------------------------
// Cookies — hand-rolled (no `cookie` package; formats are tiny and fixed).

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

// `__Host-` cookies (used for both the pre-auth state cookie and the session
// cookie, §3.1/§3.2) REQUIRE Secure + Path=/ + no Domain attribute — that's
// what makes the prefix meaningful, so this helper never accepts a `domain`
// option and always sets Secure when the name carries the prefix.
export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const isHostPrefixed = name.startsWith('__Host-');
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) {
    if (opts.maxAge <= 0) {
      parts.push('Max-Age=0');
      parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    } else {
      parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    }
  }
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (isHostPrefixed || opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Client IP — §3.4 rightmost-trusted-hop discipline.
//
// Railway's edge proxy appends the connection's observed peer IP as the LAST
// entry of X-Forwarded-For; anything a client sends arrives to its LEFT. A
// spoofed/rotating client-supplied XFF can only ever influence the leftmost
// entries, never the rightmost one Railway itself appends — so trusting only
// the last entry (falling back to the raw socket address when the header is
// absent) is exactly the discipline that resists bucket-eviction-by-spoofing.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function id8(planId) {
  return String(planId || '').slice(0, 8);
}
