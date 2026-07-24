// cancel-interplay.test.mjs — cancel flow adversarial edges: the cancel flow↔retry write guard interplay in
// BOTH directions, CAS races, the worker catch path, crash-resume retry
// safety, and the 409 wording matrix.
//
// Why a separate file (not cancel.test.mjs): `node --test` runs each test
// FILE in its own child process, so the knobs this file flips
// (MERCURY_FAKE_VERIFY_FAIL, MERCURY_FAKE_CREATE_PARTIAL,
// MERCURY_FAKE_CLEANUP_FAIL, MERCURY_DAILY_HARD_USD) are process-isolated
// from cancel.test.mjs and retry-guard.test.mjs running concurrently. Within
// this file, top-level tests run sequentially and every env mutation is
// restored by ctx.close() / t.after (house pattern).
//
// Two techniques beyond the retry write guard suite:
//   1. GATED ENGINE — createServer({ resultsDir, engine }) (the documented
//      test seam) with an engine whose verify/cleanup block on a promise the
//      test releases. This holds a plan deterministically in `creating` /
//      `cancelling` so races and mid-flight 409s are exact, not timing luck.
//   2. SENTINEL (from retry-guard.test.mjs) — an extra `"sentinel":"x"`
//      field read-modify-written into the on-disk record. ANY re-run of
//      create rewrites that file from scratch, so the sentinel surviving is
//      on-disk proof no second create ever ran. verify and cleanup never
//      write the record, so the sentinel must survive every path here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { createEngine, CREATED_RECORD_FILENAME } from '../engine.mjs';

// -- shared scaffolding (same shapes as cancel.test.mjs / retry-guard) -------

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

function runRecordPath(ctx, planId) {
  return path.join(ctx.resultsDir, 'agent', `svc-${planId}`, CREATED_RECORD_FILENAME);
}

function injectSentinel(recordPath) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.sentinel = 'x';
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function readSentinel(recordPath) {
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')).sentinel;
}

function settleOutOf(baseUrl, planId, transientStatus) {
  return pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== transientStatus);
}

/** Deferred the tests use to hold a gated engine call open. */
function makeGate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

/**
 * A fake engine wrapper with per-method call counters and optional gates:
 * a gated verify/cleanup parks until its gate is released, then returns ok
 * — which lets a test hold a plan in `creating`/`cancelling` for as long as
 * the assertions need. Ungated methods delegate to the real fake engine
 * (so the MERCURY_FAKE_* knobs still steer create/phase1/groom).
 */
function makeCountingEngine({ gateVerify, gateCleanup, rejectCleanupOnce } = {}) {
  const fake = createEngine('fake');
  const calls = { create: 0, verify: 0, cleanup: 0 };
  return {
    calls,
    phase1: (a) => fake.phase1(a),
    groom: (a) => fake.groom(a),
    search: (a) => fake.search(a),
    async create(a) {
      calls.create += 1;
      return fake.create(a);
    },
    async verify(a) {
      calls.verify += 1;
      if (gateVerify) {
        await gateVerify.promise;
        return { ok: true, output: '[gated] verify OK' };
      }
      return fake.verify(a);
    },
    async cleanup(a) {
      calls.cleanup += 1;
      if (rejectCleanupOnce && calls.cleanup === 1) {
        // Mirrors the REAL engine's only reject path: runToolSpawn REJECTS
        // on spawn failure/timeout (a non-zero exit merely resolves
        // ok:false) — runCancelWorker's catch must own this.
        throw new Error('[fake] cleanup spawn failed');
      }
      if (gateCleanup) {
        await gateCleanup.promise;
        return { ok: true, output: '[gated] cleanup OK' };
      }
      return fake.cleanup(a);
    },
  };
}

/** Boots a fake createServer on a fresh tmp root — no env dependence except
 * its explicit fake-only MERCURY_SKIP_PLAN_ANCHORS whole-plan-gate skip. */
