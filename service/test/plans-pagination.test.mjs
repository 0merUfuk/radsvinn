// plans-pagination.test.mjs — §6.2: GET /plans cursor pagination + status
// filter, and the read-model item fields it adds. Deliberately proves the
// BARE call stays byte-identical to before the API extension (today's six fields,
// unchanged values) plus EXACTLY the six additive item fields and a
// top-level `next_cursor` only when more pages exist — the Slack bridge's
// boot-resume reads this same endpoint and must never notice a shape
// change (§6.6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';

const TODAY_FIELDS = ['plan_id', 'status', 'description', 'updated_at', 'surface', 'announced_status'];
const ADDITIVE_FIELDS = ['requester', 'requester_id', 'cost_usd', 'created_at', 'grounding_hint', 'attach_key'];

test("bare GET /plans: today's six fields are byte-identical, plus exactly the six additive item fields", async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const longDescription = 'y'.repeat(200);
  const created = await postJson(ctx.baseUrl, '/plan', {
    description: longDescription,
    requester: 'test-requester',
    requester_id: 'U42',
    grounding_hint: 'light',
    surface: { type: 'test', channel: 'C1' },
  });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  // announced_status is only settable post-create (via POST .../surface) —
  // populate it too so every one of today's fields is DETERMINISTICALLY
  // present below; otherwise (like every other optional field here) JSON
  // drops it when unset and the key-set assertion would be vacuous.
  const surfaceRes = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { announced_status: 'breaking_down' });
  assert.equal(surfaceRes.status, 200);

  const listed = await getJson(ctx.baseUrl, '/plans');
  assert.equal(listed.status, 200);
  const entry = listed.body.plans.find((p) => p.plan_id === planId);
  assert.ok(entry, 'the new plan is listed');

  const keys = Object.keys(entry).sort();
  assert.deepEqual(keys, [...TODAY_FIELDS, ...ADDITIVE_FIELDS].sort(), "exactly today's fields + exactly the six additive fields — nothing more, nothing missing");

  // Today's fields, unchanged behavior:
  assert.equal(entry.description, longDescription.slice(0, 80), "description stays truncated to 80 chars in the LIST (full text is GET /plan/{id}-only, per §6.1)");
  assert.equal(entry.status, 'breaking_down');
  assert.ok(entry.updated_at);
  assert.deepEqual(entry.surface, { type: 'test', channel: 'C1' }, 'surface round-trips verbatim, unaffected by the additive fields around it');
  assert.equal(entry.announced_status, 'breaking_down');

  // The six additive fields:
  assert.equal(entry.requester, 'test-requester');
  assert.equal(entry.requester_id, 'U42');
  // cost_usd is a present, well-typed additive field; its exact VALUE at an
  // arbitrary mid-flight list is phase-timing-dependent — a plan caught in
  // `breaking_down` may show 0 (before phase-1 spend is recorded) or the
  // phase-1 cost (once the worker persists it, which now lands before the
  // status flips to shape_ready). Assert the contract (present, non-negative
  // number), never a racy snapshot value.
  assert.ok(typeof entry.cost_usd === 'number' && entry.cost_usd >= 0, 'cost_usd is a present, non-negative number');
  assert.ok(entry.created_at);
  assert.equal(entry.grounding_hint, 'light');
  assert.equal(entry.attach_key, null, 'null both pre-shape_ready and for a non-attaching epic — never absent');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('bare GET /plans omits next_cursor entirely when everything fits on one page', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const listed = await getJson(ctx.baseUrl, '/plans');
  assert.equal(listed.status, 200);
  assert.equal('next_cursor' in listed.body, false, 'next_cursor must be ABSENT (not null/undefined-valued) when there is no further page');
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('cursor walk over 7 plans with COLLIDING updated_at, limit=3: every plan visited exactly once, tie-broken on plan_id desc', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const planIds = [];
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const created = await postJson(ctx.baseUrl, '/plan', { description: `plan number ${i}`.repeat(5), requester: 'test-requester' });
    assert.equal(created.status, 202);
    planIds.push(created.body.plan_id);
  }

  // Let every plan's background phase1 worker settle FIRST. Each worker
  // ends in its own state.update (status -> shape_ready, a FRESH
  // updated_at); if one lands DURING the walk below it can silently vanish
  // that plan from a keyset page already scanned past — precisely the
  // "mutated mid-pagination can jump pages" caveat §6.2 documents. Settling
  // first means nothing further touches these plans' updated_at, so the
  // forced collision below is stable for the rest of the test.
  for (const id of planIds) {
    // eslint-disable-next-line no-await-in-loop
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }

  // Force the exact collision today's single-key sort could not break: every
  // plan gets the SAME updated_at, so only the (new) plan_id tiebreak can
  // give the walk a total order.
  const collidedAt = '2026-01-01T00:00:00.000Z';
  for (const id of planIds) ctx.app._state.update(id, { updated_at: collidedAt });

  // Mirror comparePlansDesc's own tiebreak comparator exactly (rather than
  // a plain Array#sort) so this assertion never depends on whether default
  // string sort happens to agree with localeCompare for this shape of id.
  const expectedOrder = [...planIds].sort((a, b) => b.localeCompare(a));

  const seen = [];
  let cursor;
  let pages = 0;
  for (;;) {
    pages += 1;
    assert.ok(pages <= 10, 'runaway pagination — something is not terminating');
    const qs = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
    // eslint-disable-next-line no-await-in-loop
    const page = await getJson(ctx.baseUrl, `/plans${qs}`);
    assert.equal(page.status, 200);
    for (const p of page.body.plans) seen.push(p.plan_id);
    if (!page.body.next_cursor) break;
    cursor = page.body.next_cursor;
  }

  assert.equal(pages, 3, '7 plans at limit=3 must walk exactly 3 pages (3+3+1)');
  assert.deepEqual(seen, expectedOrder, 'no duplicate, no omission, and the plan_id tiebreak gives a stable total order across colliding updated_at values');
});

