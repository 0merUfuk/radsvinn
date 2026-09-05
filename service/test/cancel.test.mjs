// cancel.test.mjs — cancel flow: POST /plan/{id}/cancel, the Slack undo for a tree
// that already lives on the real board.
//
// Why a separate file (not http-e2e.test.mjs): `node --test` runs each test
// FILE in its own child process, so the cancel flow-specific knob this file flips
// (RADSVINN_FAKE_CLEANUP_FAIL, plus the retry write guard knobs it borrows to stage a
// partial tree) is process-isolated from the other suites running
// concurrently — no cross-file env leakage is possible. All filesystem
// state lives under per-test mkdtemp roots; within this file, top-level
// tests run sequentially and every env mutation is restored by ctx.close()
// / t.after (house pattern, same as retry-guard.test.mjs).
//
// The properties under test, in two lines: cancel is legal exactly when a
// created record exists (from `created` or `failed`), always ends in
// `cancelled` (marker gains cancelled:true, keys/record preserved) or
// `failed` (marker untouched, so the Cancel button re-appears — re-click is
// the recovery); the on-disk record survives every outcome (cleanup
// cancels, NEVER deletes — the record stays the audit handle).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { CREATED_RECORD_FILENAME } from '../engine.mjs';

// Drives a fresh plan through plan -> approve-shape -> create and waits for
// the create worker to settle (status leaves `creating`). Which terminal
// state it lands in depends on the RADSVINN_FAKE_* knobs the caller set.
// (Same helper shape as retry-guard.test.mjs.)
async function driveThroughCreate(ctx) {
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approved.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  const creating = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(creating.status, 202);
  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  return { planId, settled };
}

// POSTs the cancel, asserts the 202 {status:'cancelling'} contract, and
// polls until the cancel worker settles the plan out of `cancelling`.
async function cancelAndSettle(ctx, planId) {
  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202, 'cancel with a record on file is accepted');
  assert.equal(cancel.body.status, 'cancelling');
  return pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'cancelling');
}

// -----------------------------------------------------------------------------

test('cancel flow cancel from created: 202 cancelling -> cancelled; marker gains cancelled:true, keys/record preserved, error gone; already-cancelled re-cancel 409s', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  const cancelled = await cancelAndSettle(ctx, planId);
  assert.equal(cancelled.body.status, 'cancelled', 'a clean sweep lands the terminal cancelled status');
  assert.equal(cancelled.body.created.cancelled, true, 'cancelled:true is the durable fact on the marker');
  assert.deepEqual(cancelled.body.created.keys, ['PROJ-999'], 'keys from the original create are preserved for audit');
  assert.equal(cancelled.body.created.record_path, recordPath, 'the record path stays on the marker');
  assert.equal(cancelled.body.error, undefined, 'no stale error on a successful cancel');
  assert.match(cancelled.body.agent_summary, /\[fake\] cleanup OK — 1 issue\(s\) transitioned/, 'the sweep output lands in agent_summary (per-ticket results for GET /plan)');
  assert.ok(fs.existsSync(recordPath), 'cleanup cancels, never deletes — the record survives as the audit handle');

  // Already cancelled → the status pre-check 409s with the current status.
  const again = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(again.status, 409, 'cancel is not legal from cancelled');
  assert.equal(again.body.status, 'cancelled');
});

test('cancel flow cancel from retry write guard failed-with-partial-tree: the CLI dead-end escape — partial marker cancels to cancelled, partial:true preserved', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_PARTIAL: '1' });
  t.after(() => ctx.close());

  // Stage exactly retry write guard's surfaced partial tree: create-tree dies mid-tree
  // (record persisted, no marker), then a retry routes through the guard's
  // verify-only pass and plants the durable partial:true marker — the plan
  // is `failed` with `plan.created.record_path` set, which is cancel flow's cancel
  // precondition on the failed surface.
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  process.env.RADSVINN_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  const blocked = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(blocked.body.status, 'failed');
  assert.equal(blocked.body.created.partial, true, 'precondition: retry write guard planted the partial marker');
  const recordPath = blocked.body.created.record_path;

  const cancelled = await cancelAndSettle(ctx, planId);
  assert.equal(cancelled.body.status, 'cancelled', 'the partial tree is cancellable from Slack — no CLI needed');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(cancelled.body.created.partial, true, 'the partial fact stays on the marker for audit');
  assert.deepEqual(cancelled.body.created.keys, ['PROJ-999']);
  assert.ok(fs.existsSync(recordPath), 'the record survives the cancel');
});

test('cancel flow 409s: no created record — from plan_ready and from a failed-without-record plan', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // plan_ready: nothing was ever written to Jira — nothing to cancel.
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');

  const early = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'no created record to cancel');
  assert.equal(early.body.status, 'plan_ready');
  const after = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(after.body.status, 'plan_ready', 'a refused cancel must not move the plan');
});

