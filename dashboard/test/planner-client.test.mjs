import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPlannerClient, toHttpOutcome } from '../lib/planner-client.mjs';

// A controllable fake fetch: records calls, resolves deferred until the test
// says so (so concurrency/coalescing can be observed mid-flight), and can be
// told to reject (simulating a transport failure) or return arbitrary JSON.
function makeFakeFetch() {
  const calls = [];
  const pending = [];
  let mode = 'auto'; // 'auto' resolves immediately; 'manual' queues resolvers
  let nextResponse = () => ({ status: 200, json: async () => ({ ok: true }) });
  let shouldThrow = false;

  async function fetchImpl(url, opts) {
    calls.push({ url, opts });
    if (shouldThrow) throw new Error('simulated network failure');
    if (mode === 'manual') {
      return new Promise((resolve) => pending.push(() => resolve(nextResponse())));
    }
    return nextResponse();
  }

  return {
    fetchImpl,
    calls,
    setManual() { mode = 'manual'; },
    resolveOne() { const r = pending.shift(); if (r) r(); },
    resolveAll() { while (pending.length) pending.shift()(); },
    pendingCount: () => pending.length,
    setNextResponse(fn) { nextResponse = fn; },
    setThrows(v) { shouldThrow = v; },
  };
}

describe('lib/planner-client micro-cache + single-flight', () => {
  test('two concurrent GETs for the same path in the same tick coalesce into one upstream call', async () => {
    const fake = makeFakeFetch();
    const client = createPlannerClient({ baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl });

    const [a, b] = await Promise.all([client.get('/plans'), client.get('/plans')]);
    assert.equal(fake.calls.length, 1, 'only one upstream request for two coalesced GETs');
    assert.deepEqual(a, b);
  });

  test('a second GET within the TTL reuses the cached result without a new upstream call', async () => {
    let clock = 0;
    const fake = makeFakeFetch();
    const client = createPlannerClient({
      baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, now: () => clock, cacheTtlMs: 2000,
    });
    await client.get('/plans');
    clock += 1000; // still within the 2s window
    await client.get('/plans');
    assert.equal(fake.calls.length, 1);
  });

  test('a GET after the TTL expires issues a fresh upstream call', async () => {
    let clock = 0;
    const fake = makeFakeFetch();
    const client = createPlannerClient({
      baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, now: () => clock, cacheTtlMs: 2000,
    });
    await client.get('/plans');
    clock += 2001;
    await client.get('/plans');
    assert.equal(fake.calls.length, 2);
  });

  test('/healthz gets its own (longer) cache TTL', async () => {
    let clock = 0;
    const fake = makeFakeFetch();
    const client = createPlannerClient({
      baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, now: () => clock,
      cacheTtlMs: 2000, healthzCacheTtlMs: 5000,
    });
    await client.get('/healthz');
    clock += 4000; // past the generic 2s TTL but under healthz's 5s
    await client.get('/healthz');
    assert.equal(fake.calls.length, 1);
  });

  test('different paths never share a cache entry', async () => {
    const fake = makeFakeFetch();
    const client = createPlannerClient({ baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl });
    await client.get('/plans');
    await client.get('/plans/summary');
    assert.equal(fake.calls.length, 2);
  });

  test('a transport failure is not cached — the very next call retries instead of repeating the failure', async () => {
    const fake = makeFakeFetch();
    fake.setThrows(true);
    const client = createPlannerClient({ baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, cacheTtlMs: 60_000 });
    const first = await client.get('/plans');
    assert.equal(first.transportOk, false);
    fake.setThrows(false);
    const second = await client.get('/plans');
    assert.equal(second.transportOk, true);
    assert.equal(fake.calls.length, 2, 'the failed attempt must not poison the cache for the full TTL');
  });

  test('POST is never cached and invalidates the plan detail + list/summary entries', async () => {
    const fake = makeFakeFetch();
    const client = createPlannerClient({ baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, cacheTtlMs: 60_000 });
    await client.get('/plan/abc');
    await client.get('/plans');
    await client.get('/plans/summary');
    assert.equal(client._debug.cacheSize(), 3);

    await client.post('/plan/abc/reject', { reason: 'x' }, { planId: 'abc' });
    assert.equal(client._debug.cacheSize(), 0, 'the mutation must invalidate the plan detail + every list/summary entry');

    // Two POSTs to the same path are never coalesced/cached — each is a real call.
    await client.post('/plan/abc/reject', { reason: 'y' }, { planId: 'abc' });
    const postCalls = fake.calls.filter((c) => c.opts.method === 'POST');
    assert.equal(postCalls.length, 2);
  });

  test('builds the Authorization header from the configured token, never from anything inbound', async () => {
    const fake = makeFakeFetch();
    const client = createPlannerClient({ baseUrl: 'http://planner.invalid', token: 'dashboard-secret', fetchImpl: fake.fetchImpl });
    await client.get('/plans');
    assert.equal(fake.calls[0].opts.headers.Authorization, 'Bearer dashboard-secret');
    assert.equal(fake.calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(Object.keys(fake.calls[0].opts.headers).length, 2, 'no stray headers are forwarded from anywhere');
  });
});

describe('lib/planner-client concurrency cap', () => {
  test('never issues more than `concurrency` requests to the planner at once', async () => {
    const fake = makeFakeFetch();
    fake.setManual();
    const client = createPlannerClient({
      baseUrl: 'http://planner.invalid', token: 't', fetchImpl: fake.fetchImpl, concurrency: 2, cacheTtlMs: 0,
    });

    // Five DIFFERENT paths so none of this is single-flight-coalesced —
    // this is purely testing the concurrency semaphore.
    const promises = [0, 1, 2, 3, 4].map((i) => client.get(`/plan/${i}`));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.calls.length, 2, 'only 2 in flight at a time when concurrency=2');

    fake.resolveOne();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.calls.length, 3, 'releasing one slot admits exactly one more');

    // Draining the remaining 2 in-flight requests admits new ones from the
    // wait queue in turn (concurrency=2, 5 total) — each resolveAll() pass
    // only resolves what's CURRENTLY pending; a newly-admitted request's own
    // fetchImpl call queues its own resolver afterwards (as a cascaded
    // microtask), so a single resolveAll() + Promise.all leaves those later
    // admissions unresolved and hangs forever. Loop resolve+yield until
    // nothing is left pending.
    for (let i = 0; i < 10 && (fake.calls.length < 5 || fake.pendingCount() > 0); i += 1) {
      fake.resolveAll();
      // eslint-disable-next-line no-await-in-loop -- draining is inherently sequential
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fake.pendingCount(), 0, 'every cascaded admission must have been resolved before awaiting');
    await Promise.all(promises);
    assert.equal(fake.calls.length, 5, 'all five eventually go through');
  });
});

describe('lib/planner-client toHttpOutcome', () => {
  test('passes through a real upstream response verbatim (any status)', () => {
    const outcome = toHttpOutcome({ transportOk: true, status: 409, body: { error: 'illegal transition', status: 'created' } }, 'req-1');
    assert.deepEqual(outcome, { status: 409, body: { error: 'illegal transition', status: 'created' } });
  });

  test('maps a transport failure to a generic 502 with a BFF-generated request id — never a raw error message', () => {
    const outcome = toHttpOutcome({ transportOk: false }, 'req-2');
    assert.equal(outcome.status, 502);
    assert.deepEqual(outcome.body, { error: 'planner unavailable', request_id: 'req-2' });
  });
});
