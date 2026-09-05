// regen-loop.test.mjs — B1 (gate-complaint bounded regeneration) + the
// friendly-failure-display fixes.
//
// House pattern: zero network, the createServer({engine,resultsDir}) seam, the
// REAL treecheck skeleton gate (a regen must be driven by the genuine
// deterministic verdict, not a stub of it). Each test injects a custom fake
// engine that writes a chosen skeleton/plan per call and RECORDS its args, so
// the exact wire — which session a regen resumes, which complaint it carries,
// how many calls happen — is assertable without ever spawning `claude`.
//
// The suite command starts a fake engine with RADSVINN_SKIP_PLAN_ANCHORS=1.
// createServer translates that legacy knob into a whole-PLAN-gate skip (the
// skeleton gate always runs), so phase1 tests are unaffected and the
// groom-mirror test deletes it locally to exercise a real plan-gate failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import {
  buildCheckerComplaintsBlock,
  firstFailingComplaint,
  describeSkeletonGateFailure,
  describePlanGateFailure,
} from '../server.mjs';
import { createEngine, phase1Message, groomMessage } from '../engine.mjs';
import { RADSVINN_ROOT, plansDir, agentRunDir } from '../state.mjs';

// -- fixtures -----------------------------------------------------------------

const GOOD_SKELETON = JSON.parse(
  fs.readFileSync(path.join(RADSVINN_ROOT, 'fixtures', 'e2e-sample', 'skeleton.json'), 'utf8'),
);

// A valid-contract multi-item skeleton with a hard dependency cycle. It drives
// a real regeneration while deliberately avoiding the advisory tree-width
// conventions (max leaves/subtasks) exercised elsewhere.
function badCycleSkeleton() {
  const s = JSON.parse(JSON.stringify(GOOD_SKELETON));
  s.items[0].depends_on = ['i2']; // fixture i2 already depends on i1
  return s;
}

// A contract-invalid plan.json (missing every required key) → the plan gate
// hard-fails at the contract check, no grounding repos needed.
const CONTRACT_INVALID_PLAN = { plan_id: 'x' };

// A minimal, self-contained VALID plan.json — one standalone Task with ZERO
// code anchors. Deliberately NOT the e2e-sample plan.json fixture: that one
// cites real web-app file paths, which only resolve against a real
// grounding checkout under reposRoot() (internal/checks/precheck.go
// checkAnchorsExist) — not present in an isolated test env, so the real gate
// would hard-fail it on anchors_exist for reasons unrelated to what these
// tests are proving. Zero code_anchors is a documented NON-BLOCKING FLAG only
// on MULTI-item plans (precheck.go's zero-anchor guard); a single
// standalone item with no children sails through every check (plan_structure,
// hierarchy_legal, fields_present, single_repo, anchors_exist,
// anchor_consistency, zone_routing, sizing_bounds) clean, so this reaches a
// genuine ok:true under the REAL treecheck binary with zero external repo
// dependencies.
function goodPlan() {
  return {
    plan_id: 'x',
    requester: 'test-requester',
    role_lens: 'business',
    mode: 'front_door',
    epic: null,
    milestones: [],
    items: [{
      temp_id: 'i1',
      type: 'Task',
      parent_temp_id: null,
      depends_on: [],
      milestone_id: null,
      repo: 'web-app',
      effort_tier: 'low',
      predicted_cost_usd: 3.0,
      fields: {
        why: 'a real reason this ticket exists',
        related_links: { external: [], code_anchors: [] },
        definition_of_done: 'a concrete, checkable finish line',
        technical_analysis: {
          prose: 'a short technical approach',
          affected_repos: ['web-app'],
          coupling_zones: ['none'],
          tier1_decomposition: 'single-repo-sequenced',
          read_only_repos: [],
        },
        acceptance_criteria: ['it works as described'],
      },
    }],
  };
}

// -- engine recorders ---------------------------------------------------------

// A phase1 engine that writes `skeletonFor(callIndex)` to skeleton.json each
// call and records the args it received (including `regen`). sessionIds are
// deterministic (`sess-<idx>`) so a resume can be asserted by value.
function phase1Recorder(skeletonFor) {
  const calls = [];
  const engine = {
    ...createEngine('fake'),
    async phase1(args) {
      const idx = calls.length;
      calls.push(args);
      fs.mkdirSync(args.runDir, { recursive: true });
      const skel = typeof skeletonFor === 'function' ? skeletonFor(idx) : skeletonFor;
      fs.writeFileSync(path.join(args.runDir, 'skeleton.json'), JSON.stringify(skel, null, 2));
      return { sessionId: `sess-${idx}`, costUsd: 0.8, resultText: `decompose ${idx}`, durationMs: 0, numTurns: 1, model: 'fake' };
    },
  };
  return { engine, calls };
}

