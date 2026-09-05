import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';

test('happy path: plan -> shape_ready -> approve-shape -> plan_ready -> create -> created (cost 2.0)', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', {
    description: 'Add prompt-text search to the generation history page',
    requester: 'test-requester',
  });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, 'breaking_down');
  const planId = created.body.plan_id;
  assert.match(planId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.status, 'shape_ready');
  assert.ok(shapeReady.body.skeleton, 'skeleton should be present in the view');
  assert.ok(shapeReady.body.skeleton_gate, 'skeleton_gate should be present');
  assert.equal(shapeReady.body.skeleton_gate.ok, true, 'the REAL treecheck skeleton gate should pass on the live-proven e2e fixture');
  assert.equal(shapeReady.body.cost_usd, 0.8);
  assert.ok(
    fs.existsSync(path.join(ctx.resultsDir, 'agent', `svc-${planId}`, 'skeleton.json')),
    'skeleton.json should exist in the run dir',
  );

  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approved.status, 202);
  assert.equal(approved.body.status, 'grooming');

  const planReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'grooming',
  );
  assert.equal(planReady.body.status, 'plan_ready');
  assert.ok(planReady.body.plan, 'groomed plan should be present in the view');
  assert.ok(planReady.body.plan_gate, 'plan_gate should be present');
  assert.equal(planReady.body.plan_gate.skipped, true, 'plan gate is skipped via RADSVINN_SKIP_PLAN_ANCHORS=1 in this env');
  assert.equal(planReady.body.cost_usd, 1.7);
  assert.ok(planReady.body.duplicate_search, 'advisory duplicate_search should be attached at plan_ready');
  assert.equal(planReady.body.duplicate_search.ok, true);
  assert.ok(
    fs.existsSync(path.join(ctx.resultsDir, 'agent', `svc-${planId}`, 'plan.json')),
    'plan.json should exist in the run dir',
  );

  const creating = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(creating.status, 202);
  assert.equal(creating.body.status, 'creating');

  const doneRes = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'creating',
  );
  assert.equal(doneRes.body.status, 'created');
  assert.ok(doneRes.body.created, 'created record should be present in the view');
  assert.deepEqual(doneRes.body.created.keys, ['PROJ-999']);
  assert.equal(doneRes.body.created.items[0].key, 'PROJ-999');
  assert.equal(doneRes.body.created.verify_ok, true);
  // Both engines write the SAME record filename (engine.mjs
  // CREATED_RECORD_FILENAME) — the retry guard's on-disk check depends on it.
  assert.ok(doneRes.body.created.record_path.endsWith(`${path.sep}created-record.json`));
  assert.equal(doneRes.body.cost_usd, 1.7, 'planning calls only (0.8 + 0.9) — the control-plane create is not LLM spend');
});