test('cancel flow 409: failed WITHOUT a record (pilot groom failure) has nothing to cancel', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_GROOM_FAIL: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  const failed = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.created, undefined, 'a groom failure never has a created record');

  const refused = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(refused.status, 409, 'failed alone is not enough — the record marker is the real precondition');
  assert.equal(refused.body.error, 'no created record to cancel');
  assert.equal(refused.body.status, 'failed');
});

test('cancel flow cleanup failure: failed with re-click guidance + cleanup command inside the 500-char Slack window; marker preserved; re-cancel completes', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CLEANUP_FAIL: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  const failed = await cancelAndSettle(ctx, planId);
  assert.equal(failed.body.status, 'failed', 'a failed sweep lands failed — never a false cancelled');
  assert.ok(
    failed.body.error.startsWith('cancel failed — the tree may be only partially cancelled.'),
    'the error leads with the honest partial-cancel warning',
  );
  // slack-blocks.mjs terminalMessage truncates `error` at 500 chars — the
  // re-click guidance AND the runnable --cleanup command (the two recovery
  // handles) must land inside that window, before the output tail.
  assert.ok(
    failed.body.error.slice(0, 500).includes(`Click "Cancel tree" again or run: node tools/create-tree.mjs --cleanup ${recordPath} --live`),
    'the re-click guidance + full cleanup command survive the 500-char Slack truncation',
  );
  assert.match(failed.body.error, /\[fake\] cleanup failed/, 'the sweep output tail is surfaced (last)');
  assert.equal(failed.body.agent_summary, undefined, 'the create-era summary is cleared — a failed cancel must not surface stale pre-sweep output');
  assert.equal(failed.body.created.record_path, recordPath, 'the marker is untouched — the Cancel button re-appears on the failed message');
  assert.notEqual(failed.body.created.cancelled, true, 'a failed cancel must not claim success');
  assert.ok(fs.existsSync(recordPath), 'the record survives the failed sweep');

  // "The network heals" — clear the knob and re-click. ctx.close() restores.
  process.env.RADSVINN_FAKE_CLEANUP_FAIL = '0';
  const cancelled = await cancelAndSettle(ctx, planId);
  assert.equal(cancelled.body.status, 'cancelled', 'the re-click completes the cancel');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(cancelled.body.error, undefined, 'the failed-sweep error is cleared on success');
});

test('cancel flow crash-resume: a cancel interrupted by restart reloads as failed with the marker intact — re-clicking cancel completes', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-cancel-resume-'));
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

  const planId = '77777777-7777-4777-8777-777777777777';

  // The record the interrupted cancel was sweeping — still on disk (cleanup
  // never deletes it, and a SIGKILL mid-sweep certainly doesn't).
  const runDir = path.join(resultsDir, 'agent', `svc-${planId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const recordPath = path.join(runDir, CREATED_RECORD_FILENAME);
  fs.writeFileSync(recordPath, JSON.stringify({ created: [{ temp_id: 'e1', key: 'PROJ-777', type: 'Epic', summary: 'x' }], links: [] }, null, 2));

  // Simulate a plan that was mid-cancel when the process died: write its
  // state file directly, exactly as state.mjs would have left it on disk.
  const plansDir = path.join(resultsDir, 'service', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, `${planId}.json`), JSON.stringify({
    plan_id: planId,
    status: 'cancelling',
    requester: 'test-requester',
    description: 'mid-cancel when the process died',
    role_lens: 'business',
    mode: 'front_door',
    cost_usd: 1.7,
    created: { keys: ['PROJ-777'], items: [{ temp_id: 'e1', key: 'PROJ-777', type: 'Epic', summary: 'x' }], record_path: recordPath, verify_ok: true },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, null, 2));

  // A brand new server booting over the same results dir (as if restarted).
  const app = createServer();
  const addr = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const view = await getJson(baseUrl, `/plan/${planId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.status, 'failed', 'cancelling is transient — an interrupted cancel reloads honestly as failed');
  assert.equal(view.body.error, 'interrupted by restart');
  assert.ok(view.body.created, 'the created marker survives the crash-resume');
  assert.equal(view.body.created.record_path, recordPath);
  assert.deepEqual(view.body.created.keys, ['PROJ-777']);
  assert.notEqual(view.body.created.cancelled, true, 'an interrupted cancel must never claim success');

  // The whole point of the failed reload: failed + record → the Cancel
  // button is back, and a re-click sweeps to completion.
  const again = await postJson(baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(again.status, 202);
  assert.equal(again.body.status, 'cancelling');
  const done = await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'cancelling');
  assert.equal(done.body.status, 'cancelled');
  assert.equal(done.body.created.cancelled, true);
  assert.match(done.body.agent_summary, /1 issue\(s\) transitioned/);
});