// phase1 = default fake (fixture skeleton → shape_ready); groom writes a
// contract-invalid plan.json each call and records its args (including
// regenComplaints).
function groomRecorder(planFor) {
  const calls = [];
  const engine = {
    ...createEngine('fake'),
    async groom(args) {
      const idx = calls.length;
      calls.push(args);
      fs.mkdirSync(args.runDir, { recursive: true });
      const plan = typeof planFor === 'function' ? planFor(idx) : planFor;
      fs.writeFileSync(path.join(args.runDir, 'plan.json'), JSON.stringify(plan, null, 2));
      return { sessionId: `groom-${idx}`, costUsd: 0.9, resultText: `groom ${idx}`, durationMs: 0, numTurns: 1, model: 'fake' };
    },
  };
  return { engine, calls };
}

// Groom variant that records args but writes NO plan.json at all — gatePlan's
// readFile then hits ENOENT, its own "cannot read plan.json" catch path
// (gates.mjs), which returns {ok:false, raw:{error:...}} carrying NO
// regen_complaint (buildCheckerComplaintsBlock -> undefined): the loop's own
// "nothing actionable to fix" give-up, mirroring the phase1 spawn-failure
// test (#4 above) on the groom side.
function groomRecorderNoPlan() {
  const calls = [];
  const engine = {
    ...createEngine('fake'),
    async groom(args) {
      const idx = calls.length;
      calls.push(args);
      fs.mkdirSync(args.runDir, { recursive: true });
      return { sessionId: `groom-${idx}`, costUsd: 0.9, resultText: `groom ${idx}`, durationMs: 0, numTurns: 1, model: 'fake' };
    },
  };
  return { engine, calls };
}

// Boots a server on a fresh tmp results dir with the given engine, applying (and
// restoring) any env overrides. `undefined` in envOverrides DELETES the var.
async function startWithEngine(t, engine, envOverrides = {}) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-regen-'));
  const prevEnv = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });
  return { baseUrl, resultsDir };
}

// ---------------------------------------------------------------------------
// 1. gate-fail-then-fix
// ---------------------------------------------------------------------------

test('gate-fail-then-fix: 2 calls; call2 carries the gate complaint + RESUMES call1 session; final shape_ready; regen_counts.phase1===1', async (t) => {
  const { engine, calls } = phase1Recorder((idx) => (idx === 0 ? badCycleSkeleton() : GOOD_SKELETON));
  const { baseUrl } = await startWithEngine(t, engine);

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'shape_ready', 'the fixed second attempt reaches shape_ready');
  assert.equal(calls.length, 2, 'exactly one regeneration → two decompose calls');
  assert.equal(calls[0].regen, undefined, 'the first call is a fresh decompose — no regen context');
  assert.match(calls[1].regen.complaintsBlock, /depends_on cycle/, 'call2 carries call1 gate complaint');
  assert.equal(calls[1].regen.sessionId, 'sess-0', 'call2 RESUMES the failed session from call1');
  assert.equal(done.body.regen_counts.phase1, 1, 'one regeneration recorded');
});

test('allowlisted skeleton output_language reaches shape_ready with an auditable WARN and never overrides the request language', async (t) => {
  const withCompatibilityMetadata = { ...GOOD_SKELETON, output_language: 'tr' };
  const { engine, calls } = phase1Recorder(() => withCompatibilityMetadata);
  const { baseUrl } = await startWithEngine(t, engine);

  const created = await postJson(baseUrl, '/plan', {
    description: 'x'.repeat(50),
    requester: 'test-requester',
    output_language: 'en',
  });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'shape_ready', 'the exact allowlisted metadata must not trigger a regeneration');
  assert.equal(calls.length, 1, 'compatibility metadata is non-blocking, never an extra LLM attempt');
  assert.equal(done.body.output_language, 'en', 'the persisted request language remains authoritative');
  assert.equal(done.body.skeleton.output_language, 'tr', 'the emitted metadata stays visible in the saved skeleton');
  const audit = done.body.skeleton_gate.raw.checks.output_language_metadata;
  assert.equal(audit.pass, true);
  assert.match(audit.complaints.join('\n'), /accepted as allowlisted compatibility metadata/);
});

// ---------------------------------------------------------------------------
// 2. N=2 bound  (MUTATION GUARD: MAX_REGEN_ATTEMPTS / the `exhausted` check)
// ---------------------------------------------------------------------------