test('C0: requester_id is persisted and echoed by GET /plan (toPublicView); missing/junk fails OPEN', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // WITH requester_id → round-trips through the view. THIS assertion is the
  // C0 mutation-proof guard: dropping `requester_id` from toPublicView makes
  // it fail (the id becomes undefined in the response).
  const withId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', requester_id: 'U777' });
  assert.equal(withId.status, 202, 'requester_id is accepted');
  const withView = await getJson(ctx.baseUrl, `/plan/${withId.body.plan_id}`);
  assert.equal(withView.body.requester_id, 'U777', 'GET /plan surfaces requester_id');

  // WITHOUT requester_id → still succeeds (fail-open: it is optional and
  // non-validated, unlike the required `requester`), defaulting to ''.
  const noId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(noId.status, 202, 'a plan missing requester_id must NOT be rejected (visibility field, not a security control)');
  const noIdView = await getJson(ctx.baseUrl, `/plan/${noId.body.plan_id}`);
  assert.equal(noIdView.body.requester_id, '', 'absent requester_id defaults to empty string');

  // A non-string requester_id must NOT reject either — it degrades to ''.
  const junkId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', requester_id: 42 });
  assert.equal(junkId.status, 202, 'a junk requester_id fails open, never a 400');
  const junkView = await getJson(ctx.baseUrl, `/plan/${junkId.body.plan_id}`);
  assert.equal(junkView.body.requester_id, '', 'non-string requester_id degrades to empty string');

  // Let the fire-and-forget phase-1 workers finish before ctx.close() tears
  // down the tmp results dir (house discipline).
  for (const id of [withId.body.plan_id, noId.body.plan_id, junkId.body.plan_id]) {
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

test('C0 fail-open adversarial: an OBJECT or a null requester_id never causes a 4xx — both degrade to an empty string', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // typeof body.requester_id === 'string' ? … : '' — an object is truthy but
  // not a string, so it must degrade exactly like the number case, never a
  // 400. This is the load-bearing safety property: requester_id is
  // visibility (an @-mention hint), never a security control.
  const objId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', requester_id: { nested: 'poison', toString: () => '<!channel>' } });
  assert.equal(objId.status, 202, 'an object requester_id must never be rejected');
  const objView = await getJson(ctx.baseUrl, `/plan/${objId.body.plan_id}`);
  assert.equal(objView.body.requester_id, '', 'an object requester_id degrades to empty string, not stringified/coerced');

  // null is JSON-legal and typeof null === 'object' — the same typeof guard
  // must catch it too (a naive `!body.requester_id` check would also catch
  // this, but a naive `typeof body.requester_id !== 'undefined'` would not).
  const nullId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', requester_id: null });
  assert.equal(nullId.status, 202, 'a null requester_id must never be rejected');
  const nullView = await getJson(ctx.baseUrl, `/plan/${nullId.body.plan_id}`);
  assert.equal(nullView.body.requester_id, '', 'a null requester_id degrades to empty string');

  // An array is also a non-string, truthy JSON value — same fail-open path.
  const arrId = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', requester_id: ['U1', 'U2'] });
  assert.equal(arrId.status, 202, 'an array requester_id must never be rejected');
  const arrView = await getJson(ctx.baseUrl, `/plan/${arrId.body.plan_id}`);
  assert.equal(arrView.body.requester_id, '', 'an array requester_id degrades to empty string');

  for (const id of [objId.body.plan_id, nullId.body.plan_id, arrId.body.plan_id]) {
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

test('CAS transitions: second approve-shape 409s; reject cannot be overridden by create', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');

  const first = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(first.status, 202);
  // Immediate second approve: plan is grooming (or beyond) — CAS must 409.
  const second = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(second.status, 409, 'second approve-shape must lose the CAS');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'nope' });
  assert.equal(rejected.status, 200);
  // Create after reject: CAS on plan_ready must miss.
  const createAfterReject = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(createAfterReject.status, 409, 'create must never resurrect a rejected plan');
  const final = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(final.body.status, 'rejected', 'rejection stands');
});

test('create failure path: control-plane create throws -> status failed with actionable error', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_FAIL: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  const failed = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');

  assert.equal(failed.body.status, 'failed');
  // CREATE_FAIL models dying before ANY record was written — the error must
  // say so, and must NOT direct the operator at a nonexistent record (the
  // old wording claimed "partial tree recorded" with nothing on disk).
  assert.match(failed.body.error, /before any record was written/, 'a no-record failure is described honestly');
});

test('output_language: validated on POST /plan and echoed in the view', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const bad = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', output_language: 'de' });
  assert.equal(bad.status, 400, 'an unsupported language must be rejected');

  const tr = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', output_language: 'tr' });
  assert.equal(tr.status, 202);
  const view = await getJson(ctx.baseUrl, `/plan/${tr.body.plan_id}`);
  assert.equal(view.body.output_language, 'tr', 'the chosen language is persisted and surfaced');

  const dflt = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const dview = await getJson(ctx.baseUrl, `/plan/${dflt.body.plan_id}`);
  assert.equal(dview.body.output_language, 'en', 'absent language defaults to en');
});

