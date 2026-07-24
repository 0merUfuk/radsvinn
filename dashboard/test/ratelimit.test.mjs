import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter, LIMITS } from '../lib/ratelimit.mjs';

describe('lib/ratelimit', () => {
  test('allows up to capacity, then rejects', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    for (let i = 0; i < 5; i += 1) {
      const r = rl.take('k', { capacity: 5, windowMs: 60_000 });
      assert.equal(r.allowed, true, `attempt ${i} should be allowed`);
    }
    const over = rl.take('k', { capacity: 5, windowMs: 60_000 });
    assert.equal(over.allowed, false);
  });

  test('refills continuously over the window', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    for (let i = 0; i < 5; i += 1) rl.take('k', { capacity: 5, windowMs: 60_000 });
    assert.equal(rl.take('k', { capacity: 5, windowMs: 60_000 }).allowed, false);
    clock += 60_000; // a full window later, fully refilled
    assert.equal(rl.take('k', { capacity: 5, windowMs: 60_000 }).allowed, true);
  });

  test('partial refill after a partial window', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    rl.take('k', { capacity: 10, windowMs: 10_000 }); // 9 left, updatedAt=0
    clock += 5_000; // half the window -> +5 tokens (9+5=14, capped at 10) at the next take()
    for (let i = 0; i < 10; i += 1) {
      assert.equal(rl.take('k', { capacity: 10, windowMs: 10_000 }).allowed, true, `refill attempt ${i}`);
    }
    assert.equal(rl.take('k', { capacity: 10, windowMs: 10_000 }).allowed, false);
  });

  test('cost > 1 debits multiple tokens per call (the CSRF double-charge mechanism)', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    const first = rl.take('k', { capacity: 4, windowMs: 60_000, cost: 2 });
    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 2);
    rl.take('k', { capacity: 4, windowMs: 60_000, cost: 2 });
    const third = rl.take('k', { capacity: 4, windowMs: 60_000, cost: 2 });
    assert.equal(third.allowed, false);
  });

  test('separate keys have independent buckets', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    for (let i = 0; i < 3; i += 1) rl.take('a', { capacity: 3, windowMs: 60_000 });
    assert.equal(rl.take('a', { capacity: 3, windowMs: 60_000 }).allowed, false);
    assert.equal(rl.take('b', { capacity: 3, windowMs: 60_000 }).allowed, true, 'a different key must not share a bucket');
  });

  test('sweep removes buckets idle past the threshold', () => {
    let clock = 0;
    const rl = createRateLimiter({ now: () => clock });
    rl.take('a', { capacity: 3, windowMs: 60_000 });
    clock += 100;
    rl.take('b', { capacity: 3, windowMs: 60_000 });
    clock += 1000;
    const removed = rl.sweep(500); // 'a' idle 1100ms, 'b' idle 1000ms -> both removed at threshold 500
    assert.equal(removed, 2);
    assert.equal(rl.size(), 0);
  });

  test('LIMITS table matches the documented dashboard rate-limit policy', () => {
    assert.deepEqual(LIMITS.authRoute, { capacity: 10, windowMs: 60_000 });
    assert.deepEqual(LIMITS.unknownSession, { capacity: 30, windowMs: 60_000 });
    assert.deepEqual(LIMITS.createPlan, { capacity: 5, windowMs: 60_000 });
    assert.deepEqual(LIMITS.mutationPerSession, { capacity: 20, windowMs: 60_000 });
    assert.deepEqual(LIMITS.mutationPerIp, { capacity: 60, windowMs: 60_000 });
    assert.deepEqual(LIMITS.reads, { capacity: 240, windowMs: 60_000 });
  });
});