test('N=2 bound: a permanently-failing decompose makes 3 calls then failed; regen_counts.phase1===2', async (t) => {
  const { engine, calls } = phase1Recorder(() => badCycleSkeleton());
  const { baseUrl } = await startWithEngine(t, engine);

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'failed');
  assert.equal(calls.length, 3, 'initial + 2 regens = 3 calls (the N=2 ceiling)');
  assert.equal(done.body.regen_counts.phase1, 2, 'exactly 2 regenerations recorded');
});

// ---------------------------------------------------------------------------
// (Removed) unsatisfiable scope=single — the isUnsatisfiableSizing short-circuit
// is gone (2026-07-13): the leaf-cost cap is an advisory WARN now, so there is
// no sizing×scope hard fail to short-circuit. A too-big-for-scope shape just
// regenerates (bounded by N=2) like any other gate fail.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. spawn-failure  (gates.mjs {spawnError} → nothing to fix → no regen)
// ---------------------------------------------------------------------------

test('gate spawn failure: 1 call, no regen (regen_counts.phase1===0) — an empty complaint is nothing to feed back', async (t) => {
  const { engine, calls } = phase1Recorder(() => GOOD_SKELETON);
  // A bogus treecheck binary makes gateSkeleton return {spawnError} — ok:false
  // with NO regen_complaint, exactly the "nothing actionable to fix" case.
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_TREECHECK_BIN: '/nonexistent/treecheck-xyz' });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'failed');
  assert.equal(calls.length, 1, 'a spawn error yields no complaint to fix — never a wasted regen');
  assert.equal(done.body.regen_counts.phase1, 0);
});

// ---------------------------------------------------------------------------
// 4b. Retry after a NO-COMPLAINT give-up must start a FRESH session, never a
//     blind --resume (reviewer finding #1: a truthy regenCtx wrapping an
//     undefined complaintsBlock would --resume the failed session with zero
//     signal, uncapped across Retries since such give-ups never advance count).
// ---------------------------------------------------------------------------

test('Retry after a no-complaint (spawn-error) give-up starts a FRESH session — not a blind, uncapped resume', async (t) => {
  const { engine, calls } = phase1Recorder(() => GOOD_SKELETON);
  // Bogus treecheck → gateSkeleton spawn-errors (ok:false, NO complaint) on
  // EVERY attempt — the "nothing actionable" give-up path, persisted on failure.
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_TREECHECK_BIN: '/nonexistent/treecheck-xyz' });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const failed = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );
  assert.equal(calls.length, 1, 'first attempt: spawn error → no regen');
  assert.equal(failed.body.regen_counts.phase1, 0, 'a no-complaint give-up never advances the count');

  // Retry: the persisted skeleton_gate is ok:false but carries NO complaint.
  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed' && calls.length >= 2,
    { timeoutMs: 30000 },
  );

  assert.equal(calls.length, 2, 'the retry made exactly one more call');
  assert.equal(
    calls[1].regen, undefined,
    'CRITICAL (finding #1): a no-complaint re-entry is a FRESH session — never a truthy regenCtx that blind --resumes the failed session',
  );
});

// ---------------------------------------------------------------------------
// 5. groom mirror (a groom gate fail → regen threads regenComplaints)
// ---------------------------------------------------------------------------

test('groom mirror: a permanently-failing plan gate regenerates threading regenComplaints, bounded by N=2 (regen_counts.groom===2)', async (t) => {
  const { engine, calls } = groomRecorder(() => CONTRACT_INVALID_PLAN);
  // Delete the global skip so the REAL plan gate runs and hard-fails on the
  // contract (no grounding repos needed for a contract failure).
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_SKIP_PLAN_ANCHORS: undefined });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'failed');
  assert.equal(calls.length, 3, 'initial groom + 2 regens = 3 (the N=2 ceiling mirrored)');
  assert.equal(calls[0].regenComplaints, undefined, 'the first groom is fresh — no complaint');
  assert.match(calls[1].regenComplaints, /missing required key/, 'the regen threads the plan-gate complaint');
  assert.match(calls[2].regenComplaints, /missing required key/, 'and again on the second regen');
  assert.equal(done.body.regen_counts.groom, 2, 'exactly 2 groom regenerations recorded');
});

// ---------------------------------------------------------------------------
// 6. manual retry after exhaustion (reads the persisted count → ONE more call)
// ---------------------------------------------------------------------------