test('retry: failed + skeleton present -> grooming; non-failed -> 409', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_FAIL: '1' });
  t.after(() => ctx.close());

  // Drive a plan to `failed` at the create step (skeleton + plan.json both
  // exist by then → retry resumes by re-running the create-phase worker...
  // but simplest deterministic path: retry is 409 unless failed).
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  // Not failed yet → retry must 409.
  const early = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(early.status, 409, 'retry is only valid from failed');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');

  // Now failed at the create step: skeleton.json AND plan.json both exist, so
  // retry resumes at `creating` (re-runs the create worker), not a wasteful
  // phase-1 redo.
  const failed = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(failed.body.status, 'failed');
  // RADSVINN_FAKE_CREATE_FAIL models create-tree dying BEFORE its first Jira
  // write — no record lands on disk, so the retry write guard retry guard has nothing to
  // protect and must NOT block this retry.
  assert.ok(
    !fs.existsSync(path.join(ctx.resultsDir, 'agent', `svc-${planId}`, 'created-record.json')),
    'a fail-before-any-write create leaves no record on disk',
  );
  // "Transient cause cleared" → the retried create must run for real and
  // SUCCEED (the retry write guard only blocks retries when a record proves Jira
  // writes already happened). ctx.close() restores the env var.
  process.env.RADSVINN_FAKE_CREATE_FAIL = '0';
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202, 'retry from failed is accepted');
  assert.equal(retry.body.status, 'creating', 'a create-step failure resumes at creating, not phase 1');
  const done = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(done.body.status, 'created', 'failure BEFORE any Jira write retries into a successful create');
  assert.deepEqual(done.body.created.keys, ['PROJ-999']);
  assert.equal(done.body.created.verify_ok, true);
});

test('retry: groom fails for insufficient provider balance, then resumes at grooming and completes', async (t) => {
  // RADSVINN_FAKE_GROOM_FAIL makes groom throw with skeleton.json present but
  // no plan.json — the expected state when provider balance runs out
  // mid-groom.
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_GROOM_FAIL: '1' });
  t.after(() => ctx.close());
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', output_language: 'tr' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  const failed = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(failed.body.status, 'failed', 'groom failure lands as failed with skeleton-but-no-plan');
  assert.equal(failed.body.output_language, 'tr', 'the chosen language survives the failure for the retry');

  // "Top up the balance" → clear the fake failure, then retry. The engine
  // reads process.env at call time and the test server is in-process, so this
  // takes effect for the retried groom; ctx.close() restores it.
  process.env.RADSVINN_FAKE_GROOM_FAIL = '0';
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'grooming', 'retry resumes at grooming — no phase-1 redo');
  const recovered = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(recovered.body.status, 'plan_ready', 'the retried groom completes and the plan is ready');
});

test('approve-shape with skeleton_edits rewrites the file and re-gates before grooming', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready',
    { timeoutMs: 30000 },
  );

  const edited = {
    ...shapeReady.body.skeleton,
    epic: { ...shapeReady.body.skeleton.epic, summary: 'EDITED BY HUMAN REVIEWER' },
  };

  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, { skeleton_edits: edited });
  assert.equal(approved.status, 202);
  assert.equal(approved.body.status, 'grooming');

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(ctx.resultsDir, 'agent', `svc-${planId}`, 'skeleton.json'), 'utf8'),
  );
  assert.equal(onDisk.epic.summary, 'EDITED BY HUMAN REVIEWER');

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.skeleton.epic.summary, 'EDITED BY HUMAN REVIEWER');
  assert.equal(view.body.skeleton_gate.ok, true, 'the edited skeleton must pass the re-run gate');

  // approve-shape kicked off runGroomWorker in the background — wait for it
  // to actually finish before the test ends and tears down the tmp results
  // dir (a still-running worker outliving teardown is exactly how a stray
  // artifact could otherwise leak outside the isolated tmp directory).
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
});

test('approve-shape with a gate-failing skeleton_edits is rejected 422 and does not transition', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  // Deliberately malformed: not a valid skeleton contract at all.
  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, { skeleton_edits: { nonsense: true } });
  assert.equal(rejected.status, 422);
  assert.ok(rejected.body.gate);
  assert.equal(rejected.body.gate.ok, false);

  const stillShapeReady = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(stillShapeReady.body.status, 'shape_ready', 'a failed re-gate must not advance the state machine');
});

test('reject: illegal before shape_ready (409), allowed at shape_ready (200), locks further transitions', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const tooEarly = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'too soon' });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.status, 'breaking_down');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'not needed after all', stage: 'shape' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');

  const afterReject = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(afterReject.status, 409);
  assert.equal(afterReject.body.status, 'rejected');
});