test('limit bounds: 0, 201, and non-integer junk all 400; 1/50/200 are accepted', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  for (const bad of ['0', '201', 'abc', '1.5', '-1']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await getJson(ctx.baseUrl, `/plans?limit=${bad}`);
    assert.equal(res.status, 400, `limit=${bad} must 400`);
  }
  for (const ok of ['1', '200', '50']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await getJson(ctx.baseUrl, `/plans?limit=${ok}`);
    assert.equal(res.status, 200, `limit=${ok} must be accepted`);
  }
});

test('status filter: an unknown status 400s; a valid comma-list filters correctly', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const bad = await getJson(ctx.baseUrl, '/plans?status=not_a_status');
  assert.equal(bad.status, 400);

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const onlyBreakingDown = await getJson(ctx.baseUrl, '/plans?status=breaking_down,shape_ready');
  assert.equal(onlyBreakingDown.status, 200);
  assert.ok(onlyBreakingDown.body.plans.some((p) => p.plan_id === planId));

  const onlyCreated = await getJson(ctx.baseUrl, '/plans?status=created');
  assert.equal(onlyCreated.status, 200);
  assert.ok(!onlyCreated.body.plans.some((p) => p.plan_id === planId), 'a plan still breaking_down must not match a created-only filter');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('malformed cursor 400s; an explicitly EMPTY cursor is treated as "no cursor" (200, first page)', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const garbage = await getJson(ctx.baseUrl, '/plans?cursor=not-valid-base64url-shape');
  assert.equal(garbage.status, 400, 'a cursor that does not decode to "<updated_at> <plan_id>" must 400');

  const empty = await getJson(ctx.baseUrl, '/plans?cursor=');
  assert.equal(empty.status, 200, 'an explicit but EMPTY cursor value must be treated as "no cursor", not "malformed" — GET /audit already treats its own cursor this way, and this PR must not ship two conventions for the same edge case');
  assert.ok(Array.isArray(empty.body.plans));
  assert.ok(empty.body.plans.some((p) => p.plan_id === planId), 'an empty cursor must behave exactly like an absent one — first page, includes the plan');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});
