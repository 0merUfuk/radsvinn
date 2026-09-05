// plans-summary.test.mjs — §6.3: GET /plans/summary, a separate whole-store
// aggregate endpoint (deliberately not riding GET /plans' paginated fetch).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';

const ALL_STATUSES = [
  'breaking_down', 'shape_ready', 'grooming', 'plan_ready', 'creating',
  'created', 'rejected', 'failed', 'budget_blocked', 'cancelling', 'cancelled',
];

test('GET /plans/summary: all eleven statuses are present and zero-filled on a fresh store', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const summary = await getJson(ctx.baseUrl, '/plans/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.total, 0);
  assert.deepEqual(Object.keys(summary.body.counts).sort(), [...ALL_STATUSES].sort());
  for (const status of ALL_STATUSES) {
    assert.equal(summary.body.counts[status], 0, `${status} must be zero-filled, not absent`);
  }
});

test('GET /plans/summary: counts move across a fake-engine lifecycle (breaking_down -> shape_ready -> rejected)', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const afterCreate = await getJson(ctx.baseUrl, '/plans/summary');
  assert.equal(afterCreate.body.total, 1);
  assert.equal(afterCreate.body.counts.breaking_down, 1);
  assert.equal(afterCreate.body.counts.shape_ready, 0);

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  const afterShape = await getJson(ctx.baseUrl, '/plans/summary');
  assert.equal(afterShape.body.total, 1, 'total is a store-wide count, not per-status — must stay 1');
  assert.equal(afterShape.body.counts.breaking_down, 0, 'the plan left breaking_down');
  assert.equal(afterShape.body.counts.shape_ready, 1);

  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'no' });
  assert.equal(rejected.status, 200);
  const afterReject = await getJson(ctx.baseUrl, '/plans/summary');
  assert.equal(afterReject.body.counts.shape_ready, 0);
  assert.equal(afterReject.body.counts.rejected, 1);
});

test('GET /plans/summary requires the bearer like every other non-healthz route', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SERVICE_TOKEN: 'sekret-summary' });
  t.after(() => ctx.close());

  const noAuth = await getJson(ctx.baseUrl, '/plans/summary');
  assert.equal(noAuth.status, 401);

  const withAuth = await getJson(ctx.baseUrl, '/plans/summary', { Authorization: 'Bearer sekret-summary' });
  assert.equal(withAuth.status, 200);
});
