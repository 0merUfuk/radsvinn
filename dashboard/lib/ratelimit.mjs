// lib/ratelimit.mjs — in-memory token buckets (§3.4). Reset on redeploy is
// explicitly acceptable (single-instance-by-contract, same as sessions).

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();

  // capacity tokens, refilling continuously at capacity/windowMs per ms.
  // `cost` lets CSRF/Origin failures count double (§3.4's trip-wire rule)
  // without a second bucket implementation.
  function take(key, { capacity, windowMs, cost = 1 }) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: t };
      buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, t - bucket.updatedAt);
      const refill = (elapsed / windowMs) * capacity;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.updatedAt = t;
    }
    if (bucket.tokens < cost) {
      return { allowed: false, remaining: Math.max(0, Math.floor(bucket.tokens)) };
    }
    bucket.tokens -= cost;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }

  function sweep(maxIdleMs) {
    const t = now();
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (t - bucket.updatedAt > maxIdleMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return { take, sweep, size: () => buckets.size };
}

// §3.4's table, centralized so server.mjs and tests share one source of
// truth for the numbers.
export const LIMITS = Object.freeze({
  authRoute: { capacity: 10, windowMs: 60_000 }, // /auth/login + /auth/callback, per IP
  unknownSession: { capacity: 30, windowMs: 60_000 }, // invalid/unknown cookie, per IP
  createPlan: { capacity: 5, windowMs: 60_000 }, // POST /api/plans, per session
  mutationPerSession: { capacity: 20, windowMs: 60_000 },
  mutationPerIp: { capacity: 60, windowMs: 60_000 },
  reads: { capacity: 240, windowMs: 60_000 }, // per session
});