async function startEngineServer(engine) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-cancel-interplay-'));
  const prevAnchors = process.env.MERCURY_SKIP_PLAN_ANCHORS;
  process.env.MERCURY_SKIP_PLAN_ANCHORS = '1';
  const app = createServer({ resultsDir, engineMode: 'fake', engine });
  const addr = await app.listen(0, '127.0.0.1');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    resultsDir,
    app,
    async close() {
      await app.close();
      if (prevAnchors === undefined) delete process.env.MERCURY_SKIP_PLAN_ANCHORS;
      else process.env.MERCURY_SKIP_PLAN_ANCHORS = prevAnchors;
      fs.rmSync(resultsDir, { recursive: true, force: true });
    },
  };
}

/** Sets an env var for the duration of one test, restoring via t.after. */
function setEnv(t, key, value) {
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  if (value === undefined) delete process.env[key];
  else process.env[key] = String(value);
}

// -----------------------------------------------------------------------------
// retry write guard -> cancel flow: a plan mid-`creating` (verify-only recovery running) cannot be
// cancelled out from under its worker.
// -----------------------------------------------------------------------------

test('interplay: cancel during a mid-flight retry write guard verify-only recovery — clean 409, recovery completes to created unharmed', async (t) => {
  const gateVerify = makeGate();
  const engine = makeCountingEngine({ gateVerify });
  const ctx = await startEngineServer(engine);
  t.after(() => ctx.close());

  // Stage case A: create completes but the post-create verify reads red —
  // failed WITH the created marker (the knob steers the delegated fake).
  setEnv(t, 'MERCURY_FAKE_VERIFY_FAIL', '1');
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  const recordPath = failed.body.created.record_path;
  injectSentinel(recordPath);
  process.env.MERCURY_FAKE_VERIFY_FAIL = '0'; // the setEnv above restores on exit

  // Retry routes retry write guard case A: 202 creating, worker parked on the verify gate.
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'creating');
  await pollUntil(() => engine.calls.verify, (n) => n >= 1);
  const mid = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(mid.body.status, 'creating', 'the recovery is genuinely mid-flight');

  // The attack: cancel while the recovery worker is running.
  const refused = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(refused.status, 409, 'cancel must not preempt a running worker');
  assert.match(refused.body.error, /cancel is only valid from created or failed/);
  assert.equal(refused.body.status, 'creating');
  const after = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(after.body.status, 'creating', 'the refused cancel must not move the plan');

  // Release the gate: the recovery heals to created exactly as if the cancel
  // attempt had never happened.
  gateVerify.release();
  const healed = await settleOutOf(ctx.baseUrl, planId, 'creating');
  assert.equal(healed.body.status, 'created', 'the recovery completes unharmed');
  assert.equal(healed.body.created.verify_ok, true);
  assert.equal(healed.body.error, undefined);
  assert.equal(engine.calls.cleanup, 0, 'no cleanup sweep ever started');
  assert.equal(engine.calls.create, 1, 'only the original create ever ran');
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched');
});

// -----------------------------------------------------------------------------
// cancel flow -> retry write guard: a plan mid-`cancelling` refuses BOTH retry and a second cancel.
// -----------------------------------------------------------------------------

test('interplay: retry and second-cancel during a mid-flight sweep — both 409, sweep completes to cancelled', async (t) => {
  const gateCleanup = makeGate();
  const engine = makeCountingEngine({ gateCleanup });
  const ctx = await startEngineServer(engine);
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');

  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202);
  await pollUntil(() => engine.calls.cleanup, (n) => n >= 1);
  const mid = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(mid.body.status, 'cancelling', 'the sweep is genuinely mid-flight');

  // Retry mid-cancelling: 409 (retry is only legal from failed).
  const retryRefused = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retryRefused.status, 409);
  assert.match(retryRefused.body.error, /retry is only valid from failed/);
  assert.equal(retryRefused.body.status, 'cancelling');

  // Second cancel mid-cancelling (the realistic Slack double-click): 409.
  const cancelRefused = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancelRefused.status, 409);
  assert.match(cancelRefused.body.error, /cancel is only valid from created or failed/);
  assert.equal(cancelRefused.body.status, 'cancelling');

  gateCleanup.release();
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(engine.calls.cleanup, 1, 'the refused clicks never spawned a second sweep');
});

// -----------------------------------------------------------------------------
// CAS race: two concurrent cancels — exactly one wins, exactly one sweep.
// -----------------------------------------------------------------------------

