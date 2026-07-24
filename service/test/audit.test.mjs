// audit.test.mjs — §5.3/§6.4: the append-only actor-audit ledger, written
// by the planner on every mutating route. Exercises the spec'd test plan
// for this surface (§6.6): one line per mutation across all six documented
// actions, the request_id echo, actor validation (required on the
// dashboard token, optional-and-null on every other client, malformed/
// oversize always 400), a denied 409 audited, append-failure isolation (an
// unwritable audit dir never blocks the mutation), and `surface` writes
// producing no line at all.
//
// Reads the ledger directly via audit.mjs's readAudit rather than
// GET /audit's HTTP surface — the query semantics of that endpoint itself
// (cursor walk, newest-first, torn-line tolerance, bearer) are
// audit-read.test.mjs's job; this file is about WHAT gets written and WHEN.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { readAudit } from '../audit.mjs';

function auditFor(resultsDir, planId) {
  return readAudit(resultsDir, { planId, limit: 500 }).records;
}

test('audit: one JSONL line per mutation across all six documented actions; the HTTP response\'s request_id matches the ledger line', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // Plan A: submit -> approve-shape -> create -> created -> cancel -> cancelled.
  const createdA = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(createdA.status, 202);
  const planA = createdA.body.plan_id;
  assert.ok(createdA.body.request_id, 'POST /plan must echo request_id additively');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planA}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  const approvedA = await postJson(ctx.baseUrl, `/plan/${planA}/approve-shape`, {});
  assert.equal(approvedA.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planA}`), (r) => r.body.status === 'plan_ready');
  const createdTreeA = await postJson(ctx.baseUrl, `/plan/${planA}/create`, {});
  assert.equal(createdTreeA.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planA}`), (r) => r.body.status === 'created');
  const cancelA = await postJson(ctx.baseUrl, `/plan/${planA}/cancel`, {});
  assert.equal(cancelA.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planA}`), (r) => r.body.status === 'cancelled');

  const recordsA = auditFor(ctx.resultsDir, planA);
  const byAction = Object.fromEntries(recordsA.map((r) => [r.action, r]));
  assert.deepEqual(
    new Set(Object.keys(byAction)),
    new Set(['plan.submit', 'plan.approve_shape', 'plan.create_tree', 'plan.cancel']),
    "exactly these four actions for plan A's lifecycle — no more, no fewer",
  );

  assert.equal(byAction['plan.submit'].prior_status, null);
  assert.equal(byAction['plan.submit'].result.http, 202);
  assert.equal(byAction['plan.submit'].request_id, createdA.body.request_id, "the HTTP response's request_id must be the SAME id as the ledger line — the join key back to this record");

  assert.equal(byAction['plan.approve_shape'].prior_status, 'shape_ready');
  assert.equal(byAction['plan.approve_shape'].result.to_status, 'grooming');
  assert.equal(byAction['plan.approve_shape'].result.edited, false);
  assert.equal(byAction['plan.approve_shape'].request_id, approvedA.body.request_id);

  assert.equal(byAction['plan.create_tree'].prior_status, 'plan_ready');
  assert.equal(byAction['plan.create_tree'].result.to_status, 'creating');
  assert.equal(byAction['plan.create_tree'].request_id, createdTreeA.body.request_id);

  assert.equal(byAction['plan.cancel'].prior_status, 'created');
  assert.equal(byAction['plan.cancel'].result.to_status, 'cancelling');
  assert.equal(byAction['plan.cancel'].request_id, cancelA.body.request_id);

  // Plan B: submit -> reject (the reason/stage must be readable in the
  // ledger — §5.3, not just decorative).
  const createdB = await postJson(ctx.baseUrl, '/plan', { description: 'y'.repeat(50), requester: 'test-requester' });
  const planB = createdB.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planB}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  const rejectB = await postJson(ctx.baseUrl, `/plan/${planB}/reject`, { reason: 'no thanks' });
  assert.equal(rejectB.status, 200);

  const recordsB = auditFor(ctx.resultsDir, planB);
  const rejectRecord = recordsB.find((r) => r.action === 'plan.reject');
  assert.ok(rejectRecord, 'plan.reject must be audited');
  assert.equal(rejectRecord.result.reason, 'no thanks');
  assert.equal(rejectRecord.result.stage, 'shape_ready', 'stage defaults to the status rejected FROM when omitted');
  assert.equal(rejectRecord.request_id, rejectB.body.request_id);

  // A denied 409 (approve-shape on an already-rejected plan) must ALSO be
  // audited — a double-fired action is exactly what the ledger must show.
  const deniedB = await postJson(ctx.baseUrl, `/plan/${planB}/approve-shape`, {});
  assert.equal(deniedB.status, 409);
  const recordsB2 = auditFor(ctx.resultsDir, planB);
  const deniedRecord = recordsB2.find((r) => r.action === 'plan.approve_shape' && r.result.http === 409);
  assert.ok(deniedRecord, 'a denied 409 must be audited, not silently dropped');
  assert.equal(deniedRecord.result.error, 'illegal transition');
  assert.equal(deniedRecord.request_id, deniedB.body.request_id);

  // POST /plan/{id}/surface must NEVER be audited — client-owned delivery
  // metadata, no state consequence, deliberately excluded (§5.3).
  const beforeSurfaceCount = auditFor(ctx.resultsDir, planA).length;
  const surfaceRes = await postJson(ctx.baseUrl, `/plan/${planA}/surface`, { surface: { type: 'test', channel: 'C1' } });
  assert.equal(surfaceRes.status, 200);
  const afterSurfaceCount = auditFor(ctx.resultsDir, planA).length;
  assert.equal(afterSurfaceCount, beforeSurfaceCount, 'surface writes must add ZERO audit lines');
});

test('audit: plan.retry is audited (after a groom failure + recovery)', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1', MERCURY_FAKE_GROOM_FAIL: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  const failed = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(failed.body.status, 'failed');

  process.env.MERCURY_FAKE_GROOM_FAIL = '0'; // "balance topped up" — ctx.close() restores it
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');

  const records = auditFor(ctx.resultsDir, planId);
  const retryRecord = records.find((r) => r.action === 'plan.retry');
  assert.ok(retryRecord, 'plan.retry must be audited');
  assert.equal(retryRecord.prior_status, 'failed');
  assert.equal(retryRecord.result.to_status, 'grooming');
  assert.equal(retryRecord.request_id, retry.body.request_id);
});

test('audit: actor required on the dashboard token (400 without one), optional and recorded null on the bridge token', async (t) => {
  const ctx = await startTestServer({
    MERCURY_SKIP_PLAN_ANCHORS: '1',
    MERCURY_SERVICE_TOKEN: 'bridge-secret',
    MERCURY_SERVICE_TOKEN_DASHBOARD: 'dashboard-secret',
  });
  t.after(() => ctx.close());

  const bridgeHeaders = { Authorization: 'Bearer bridge-secret' };
  const dashboardHeaders = { Authorization: 'Bearer dashboard-secret' };

  // Bridge token, no actor: accepted, recorded null.
  const bridgePlan = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' }, bridgeHeaders);
  assert.equal(bridgePlan.status, 202, 'actor stays OPTIONAL on the bridge token');
  const bridgeRecords = auditFor(ctx.resultsDir, bridgePlan.body.plan_id);
  assert.equal(bridgeRecords[0].actor, null, 'an omitted actor is recorded as null, never fabricated');

  // Dashboard token, no actor: 400. POST /plan collects field errors into
  // `details[]` under a generic top-level `error: 'validation failed'`
  // (unlike the other five mutating routes, which return the actor error
  // directly on `error` — see the other actor-400 assertions in this file).
  const dashNoActor = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' }, dashboardHeaders);
  assert.equal(dashNoActor.status, 400, 'a lazily-compromised BFF cannot mint anonymous mutations');
  assert.ok(dashNoActor.body.details.some((d) => /actor is required/.test(d)));

  // Dashboard token, well-formed actor: accepted and recorded verbatim
  // (minus any unrecognized fields — never a raw pass-through).
  const goodActor = {
    source: 'dashboard', id: 'gh:example-user', github_id: 123, display: 'Test Requester', roles: ['viewer', 'creator'],
  };
  const dashGood = await postJson(
    ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: goodActor }, dashboardHeaders,
  );
  assert.equal(dashGood.status, 202);
  const goodRecords = auditFor(ctx.resultsDir, dashGood.body.plan_id);
  assert.deepEqual(goodRecords[0].actor, goodActor);
  assert.equal(goodRecords[0].client, 'dashboard');

  for (const id of [bridgePlan.body.plan_id, dashGood.body.plan_id]) {
    // eslint-disable-next-line no-await-in-loop
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`, bridgeHeaders), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