test('validation: empty description, bad role_lens, oversized description, invalid JSON -> 400', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const empty = await postJson(ctx.baseUrl, '/plan', { description: '', requester: 'test-requester' });
  assert.equal(empty.status, 400);

  const noRequester = await postJson(ctx.baseUrl, '/plan', { description: 'ok description', requester: '' });
  assert.equal(noRequester.status, 400);

  const badRoleLens = await postJson(ctx.baseUrl, '/plan', { description: 'ok', requester: 'test-requester', role_lens: 'nope' });
  assert.equal(badRoleLens.status, 400);

  const tooLong = await postJson(ctx.baseUrl, '/plan', { description: 'a'.repeat(8001), requester: 'test-requester' });
  assert.equal(tooLong.status, 400);

  const invalidJson = await fetch(`${ctx.baseUrl}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not valid json',
  });
  assert.equal(invalidJson.status, 400);
  assert.match(invalidJson.headers.get('content-type') || '', /application\/json/);
});

test('oversized body -> 413', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const big = 'a'.repeat(70 * 1024);
  const res = await fetch(`${ctx.baseUrl}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: big, requester: 'test-requester' }),
  });
  assert.equal(res.status, 413);
});

test('unknown plan id -> 404, malformed uuid -> 404', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const missing = await getJson(ctx.baseUrl, '/plan/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);

  const malformed = await getJson(ctx.baseUrl, '/plan/not-a-uuid');
  assert.equal(malformed.status, 404);
});

test('GET /plans lists a created plan, description truncated to 80 chars', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const longDescription = 'x'.repeat(120);
  const created = await postJson(ctx.baseUrl, '/plan', { description: longDescription, requester: 'test-requester' });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  const listed = await getJson(ctx.baseUrl, '/plans');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.plans));
  const entry = listed.body.plans.find((p) => p.plan_id === planId);
  assert.ok(entry, 'the newly created plan should be listed');
  assert.equal(entry.status, 'breaking_down');
  assert.equal(entry.description, longDescription.slice(0, 80));
  assert.equal(entry.description.length, 80);
  assert.ok(entry.updated_at);

  // Wait for the background worker to finish before the test ends and
  // ctx.close() tears down the tmp results dir (same discipline as every
  // other test in this file).
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('unknown route -> 404, wrong method on a known route -> 405', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const unknown = await getJson(ctx.baseUrl, '/nope');
  assert.equal(unknown.status, 404);

  const planNoId = await getJson(ctx.baseUrl, '/plan');
  assert.equal(planNoId.status, 405);

  const wrongMethod = await fetch(`${ctx.baseUrl}/healthz`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);

  const deepUnknown = await getJson(ctx.baseUrl, '/plan/00000000-0000-4000-8000-000000000000/bogus');
  assert.equal(deepUnknown.status, 404);
});

test('bearer auth: 401 without token / wrong token, 200 with the right token; healthz always open', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SERVICE_TOKEN: 'sekret-1234' });
  t.after(() => ctx.close());

  const noAuth = await postJson(ctx.baseUrl, '/plan', { description: 'ok', requester: 'test-requester' });
  assert.equal(noAuth.status, 401);

  const wrongAuth = await postJson(
    ctx.baseUrl, '/plan', { description: 'ok', requester: 'test-requester' },
    { Authorization: 'Bearer wrong-token' },
  );
  assert.equal(wrongAuth.status, 401);

  const rightAuth = await postJson(
    ctx.baseUrl, '/plan', { description: 'ok', requester: 'test-requester' },
    { Authorization: 'Bearer sekret-1234' },
  );
  assert.equal(rightAuth.status, 202);

  // Wait for this plan's fire-and-forget worker to actually finish before
  // the test ends and `ctx.close()` tears down the tmp results dir — a
  // still-running worker outliving teardown is exactly how a stray
  // artifact could otherwise leak outside the isolated tmp directory.
  await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${rightAuth.body.plan_id}`, { Authorization: 'Bearer sekret-1234' }),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );

  const health = await getJson(ctx.baseUrl, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.engine, 'fake');
});

test('every response is application/json, including errors', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  for (const check of [
    () => fetch(`${ctx.baseUrl}/nope`),
    () => fetch(`${ctx.baseUrl}/plan`, { method: 'GET' }),
    () => fetch(`${ctx.baseUrl}/plan/not-a-uuid`),
    () => fetch(`${ctx.baseUrl}/healthz`),
  ]) {
    const res = await check();
    assert.match(res.headers.get('content-type') || '', /application\/json/);
  }
});