test('race: two concurrent POST /cancel — exactly one 202 and one 409; exactly one sweep runs', async (t) => {
  const gateCleanup = makeGate();
  const engine = makeCountingEngine({ gateCleanup });
  const ctx = await startEngineServer(engine);
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  // The gate guarantees the first winner's worker CANNOT finish before the
  // second request lands — this is a true concurrent-window race, not a
  // sequential re-click.
  const [a, b] = await Promise.all([
    postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {}),
    postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {}),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409], 'exactly one CAS winner');
  const winner = a.status === 202 ? a : b;
  assert.equal(winner.body.status, 'cancelling');
  assert.equal(engine.calls.cleanup, 1, 'the loser never reached the worker — one sweep, not two');

  gateCleanup.release();
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(engine.calls.cleanup, 1, 'still exactly one sweep after settling');
  assert.ok(fs.existsSync(recordPath), 'the record survives the race');
});

// -----------------------------------------------------------------------------
// CAS race: cancel vs retry from failed-with-record — whichever wins, the
// loser 409s, no re-create happens, and the final state is coherent.
// -----------------------------------------------------------------------------

test('race: concurrent cancel + retry from failed-with-record — one 202/one 409, never a re-create, coherent terminal state', async (t) => {
  const gateVerify = makeGate();
  const gateCleanup = makeGate();
  const engine = makeCountingEngine({ gateVerify, gateCleanup });
  const ctx = await startEngineServer(engine);
  t.after(() => ctx.close());

  // Stage case A failed-with-record (the only status where BOTH buttons are
  // live on the same Slack message — this race is one user away).
  setEnv(t, 'MERCURY_FAKE_VERIFY_FAIL', '1');
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  const recordPath = failed.body.created.record_path;
  injectSentinel(recordPath);
  process.env.MERCURY_FAKE_VERIFY_FAIL = '0'; // the setEnv above restores on exit

  const [cancelRes, retryRes] = await Promise.all([
    postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {}),
    postJson(ctx.baseUrl, `/plan/${planId}/retry`, {}),
  ]);
  assert.deepEqual([cancelRes.status, retryRes.status].sort(), [202, 409], 'exactly one CAS winner');
  const cancelWon = cancelRes.status === 202;
  if (cancelWon) assert.equal(cancelRes.body.status, 'cancelling');
  else assert.equal(retryRes.body.status, 'creating');

  gateVerify.release();
  gateCleanup.release();
  const final = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'cancelling' && r.body.status !== 'creating',
  );

  if (cancelWon) {
    assert.equal(final.body.status, 'cancelled', 'cancel won → the tree is cancelled');
    assert.equal(final.body.created.cancelled, true);
    assert.equal(engine.calls.verify, 0, 'the losing retry never started its worker');
  } else {
    assert.equal(final.body.status, 'created', 'retry won → retry write guard case A heals (verify-only)');
    assert.equal(final.body.created.verify_ok, true);
    assert.equal(engine.calls.cleanup, 0, 'the losing cancel never started its sweep');
  }
  assert.equal(engine.calls.create, 1, 'NEVER a second create — whichever side wins');
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — on-disk proof of no re-create');
});

// -----------------------------------------------------------------------------
// cancel flow -> retry write guard: after a FAILED cancel the marker is intact, so Retry routes the
// retry write guard — case A (full record) heals, case B (partial) stays blocked.
// -----------------------------------------------------------------------------

test('after a failed cancel, retry routes retry write guard case A: verify-only heal to created, no --live re-create; cancel-again then completes', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1', MERCURY_FAKE_CLEANUP_FAIL: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202);
  const failedCancel = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(failedCancel.body.status, 'failed');
  assert.equal(failedCancel.body.created.partial, undefined, 'a full-record marker is case A territory');
  injectSentinel(recordPath);
  process.env.MERCURY_FAKE_CLEANUP_FAIL = '0'; // ctx.close() restores

  // Retry from the failed-cancel message: the README-documented "safe but
  // confusing" path — retry write guard case A re-reads the (readable) tree and heals to
  // `created`. The load-bearing property is what does NOT happen: no
  // create-tree --live re-run.
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'creating', 'the retry write guard owns this retry — verify-only');
  const healed = await settleOutOf(ctx.baseUrl, planId, 'creating');
  assert.equal(healed.body.status, 'created', 'case A heal — documented cancel flow/retry write guard non-goal, safe because verify never writes');
  assert.equal(healed.body.created.verify_ok, true);
  assert.notEqual(healed.body.created.cancelled, true, 'a heal must not resurrect a cancel claim');
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');

  // And the created message's Cancel button still works: cancel-again is the
  // README's actual recommendation — it completes the undo.
  const cancelAgain = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancelAgain.status, 202);
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(readSentinel(recordPath), 'x', 'cleanup never rewrites the record');
});

