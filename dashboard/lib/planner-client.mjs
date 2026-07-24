// lib/planner-client.mjs — the one path every request to the planner goes
// through (§3.4, §5.1, §7.6): fixed bearer + built-from-scratch headers, a
// 2s micro-cache (5s for /healthz) with single-flight coalescing on GETs, a
// concurrency cap (~6) shared by reads and mutations alike, and a 30s
// per-call timeout. Never throws upward — network-level failure normalizes
// to `{transportOk: false}` so callers can map it to a generic 502 without
// ever touching a raw Error's message (which could carry a hostname/stack).

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_CACHE_TTL_MS = 2_000;
const DEFAULT_HEALTHZ_CACHE_TTL_MS = 5_000;

export function createPlannerClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  now = () => Date.now(),
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  healthzCacheTtlMs = DEFAULT_HEALTHZ_CACHE_TTL_MS,
} = {}) {
  if (!baseUrl) throw new Error('createPlannerClient requires baseUrl');
  if (!token) throw new Error('createPlannerClient requires token');

  // -- concurrency gate: a plain counting semaphore + FIFO wait queue -------
  let inFlight = 0;
  const waiters = [];
  function acquire() {
    if (inFlight < concurrency) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) {
      inFlight += 1;
      next();
    }
  }

  // Every hop's headers are built FROM SCRATCH (§5.2) — never anything
  // spread in from the inbound browser request.
  async function rawRequest(path, opts = {}) {
    await acquire();
    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method: opts.method || 'GET',
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { transportOk: false };
      }
      let body;
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      return { transportOk: true, status: res.status, body };
    } finally {
      release();
    }
  }

  // -- 2s micro-cache + single-flight coalescing (GET only) ----------------
  // Deliberately NOT an async function: the whole body below runs
  // synchronously (no `await`), so two back-to-back calls for the same path
  // in the same tick are guaranteed to see the cache populated by the first
  // call before the second one runs — that synchronousness IS the
  // single-flight guarantee, not an accident of scheduling.
  const cache = new Map(); // key -> { expiresAt, promise }
  function get(path, { cacheTtl } = {}) {
    const key = `GET ${path}`;
    const ttl = cacheTtl ?? (path === '/healthz' ? healthzCacheTtlMs : cacheTtlMs);
    const cached = cache.get(key);
    const t = now();
    if (cached && cached.expiresAt > t) return cached.promise;
    const promise = rawRequest(path, { method: 'GET' });
    cache.set(key, { expiresAt: t + ttl, promise });
    // A transport-level failure must not poison the cache for the full TTL —
    // evict immediately so the very next poll retries instead of parroting
    // a stale failure for up to `ttl` more milliseconds.
    promise.then((result) => {
      if (!result.transportOk) cache.delete(key);
    });
    return promise;
  }

  // A plan mutation invalidates that plan's detail entry plus every
  // list/summary entry (blunt but safe — a handful of extra cache misses,
  // never staleness). Mutations themselves are never cached.
  function invalidate(planId) {
    for (const key of cache.keys()) {
      if ((planId && key.includes(`/plan/${planId}`)) || key.startsWith('GET /plans')) {
        cache.delete(key);
      }
    }
  }

  async function post(path, body, { planId } = {}) {
    const result = await rawRequest(path, { method: 'POST', body });
    invalidate(planId);
    return result;
  }

  return {
    get,
    post,
    invalidate,
    _debug: { cacheSize: () => cache.size, inFlight: () => inFlight },
  };
}

// Maps a planner-client result to the HTTP response the BFF sends the
// browser. A real upstream HTTP response (any status) is passed through
// verbatim — the planner's own error bodies are already the documented
// human-safe surface (errMsg() strips absolute paths server-side). Only a
// hard transport failure (unreachable/timeout/non-JSON) collapses to a
// generic 502 — never a raw Error message, hostname, or stack.
export function toHttpOutcome(result, requestId) {
  if (!result.transportOk) {
    return { status: 502, body: { error: 'planner unavailable', request_id: requestId } };
  }
  return { status: result.status, body: result.body };
}
