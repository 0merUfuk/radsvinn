// audit-read.test.mjs — §5.4: GET /audit, the read endpoint backing the
// planner's own audit ledger. Exercises the plan filter, newest-first
// ordering, keyset cursor pagination across TWO day-files, torn-line
// tolerance, and the bearer gate — the query-semantics half of the ledger
// (audit.test.mjs covers WHAT gets written and WHEN).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { auditDir } from '../audit.mjs';

function writeAuditFile(resultsDir, dateStamp, records) {
  const dir = auditDir(resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, `${dateStamp}.jsonl`), body);
}

test("GET /audit: plan_id filter returns only that plan's records; a malformed plan_id 400s", async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const a = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const b = await postJson(ctx.baseUrl, '/plan', { description: 'y'.repeat(50), requester: 'test-requester' });

  const filtered = await getJson(ctx.baseUrl, `/audit?plan_id=${a.body.plan_id}`);
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.records.length > 0);
  assert.ok(filtered.body.records.every((r) => r.plan_id === a.body.plan_id), "only plan A's records must come back");
  assert.ok(!filtered.body.records.some((r) => r.plan_id === b.body.plan_id));

  const malformed = await getJson(ctx.baseUrl, '/audit?plan_id=not-a-uuid');
  assert.equal(malformed.status, 400);

  for (const id of [a.body.plan_id, b.body.plan_id]) {
    // eslint-disable-next-line no-await-in-loop
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

test('GET /audit: records come back newest-first', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready');
  await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'created');

  const res = await getJson(ctx.baseUrl, `/audit?plan_id=${planId}`);
  assert.equal(res.status, 200);
  const actions = res.body.records.map((r) => r.action);
  assert.deepEqual(actions, ['plan.create_tree', 'plan.approve_shape', 'plan.submit'], 'newest first — the most recent mutation leads');
});

test('GET /audit: cursor pagination walks two day-files without dup/omission, newest date first', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const rec = (requestId, ts, planId) => ({
    ts, request_id: requestId, client: 'api', actor: null, action: 'plan.submit', plan_id: planId, prior_status: null, result: { http: 202 },
  });
  writeAuditFile(ctx.resultsDir, '2026-01-01', [
    rec('d1-a', '2026-01-01T00:00:00.000Z', 'p1'),
    rec('d1-b', '2026-01-01T00:00:01.000Z', 'p2'),
    rec('d1-c', '2026-01-01T00:00:02.000Z', 'p3'),
  ]);
  writeAuditFile(ctx.resultsDir, '2026-01-02', [
    rec('d2-a', '2026-01-02T00:00:00.000Z', 'p4'),
    rec('d2-b', '2026-01-02T00:00:01.000Z', 'p5'),
    rec('d2-c', '2026-01-02T00:00:02.000Z', 'p6'),
  ]);

  const expectedOrder = ['d2-c', 'd2-b', 'd2-a', 'd1-c', 'd1-b', 'd1-a']; // newest date first, newest line first within a file

  const seen = [];
  let cursor;
  let pages = 0;
  for (;;) {
    pages += 1;
    assert.ok(pages <= 10, 'runaway pagination — something is not terminating');
    const qs = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
    // eslint-disable-next-line no-await-in-loop
    const page = await getJson(ctx.baseUrl, `/audit${qs}`);
    assert.equal(page.status, 200);
    for (const r of page.body.records) seen.push(r.request_id);
    if (!page.body.next_cursor) break;
    cursor = page.body.next_cursor;
  }

  assert.equal(pages, 3, '6 records at limit=2 must walk exactly 3 pages');
  assert.deepEqual(seen, expectedOrder, 'no dup/omission; newest date first, newest line first within a file');
});

test('GET /audit: a torn/corrupt last line is skipped, never thrown, and never counted against the page', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const dir = auditDir(ctx.resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  const goodLine = JSON.stringify({
    ts: '2026-01-01T00:00:00.000Z', request_id: 'good-1', client: 'api', actor: null, action: 'plan.submit', plan_id: 'p1', prior_status: null, result: { http: 202 },
  });
  // A torn tail — exactly what a crash mid-append leaves (state.mjs skips a
  // corrupt plan file the same way; audit.mjs must too).
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), `${goodLine}\n{"ts":"2026-01-01T00:`);

  const res = await getJson(ctx.baseUrl, '/audit');
  assert.equal(res.status, 200, 'a torn tail must never surface as a 500');
  assert.equal(res.body.records.length, 1, 'the torn line is skipped, not counted');
  assert.equal(res.body.records[0].request_id, 'good-1');
});

test('GET /audit: malformed cursor 400s; an explicitly empty cursor is treated as "no cursor"', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const garbage = await getJson(ctx.baseUrl, '/audit?cursor=not-the-right-shape-at-all');
  assert.equal(garbage.status, 400);

  const empty = await getJson(ctx.baseUrl, '/audit?cursor=');
  assert.equal(empty.status, 200, 'an empty cursor value must behave like an absent one');
});

test('GET /audit: limit bounds — 0/501/junk 400, 1/100/500 accepted', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());
  for (const bad of ['0', '501', 'abc', '-3']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await getJson(ctx.baseUrl, `/audit?limit=${bad}`);
    assert.equal(res.status, 400, `limit=${bad} must 400`);
  }
  for (const ok of ['1', '500', '100']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await getJson(ctx.baseUrl, `/audit?limit=${ok}`);
    assert.equal(res.status, 200, `limit=${ok} must be accepted`);
  }
});

test('GET /audit requires the bearer like every other non-healthz route', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SERVICE_TOKEN: 'sekret-audit' });
  t.after(() => ctx.close());
  const noAuth = await getJson(ctx.baseUrl, '/audit');
  assert.equal(noAuth.status, 401);
  const withAuth = await getJson(ctx.baseUrl, '/audit', { Authorization: 'Bearer sekret-audit' });
  assert.equal(withAuth.status, 200);
});