test('full circle, case B: retry write guard partial block -> failed cancel -> retry STILL blocked (no re-create) -> cancel-again -> cancelled with partial:true AND cancelled:true', async (t) => {
  const ctx = await startTestServer({
    MERCURY_SKIP_PLAN_ANCHORS: '1',
    MERCURY_FAKE_CREATE_PARTIAL: '1',
    // Not set yet — listed so ctx.close() restores whatever we set mid-test.
    MERCURY_FAKE_CLEANUP_FAIL: undefined,
  });
  t.after(() => ctx.close());

  // Stage retry write guard's surfaced partial tree (matrix item 3): create dies mid-tree,
  // then the first retry plants the durable partial:true marker.
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  process.env.MERCURY_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores
  const firstRetry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(firstRetry.status, 202);
  const blocked = await settleOutOf(ctx.baseUrl, planId, 'creating');
  assert.equal(blocked.body.status, 'failed');
  assert.equal(blocked.body.created.partial, true);
  const recordPath = blocked.body.created.record_path;
  injectSentinel(recordPath);

  // The cancel sweep fails (network down mid-undo).
  process.env.MERCURY_FAKE_CLEANUP_FAIL = '1'; // ctx.close() restores
  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202);
  const failedCancel = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(failedCancel.body.status, 'failed');
  assert.equal(failedCancel.body.created.partial, true, 'the failed cancel must not drop the partial fact');
  assert.notEqual(failedCancel.body.created.cancelled, true);

  // Retry from here must route retry write guard case B (partial:true) — blocked, never a
  // re-create. This is the exact chain a confused user produces by clicking
  // Retry instead of the recommended Cancel-again.
  process.env.MERCURY_FAKE_CLEANUP_FAIL = '0';
  const retryBlocked = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retryBlocked.status, 202);
  const stillBlocked = await settleOutOf(ctx.baseUrl, planId, 'creating');
  assert.equal(stillBlocked.body.status, 'failed', 'a partial tree is NEVER promoted, even after a failed cancel');
  assert.match(stillBlocked.body.error, /already wrote 1 issue\(s\) to Jira/);
  assert.equal(stillBlocked.body.created.partial, true);
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');

  // Cancel-again completes the circle: BOTH durable facts on the marker.
  const cancelAgain = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancelAgain.status, 202);
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.created.partial, true, 'partial:true preserved for audit');
  assert.equal(cancelled.body.created.cancelled, true, 'cancelled:true is the new durable fact');
  assert.deepEqual(cancelled.body.created.keys, ['PROJ-999']);
  assert.ok(fs.existsSync(recordPath), 'the record survives the whole circle');
  assert.equal(readSentinel(recordPath), 'x');
});

// -----------------------------------------------------------------------------
// Terminal `cancelled`: both buttons are dead — retry AND cancel 409.
// -----------------------------------------------------------------------------

test('cancelled is fully terminal: retry -> 409 and cancel-again -> 409, plan unmoved', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202);
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');

  const retryRefused = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retryRefused.status, 409, 'a cancelled tree is not retryable');
  assert.match(retryRefused.body.error, /retry is only valid from failed/);
  assert.equal(retryRefused.body.status, 'cancelled');

  const cancelRefused = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancelRefused.status, 409, 'a cancelled tree is not re-cancellable');
  assert.equal(cancelRefused.body.status, 'cancelled');

  const after = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(after.body.status, 'cancelled', 'neither refusal moved the plan');
  assert.equal(after.body.created.cancelled, true);
});

// -----------------------------------------------------------------------------
// Worker catch path: engine.cleanup REJECTS (spawn failure/timeout — the real
// engine's only throw path). The catch lands `failed`, marker intact,
// re-click recovers.
// -----------------------------------------------------------------------------

