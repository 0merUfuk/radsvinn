// read-model.test.mjs — §6.1: GET /plan/{id}'s new toPublicView fields
// (description, requester, role_lens, reject_reason, reject_stage).
//
// House pattern: startTestServer/postJson/getJson/pollUntil (helpers.mjs);
// the legacy-plan case constructs its own tmp dir + createServer directly
// (the persistence.test.mjs pattern) since it needs to seed an on-disk
// plan file BEFORE boot, which startTestServer's helper has no hook for.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';

test('read-model: full description (>80 chars), requester, role_lens are surfaced by GET /plan; reject pair is absent pre-reject', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const longDescription = `${'x'.repeat(120)} — the full text must round-trip untruncated`;
  const created = await postJson(ctx.baseUrl, '/plan', {
    description: longDescription,
    requester: 'test-requester',
    role_lens: 'tech',
  });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.description, longDescription, "GET /plan/{id} must carry the FULL description, unlike GET /plans' 80-char list truncation");
  assert.equal(view.body.description.length, longDescription.length);
  assert.equal(view.body.requester, 'test-requester');
  assert.equal(view.body.role_lens, 'tech');
  assert.equal(view.body.reject_reason, undefined, 'reject_reason is absent (JSON drops undefined) before any reject');
  assert.equal(view.body.reject_stage, undefined, 'reject_stage is absent before any reject');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('read-model: reject_reason/reject_stage are surfaced verbatim after a reject, including the default stage', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'not needed after all' });
  assert.equal(rejected.status, 200);

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.reject_reason, 'not needed after all', 'the submitted reason must be READABLE at the detail view, not decorative-only in the audit ledger');
  assert.equal(view.body.reject_stage, 'shape_ready', 'an omitted stage defaults to the status the plan was rejected FROM');
  assert.equal(view.body.status, 'rejected');
});

test('read-model: an explicit stage on reject is preserved verbatim', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'bad shape', stage: 'shape-review' });
  assert.equal(rejected.status, 200);
  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.reject_stage, 'shape-review');
});

test('read-model: a legacy on-disk plan file (predates description/requester/role_lens/reject_* on disk) loads and renders without those fields, never crashing GET /plan', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-service-read-model-'));
  const prevResultsDir = process.env.RADSVINN_RESULTS_DIR;
  const prevEngine = process.env.RADSVINN_ENGINE;
  process.env.RADSVINN_RESULTS_DIR = resultsDir;
  process.env.RADSVINN_ENGINE = 'fake';
  t.after(() => {
    if (prevResultsDir === undefined) delete process.env.RADSVINN_RESULTS_DIR;
    else process.env.RADSVINN_RESULTS_DIR = prevResultsDir;
    if (prevEngine === undefined) delete process.env.RADSVINN_ENGINE;
    else process.env.RADSVINN_ENGINE = prevEngine;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  // A plan file shaped like the OLDEST pre-this-PR record: none of the keys
  // this PR's toPublicView newly surfaces exist on disk at all.
  const plansDir = path.join(resultsDir, 'service', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const legacyId = '33333333-3333-4333-8333-333333333333';
  fs.writeFileSync(path.join(plansDir, `${legacyId}.json`), JSON.stringify({
    plan_id: legacyId,
    status: 'created',
    cost_usd: 2.0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  const app = createServer();
  const addr = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const view = await getJson(baseUrl, `/plan/${legacyId}`);
  assert.equal(view.status, 200, 'a legacy plan missing the new fields must not crash GET /plan');
  assert.equal(view.body.status, 'created', 'pre-existing fields are unaffected');
  assert.equal(view.body.description, undefined, 'a legacy plan has no description on disk — absent, never fabricated');
  assert.equal(view.body.requester, undefined);
  assert.equal(view.body.role_lens, undefined);
  assert.equal(view.body.reject_reason, undefined);
  assert.equal(view.body.reject_stage, undefined);
});