test('audit: malformed or oversized actor 400s regardless of client (not just the dashboard token)', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const notAnObject = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: 'just-a-string' });
  assert.equal(notAnObject.status, 400);

  const badSource = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: { source: 'not-a-real-source', id: 'gh:x' } });
  assert.equal(badSource.status, 400);

  // A bare, non-scheme-prefixed id must 400.
  const noScheme = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: { source: 'dashboard', id: 'just-a-bare-name-no-scheme' } });
  assert.equal(noScheme.status, 400, 'actor.id must be scheme-prefixed (e.g. gh:<login>) — a bare name must be rejected');
  assert.ok(noScheme.body.details.some((d) => /scheme-prefixed/.test(d)));

  // A well-formed scheme still passes.
  const wellScheme = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: { source: 'slack', id: 'slack:U12345' } });
  assert.equal(wellScheme.status, 202, 'a scheme-prefixed id must still be accepted');

  const badGithubId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', actor: { source: 'dashboard', id: 'gh:x', github_id: 'not-a-number' } });
  assert.equal(badGithubId.status, 400);

  const oversized = await postJson(ctx.baseUrl, '/plan', {
    description: 'x'.repeat(50), requester: 'test-requester', actor: { source: 'dashboard', id: 'gh:x', display: 'z'.repeat(2000) },
  });
  assert.equal(oversized.status, 400);

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${wellScheme.body.plan_id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('audit: append failure (audit dir blocked by a file) never blocks the mutation — loud stderr, HTTP response still succeeds', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // Block the exact path appendAudit will try to mkdir -p onto.
  const serviceDir = path.join(ctx.resultsDir, 'service');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, 'audit'), 'not a directory');

  const stderrLines = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { stderrLines.push(args.join(' ')); };
  t.after(() => { console.error = originalConsoleError; });

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(created.status, 202, 'the mutation must still succeed even though its audit line could not be written');
  assert.ok(created.body.request_id, 'request_id is still generated/returned even when the append fails');
  assert.ok(stderrLines.some((l) => l.includes('AUDIT WRITE FAILED')), 'the failure must be loud on stderr');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});