test('cleanup REJECTS (spawn failure): worker catch lands failed, marker intact, re-cancel completes', async (t) => {
  const engine = makeCountingEngine({ rejectCleanupOnce: true });
  const ctx = await startEngineServer(engine);
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202);
  const failed = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(failed.body.status, 'failed', 'a rejecting cleanup lands failed via the worker catch — never a hang, never a false cancelled');
  // The catch path composes the SAME Slack discipline as the ok:false
  // path: re-click guidance + the runnable --cleanup command first (inside
  // terminalMessage's 500-char window), the raw spawn error last.
  assert.ok(
    failed.body.error.startsWith('cancel failed — the tree may be only partially cancelled.'),
    'the reject path leads with the honest partial-cancel warning',
  );
  assert.ok(
    failed.body.error.slice(0, 500).includes(`Click "Cancel tree" again or run: node tools/create-tree.mjs --cleanup ${recordPath} --live`),
    'the re-click guidance + full cleanup command survive the 500-char Slack truncation on the reject path too',
  );
  assert.match(failed.body.error, /cleanup spawn failed/, 'the raw spawn failure is still surfaced (last)');
  assert.equal(failed.body.agent_summary, undefined, 'the create-era summary is cleared on the reject path too');
  assert.ok(failed.body.created, 'the catch path must not touch the marker');
  assert.equal(failed.body.created.record_path, recordPath);
  assert.notEqual(failed.body.created.cancelled, true, 'an exploded sweep must never claim success');
  assert.ok(fs.existsSync(recordPath), 'the record survives the rejected sweep');

  // The whole point of leaving the marker: the re-click sweeps to completion.
  const again = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(again.status, 202);
  const cancelled = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.created.cancelled, true);
  assert.equal(engine.calls.cleanup, 2, 'exactly the reject and the successful re-run');
});

// -----------------------------------------------------------------------------
// Sweep over a missing record file: honest failure, never a false cancelled.
// -----------------------------------------------------------------------------

test('cancel with the record file deleted from disk: lands failed with guidance — never a false cancelled', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');
  const recordPath = done.body.created.record_path;

  // A human deleted the record out-of-band. The marker still says a real
  // tree exists — the cancel must run and report the sweep's failure
  // honestly (the real create-tree --cleanup exits non-zero on a missing
  // record; the fake mirrors that as ok:false).
  fs.rmSync(recordPath);

  const cancel = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(cancel.status, 202, 'the marker is the precondition — the file check is the sweep\'s job');
  const failed = await settleOutOf(ctx.baseUrl, planId, 'cancelling');
  assert.equal(failed.body.status, 'failed', 'a sweep that could not read its record must not claim cancelled');
  assert.ok(failed.body.error.startsWith('cancel failed — the tree may be only partially cancelled.'));
  assert.match(failed.body.error, /record not found/, 'the sweep\'s own diagnosis is surfaced in the tail');
  assert.equal(failed.body.created.record_path, recordPath, 'marker untouched — Cancel stays re-clickable');
  assert.notEqual(failed.body.created.cancelled, true);
});

// -----------------------------------------------------------------------------
// Crash-resume, the RETRY leg (cancel.test.mjs owns the cancel leg): an
// interrupted cancel reloads as failed and Retry routes verify-only.
// -----------------------------------------------------------------------------