test('manual retry after exhaustion: a failed plan at count 2 does ONE more call, not a fresh 2× loop', async (t) => {
  const { engine, calls } = phase1Recorder(() => badCycleSkeleton());
  const { baseUrl } = await startWithEngine(t, engine);

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const failed = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );
  assert.equal(calls.length, 3, 'the initial loop exhausts at 3 calls');
  assert.equal(failed.body.regen_counts.phase1, 2);

  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(calls.length, 4, 'retry reads the persisted count 2 → exactly ONE more call (never a fresh 2× loop → 6)');
  assert.equal(calls[3].regen.sessionId, 'sess-2', 'the retry resumes the last failed session');
  assert.equal(done.body.regen_counts.phase1, 2, 'the count stays at the ceiling');
});

// ---------------------------------------------------------------------------
// 7. crash-resume mid-loop keeps the count
// ---------------------------------------------------------------------------

test('crash-resume mid-loop: a plan reloaded from a mid-loop transient keeps regen_counts.phase1 and resumes at N', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-regen-crash-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

  // Simulate a process that died mid-loop AFTER one regen: a transient
  // (breaking_down) plan persisted with regen_counts.phase1=1 and a failed
  // skeleton_gate carrying its complaint. load() will honestly reload it as
  // `failed` — preserving every non-status field, including the count.
  const planId = randomUUID();
  const complaint = 'depends_on cycle detected: i1 → i2 → i1';
  const seed = {
    plan_id: planId,
    description: 'x'.repeat(50),
    requester: 'test-requester',
    role_lens: 'business',
    mode: 'front_door',
    output_language: 'en',
    scope_hint: 'auto',
    grounding_hint: 'full',
    status: 'breaking_down',
    cost_usd: 0.8,
    session_id: 'sess-crash',
    run_dir: agentRunDir(planId, resultsDir),
    skeleton: badCycleSkeleton(),
    skeleton_gate: {
      ok: false,
      raw: { ok: false, checks: { acyclic: { pass: false, complaints: [complaint] } }, hard_fail: true, regen_complaint: complaint },
    },
    regen_counts: { phase1: 1 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const dir = plansDir(resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planId}.json`), JSON.stringify(seed, null, 2));

  const { engine, calls } = phase1Recorder(() => badCycleSkeleton());
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => app.close());

  const reloaded = await getJson(baseUrl, `/plan/${planId}`);
  assert.equal(reloaded.body.status, 'failed', 'a transient plan reloads honestly as failed');
  assert.equal(reloaded.body.regen_counts.phase1, 1, 'the mid-loop count survived the reload');

  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  // Resumed at count 1 → 1 more regen then exhaust = 2 calls. A count that
  // RESET to 0 would take 3 calls to exhaust — so 2 proves the count survived.
  assert.equal(calls.length, 2, 'resumed at 1 → exactly 2 more calls to exhaust (a reset-to-0 would be 3)');
  assert.equal(calls[0].regen.sessionId, 'sess-crash', 'the retry resumes the crashed session');
  assert.match(calls[0].regen.complaintsBlock, /depends_on cycle/, 'and carries the persisted complaint');
  assert.equal(done.body.regen_counts.phase1, 2);
});

// ---------------------------------------------------------------------------
// 8. friendly failure display
// ---------------------------------------------------------------------------

test('friendly display: a contract-fail gate → a clean HUMAN sentence, no raw JSON on the user surface', () => {
  // The exact class the owner hit: `id` instead of `temp_id` → contract fail.
  const contractGate = {
    ok: false,
    raw: {
      ok: false,
      checks: { contract_valid: { pass: false, complaints: ['malformed skeleton JSON: json: unknown field "id"'] } },
      hard_fail: true,
      regen_complaint: 'malformed skeleton JSON: json: unknown field "id"',
    },
  };
  const msg = describeSkeletonGateFailure(contractGate, { scope_hint: 'auto' });
  assert.match(msg, /^Radsvinn's draft didn't match the required ticket shape \(a contract error:/, 'a human sentence leads');
  assert.match(msg, /unknown field "id"/, 'the short reason is embedded');
  // Clean-errors (2026-07-13): the returned message is ONLY the human sentence.
  // The raw gate JSON is console.error'd + persisted on plan.skeleton_gate for
  // operators — it must NOT leak into the user-facing string.
  assert.equal(msg.startsWith('skeleton gate failed'), false, 'it is NOT the bare raw JSON');
  assert.doesNotMatch(msg, /skeleton gate failed \(server-side re-verification\)/, 'the raw operator line is NOT on the user surface');
  assert.doesNotMatch(msg, /"checks"|"contract_valid"|"regen_complaint"/, 'no raw gate JSON leaks to the user');
  // The human remedy must survive Slack's 500-char truncation (it leads).
  assert.ok(msg.slice(0, 500).includes("Radsvinn's draft didn't match"), 'the human sentence survives truncation');
});

test('friendly display: a plan-gate hard fail AFTER a non-blocking WARN surfaces the HARD complaint (not truncated away)', () => {
  // The anchor_consistency alphabetical-ordering diagnostic: a huge WARN on a
  // PASSING check sorts first and would fill the 500-char raw window. The real
  // blocker (a failing code_anchors check) must still be surfaced first.
  const bigWarn = `WARN: anchor ordering diagnostic ${'x'.repeat(600)}`;
  const hardComplaint = 't2: code anchor web-app/x.ts:foo does not resolve';
  const planGate = {
    ok: false,
    raw: {
      items: {
        t1: { ok: true, checks: { anchor_consistency: { pass: true, complaints: [bigWarn] } }, hard_fail: false, regen_complaint: bigWarn },
        t2: {
          ok: false,
          checks: {
            anchor_consistency: { pass: true, complaints: [bigWarn] },
            code_anchors: { pass: false, complaints: [hardComplaint] },
          },
          hard_fail: true,
          regen_complaint: `${bigWarn}\n${hardComplaint}`,
        },
      },
      ok: false,
    },
  };
  const msg = describePlanGateFailure(planGate);
  assert.match(msg, /^A ticket failed a required check: t2: code anchor/, 'the hard complaint leads');
  assert.ok(msg.slice(0, 500).includes('does not resolve'), 'the hard complaint survives the 500-char window');
  // firstFailingComplaint must skip the passing check's WARN.
  assert.equal(firstFailingComplaint(planGate), hardComplaint, 'the WARN on a passing check is skipped');
});

// ---------------------------------------------------------------------------
// buildCheckerComplaintsBlock shape-branching  (MUTATION GUARD: empty-block avoidance)
// ---------------------------------------------------------------------------

test('buildCheckerComplaintsBlock branches on the two Verdict shapes — a contract-block is NEVER an empty regen block', () => {
  // Plan mode: {items:{temp_id:Verdict}} — join only the NON-ok items.
  const planShape = {
    raw: {
      items: {
        t1: { ok: false, regen_complaint: 'A: fix this' },
        t2: { ok: true, regen_complaint: 'B: (passed, ignore)' },
      },
      ok: false,
    },
  };
  assert.equal(buildCheckerComplaintsBlock(planShape), 'A: fix this', 'plan mode joins only failing items');

  // Skeleton mode + the collapsed contract-block for EITHER mode: a bare
  // Verdict. This must NOT read as an empty block just because it has no
  // `items` key — the whole point of the shape branch.
  const contractShape = {
    raw: {
      checks: { contract_valid: { pass: false, complaints: ['unknown field "id"'] } },
      regen_complaint: 'unknown field "id"',
    },
  };
  assert.equal(buildCheckerComplaintsBlock(contractShape), 'unknown field "id"', 'a contract-block yields its complaint, never empty');

  // Nothing actionable → undefined (drives the loop's no-complaint short-circuit).
  assert.equal(buildCheckerComplaintsBlock({ raw: { spawnError: 'boom' } }), undefined, 'a spawn error is nothing to fix');
  assert.equal(buildCheckerComplaintsBlock({ raw: { items: { t1: { ok: true, regen_complaint: 'x' } }, ok: true } }), undefined, 'an all-ok items map is empty');
  assert.equal(buildCheckerComplaintsBlock({ raw: { unparsedStdout: '...' } }), undefined, 'unparsed stdout is nothing to fix');
});

// ---------------------------------------------------------------------------
// 9. B2 inside the GROOM loop (mirrors the breakers.test.mjs phase1 proof —
//    the per-plan cap is re-checked on the RUNNING total before every groom
//    call too, not just before phase1's regens)
// ---------------------------------------------------------------------------

test('B2 in the groom loop: the per-plan cap passes call 1, then trips BEFORE the regen call — budget_blocked, no double-charge', async (t) => {
  // phase1 costs 0.8 (fixture skeleton -> shape_ready); groom always writes a
  // contract-invalid plan.json at 0.9/call. With cap=1.5: call 1's PRE-check
  // sees only phase1's 0.8 (< 1.5, proceeds); after call 1, running total is
  // 1.7 (>= 1.5) so the pre-check for the would-be regen call trips — exactly
  // one groom call happens, never a second.
  const { engine, calls } = groomRecorder(() => CONTRACT_INVALID_PLAN);
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_SKIP_PLAN_ANCHORS: undefined, RADSVINN_PLAN_BUDGET_USD: '1.5' });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'budget_blocked' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'budget_blocked', 'the running total trips the cap before the groom regen call');
  assert.equal(calls.length, 1, 'exactly one groom call — the regen was capped, not the N=2 loop');
  assert.equal(done.body.cost_usd, 1.7, 'phase1 (0.8) + the single groom call (0.9) — the blocked attempt is never charged');
  assert.ok(/cap|budget/i.test(done.body.error), 'the error names the cap');
});

// ---------------------------------------------------------------------------
// 10. prompt byte-identical — the fresh-call invariant (phase1Message /
//     groomMessage produce EXACTLY the pre-B1 message when there is no regen
//     context, and inject the named block only when one is present)
// ---------------------------------------------------------------------------

test('phase1Message: with NO regen is byte-identical to the pre-B1 message; a complaint injects `# CHECKER COMPLAINTS` before the Jira-network line', () => {
  const base = { ask: 'do the thing', requester: 'test-requester', roleLens: 'business', runDir: '/tmp/run-x', outputLanguage: 'en' };

  // The absent-key call is the ground truth: this IS what every pre-B1 call
  // produced, and every "no regen" shape below must match it byte-for-byte.
  const noKey = phase1Message({ ...base });
  assert.equal(phase1Message({ ...base, regen: undefined }), noKey, 'an explicit undefined regen is byte-identical to an absent key');
  assert.equal(phase1Message({ ...base, regen: { complaintsBlock: '', sessionId: 'sess-0' } }), noKey, 'an empty complaintsBlock injects nothing');
  assert.equal(phase1Message({ ...base, regen: { complaintsBlock: '   ', sessionId: 'sess-0' } }), noKey, 'a whitespace-only complaintsBlock injects nothing');
  assert.doesNotMatch(noKey, /# CHECKER COMPLAINTS/);

  const withRegen = phase1Message({ ...base, regen: { complaintsBlock: 'i2: leaf exceeds max $10.00', sessionId: 'sess-0' } });
  assert.match(withRegen, /# CHECKER COMPLAINTS/);
  assert.match(withRegen, /Your previous attempt FAILED the deterministic gate/);
  assert.match(withRegen, /i2: leaf exceeds max \$10\.00/);
  // Placement: last among the injected material, right before the tail
  // imperatives — proven against the posture-independent common tail line.
  assert.ok(withRegen.indexOf('# CHECKER COMPLAINTS') < withRegen.indexOf('Do not attempt any Jira network calls'),
    '# CHECKER COMPLAINTS precedes the tail imperatives');
  assert.ok(withRegen.indexOf('# COUPLING MAP') < withRegen.indexOf('# CHECKER COMPLAINTS'),
    '# CHECKER COMPLAINTS sits after the coupling map, not before it');
  // Everything before the injected block (language, tools, scope, grounding,
  // the ask, requester/role-lens) is unaffected — a regen call composes the
  // complaint block ALONGSIDE the fresh-call message, never rewrites it.
  assert.equal(
    withRegen.slice(0, withRegen.indexOf('# COUPLING MAP')),
    noKey.slice(0, noKey.indexOf('# COUPLING MAP')),
    'the message prefix up through the coupling map heading is untouched by regen',
  );
});

test('groomMessage: with NO regenComplaints is byte-identical to the pre-B1 message; a complaint injects `# CONTRACT FEEDBACK` after `Shape APPROVED`', () => {
  const base = { edited: false, runDir: '/tmp/run-x', outputLanguage: 'en' };

  const noKey = groomMessage({ ...base });
  assert.equal(groomMessage({ ...base, regenComplaints: undefined }), noKey, 'an explicit undefined regenComplaints is byte-identical to an absent key');
  assert.equal(groomMessage({ ...base, regenComplaints: '' }), noKey, 'an empty regenComplaints injects nothing');
  assert.equal(groomMessage({ ...base, regenComplaints: '   ' }), noKey, 'a whitespace-only regenComplaints injects nothing');
  assert.doesNotMatch(noKey, /# CONTRACT FEEDBACK/);

  const withRegen = groomMessage({ ...base, regenComplaints: 'missing required key "items"' });
  assert.match(withRegen, /# CONTRACT FEEDBACK/);
  assert.match(withRegen, /Your previous attempt FAILED the deterministic gate/);
  assert.match(withRegen, /missing required key "items"/);
  assert.ok(withRegen.indexOf('Shape APPROVED') < withRegen.indexOf('# CONTRACT FEEDBACK'),
    '# CONTRACT FEEDBACK sits after Shape APPROVED');
  assert.ok(withRegen.indexOf('# CONTRACT FEEDBACK') < withRegen.indexOf('Additionally: whether or not your own Write tool call'),
    '# CONTRACT FEEDBACK precedes the tail imperatives');
});

// ---------------------------------------------------------------------------
// 11. groom gate-fail-then-fix — runGroomWorker is an INDEPENDENT
//     implementation from runPhase1Worker (no shared loop code), so it needs
//     its own gate-fail-then-fix coverage, not just the mirrored N=2/B2 tests
//     already above. Mirrors phase1 test #1, groom side.
// ---------------------------------------------------------------------------

test('groom gate-fail-then-fix: 2 calls; call2 carries the gate complaint; final plan_ready; regen_counts.groom===1', async (t) => {
  const { engine, calls } = groomRecorder((idx) => (idx === 0 ? CONTRACT_INVALID_PLAN : goodPlan()));
  // Delete the global skip so the REAL plan gate runs — a genuine gate:false
  // then gate:true transition, not a stub of it.
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_SKIP_PLAN_ANCHORS: undefined });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'plan_ready' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'plan_ready', 'the fixed second attempt reaches plan_ready');
  assert.equal(calls.length, 2, 'exactly one regeneration → two groom calls');
  assert.equal(calls[0].regenComplaints, undefined, 'the first groom call is fresh — no complaint');
  assert.match(calls[1].regenComplaints, /missing required key/, 'call2 carries call1s gate complaint');
  assert.equal(done.body.regen_counts.groom, 1, 'one groom regeneration recorded');
});

// ---------------------------------------------------------------------------
// 12. groom no-complaint give-up — mirrors phase1 test #4 (spawn failure /
//     nothing-actionable give-up), groom side. Used the "cannot read
//     plan.json" path (gates.mjs gatePlan's own catch) rather than
//     RADSVINN_TREECHECK_BIN, since it needs no extra plumbing and exercises
//     the exact path buildCheckerComplaintsBlock's {raw:{error:...}} shape
//     documents.
// ---------------------------------------------------------------------------

test('groom no-complaint give-up: a gate that cannot even read plan.json yields NO complaint — 1 call, no wasted regen (regen_counts.groom===0)', async (t) => {
  const { engine, calls } = groomRecorderNoPlan();
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_SKIP_PLAN_ANCHORS: undefined });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  // The skeleton gate still passes (default fake phase1 → fixture skeleton),
  // so groom is genuinely reached before the loop gives up.
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'failed');
  assert.equal(calls.length, 1, 'a gate with nothing actionable to fix is never a wasted regen');
  assert.equal(done.body.regen_counts.groom, 0, 'zero groom regenerations — short-circuited');
});