test('crash-resume: after an interrupted cancel, RETRY routes retry write guard verify-only — heals to created, record byte-untouched, no re-create', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-cancel-resume-retry-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

  const planId = '99999999-9999-4999-8999-999999999999';

  // The record the interrupted cancel was sweeping — sentinel baked in, so
  // any re-create (which rewrites the file from scratch) is provable.
  const runDir = path.join(resultsDir, 'agent', `svc-${planId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const recordPath = path.join(runDir, CREATED_RECORD_FILENAME);
  fs.writeFileSync(recordPath, JSON.stringify({ created: [{ temp_id: 'e1', key: 'PROJ-888', type: 'Epic', summary: 'x' }], links: [], sentinel: 'x' }, null, 2));

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
    created: { keys: ['PROJ-888'], items: [{ temp_id: 'e1', key: 'PROJ-888', type: 'Epic', summary: 'x' }], record_path: recordPath, verify_ok: true },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, null, 2));

  // Fresh boot over the same results dir — options-injected, zero env.
  const app = createServer({ resultsDir, engine: createEngine('fake') });
  const addr = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const view = await getJson(baseUrl, `/plan/${planId}`);
  assert.equal(view.body.status, 'failed');
  assert.equal(view.body.error, 'interrupted by restart');

  // The OTHER live button after an interrupted cancel: Retry. It must route
  // retry write guard case A (marker present, partial !== true) — read-only, promote-safe.
  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'creating', 'verify-only recovery, not a create ladder re-entry');
  const healed = await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(healed.body.status, 'created', 'the readable tree heals — safe because verify never writes');
  assert.equal(healed.body.created.verify_ok, true);
  assert.deepEqual(healed.body.created.keys, ['PROJ-888'], 'keys from the original create preserved');
  assert.notEqual(healed.body.created.cancelled, true, 'an interrupted cancel must never claim success, even through a heal');
  assert.equal(healed.body.error, undefined);
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO re-create after the crash');
});

// -----------------------------------------------------------------------------
// 409 wording matrix: budget_blocked / rejected / stale markers / empty path.
// -----------------------------------------------------------------------------

test('409 wording: budget_blocked — no-record refusal, and illegal-transition refusal even with a stale marker planted', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1', MERCURY_DAILY_HARD_USD: '0' });
  t.after(() => ctx.close());

  // The $0 hard cap blocks the very first phase — terminal budget_blocked,
  // no Jira write ever attempted.
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const blocked = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  assert.equal(blocked.body.status, 'budget_blocked');

  const noRecord = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(noRecord.status, 409);
  assert.equal(noRecord.body.error, 'no created record to cancel', 'the record check fires first — nothing on the board');
  assert.equal(noRecord.body.status, 'budget_blocked');

  // Adversarial: plant a stale marker directly in state (no legal flow puts
  // one on a budget_blocked plan — this pins the STATUS check as the second
  // gate, so a marker alone can never open cancel from a non-cancellable
  // status). _state is the server's documented test seam.
  ctx.app._state.update(planId, { created: { keys: ['PROJ-1'], items: [], record_path: '/tmp/stale-record.json', verify_ok: false } });
  const staleMarker = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(staleMarker.status, 409);
  assert.match(staleMarker.body.error, /cancel is only valid from created or failed/);
  assert.equal(staleMarker.body.status, 'budget_blocked');
  const after = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(after.body.status, 'budget_blocked', 'refusals never move the plan');
});

test('409 wording: rejected — no-record refusal, and illegal-transition refusal with a stale marker; rejection is a human decision, not undoable-by-cancel', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  const rejected = await postJson(ctx.baseUrl, `/plan/${planId}/reject`, { reason: 'not this quarter' });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, 'rejected');

  const noRecord = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(noRecord.status, 409);
  assert.equal(noRecord.body.error, 'no created record to cancel');
  assert.equal(noRecord.body.status, 'rejected');

  ctx.app._state.update(planId, { created: { keys: ['PROJ-2'], items: [], record_path: '/tmp/stale-record.json', verify_ok: false } });
  const staleMarker = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(staleMarker.status, 409);
  assert.match(staleMarker.body.error, /cancel is only valid from created or failed/);
  assert.equal(staleMarker.body.status, 'rejected');
});

test('409 falsy-record edge: created plan whose marker carries record_path:"" is refused as no-record — the falsy check holds', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, settled: done } = await driveThroughCreate(ctx);
  assert.equal(done.body.status, 'created');

  // Corrupt the marker's path to the empty string (a bug or bad migration
  // could produce this). `!recordPath` must catch it: an empty path names
  // nothing on the board, and letting it through would hand engine.cleanup
  // a meaningless '' to sweep.
  ctx.app._state.update(planId, { created: { ...ctx.app._state.get(planId).created, record_path: '' } });

  const refused = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'no created record to cancel', 'empty-string path is treated as no record, not swept');
  assert.equal(refused.body.status, 'created');
  const after = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(after.body.status, 'created', 'the refused cancel must not move the plan');
});