// ---------------------------------------------------------------------------
// 13. groom manual-retry-after-exhaustion — mirrors phase1 test #6, groom
//     side: a Retry on an already-exhausted (N=2) groom plan must read the
//     persisted count and make exactly ONE more call, never a fresh 2× loop.
// ---------------------------------------------------------------------------

test('groom manual-retry-after-exhaustion: a failed plan at groom count 2 does ONE more call, not a fresh 2x loop', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-regen-groom-exhaust-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

  const planId = randomUUID();
  const runDir = agentRunDir(planId, resultsDir);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'skeleton.json'), JSON.stringify(GOOD_SKELETON, null, 2));

  const complaint = 'plan: missing required key "items"';
  const seed = {
    plan_id: planId,
    description: 'x'.repeat(50),
    requester: 'test-requester',
    role_lens: 'business',
    mode: 'front_door',
    output_language: 'en',
    scope_hint: 'auto',
    grounding_hint: 'full',
    status: 'failed',
    cost_usd: 1.7,
    session_id: 'sess-groom-x',
    run_dir: runDir,
    skeleton: GOOD_SKELETON,
    skeleton_gate: { ok: true },
    plan_gate: {
      ok: false,
      raw: { checks: { contract_valid: { pass: false, complaints: [complaint] } }, hard_fail: true, regen_complaint: complaint },
    },
    regen_counts: { groom: 2 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const dir = plansDir(resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planId}.json`), JSON.stringify(seed, null, 2));

  const { engine, calls } = groomRecorder(() => CONTRACT_INVALID_PLAN);
  const prevSkip = process.env.RADSVINN_SKIP_PLAN_ANCHORS;
  delete process.env.RADSVINN_SKIP_PLAN_ANCHORS;
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    if (prevSkip === undefined) delete process.env.RADSVINN_SKIP_PLAN_ANCHORS;
    else process.env.RADSVINN_SKIP_PLAN_ANCHORS = prevSkip;
  });

  const reloaded = await getJson(baseUrl, `/plan/${planId}`);
  assert.equal(reloaded.body.status, 'failed', 'a plan at the groom ceiling reloads as failed');
  assert.equal(reloaded.body.regen_counts.groom, 2);

  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed' && calls.length >= 1,
    { timeoutMs: 30000 },
  );

  assert.equal(calls.length, 1, 'retry reads the persisted count 2 → exactly ONE more groom call (never a fresh 2× loop → 2)');
  assert.equal(done.body.regen_counts.groom, 2, 'the count stays at the ceiling');
});

// ---------------------------------------------------------------------------
// 14. groom crash-resume mid-loop — mirrors phase1 test #7, groom side: a
//     process that died mid-groom-loop reloads honestly as `failed` but
//     PRESERVES regen_counts.groom, so a Retry resumes at N, never a reset.
// ---------------------------------------------------------------------------

test('groom crash-resume mid-loop: a plan reloaded from a mid-loop transient keeps regen_counts.groom and resumes at N', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-regen-crash-groom-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

  const planId = randomUUID();
  const runDir = agentRunDir(planId, resultsDir);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'skeleton.json'), JSON.stringify(GOOD_SKELETON, null, 2));

  const complaint = 'plan: missing required key "items"';
  const seed = {
    plan_id: planId,
    description: 'x'.repeat(50),
    requester: 'test-requester',
    role_lens: 'business',
    mode: 'front_door',
    output_language: 'en',
    scope_hint: 'auto',
    grounding_hint: 'full',
    status: 'grooming', // TRANSIENT — simulates a process that died mid-groom-loop
    cost_usd: 1.7,
    session_id: 'sess-groom-crash',
    run_dir: runDir,
    skeleton: GOOD_SKELETON,
    skeleton_gate: { ok: true },
    plan_gate: {
      ok: false,
      raw: { checks: { contract_valid: { pass: false, complaints: [complaint] } }, hard_fail: true, regen_complaint: complaint },
    },
    regen_counts: { groom: 1 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const dir = plansDir(resultsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${planId}.json`), JSON.stringify(seed, null, 2));

  const { engine, calls } = groomRecorder(() => CONTRACT_INVALID_PLAN);
  const prevSkip = process.env.RADSVINN_SKIP_PLAN_ANCHORS;
  delete process.env.RADSVINN_SKIP_PLAN_ANCHORS;
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    if (prevSkip === undefined) delete process.env.RADSVINN_SKIP_PLAN_ANCHORS;
    else process.env.RADSVINN_SKIP_PLAN_ANCHORS = prevSkip;
  });

  const reloaded = await getJson(baseUrl, `/plan/${planId}`);
  assert.equal(reloaded.body.status, 'failed', 'a transient groom plan reloads honestly as failed');
  assert.equal(reloaded.body.regen_counts.groom, 1, 'the mid-loop groom count survived the reload');

  const retry = await postJson(baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  // Resumed at count 1 → 1 more regen then exhaust = 2 calls. A count that
  // RESET to 0 would take 3 calls to exhaust — so 2 proves the count survived.
  assert.equal(calls.length, 2, 'resumed at 1 → exactly 2 more calls to exhaust (a reset-to-0 would be 3)');
  assert.equal(done.body.regen_counts.groom, 2);
});

// ---------------------------------------------------------------------------
// 15. B2 phase1 first-call exemption (MUTATION GUARD: the `if (costUsd > 0)`
//     guard in runPhase1Worker) — the one B2 mechanism that previously had no
//     dedicated guarding test: a FRESH plan's very FIRST phase1 call must
//     proceed even under a $0 per-plan cap, because cost_usd starts at 0 and
//     the cap only bites once real spend has accumulated.
// ---------------------------------------------------------------------------

test('B2 phase1 first-call exemption: a $0 per-plan cap does not block a FRESH plans first phase1 call', async (t) => {
  const { engine } = phase1Recorder(() => GOOD_SKELETON);
  const { baseUrl } = await startWithEngine(t, engine, { RADSVINN_PLAN_BUDGET_USD: '0' });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready' || r.body.status === 'budget_blocked' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'shape_ready', 'the very first phase1 call is exempt from a $0 per-plan cap (cost_usd starts at 0)');
});
