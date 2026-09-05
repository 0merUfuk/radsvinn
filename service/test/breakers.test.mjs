import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { recordSpend, recordSpendNanos, getDailySpend, getDailySpendNanos, getCostTelemetryLock, checkDaily, checkPlanBudget } from '../breakers.mjs';
import { createServer } from '../server.mjs';
import { createEngine } from '../engine.mjs';
import { RADSVINN_ROOT, agentRunDir } from '../state.mjs';

// A valid-contract skeleton with a real dependency cycle. It remains a hard
// structural failure after tree-width conventions became advisory, so B2 can
// prove the planning spend cap still bounds a regen loop.
function badCycleSkeleton() {
  const s = JSON.parse(fs.readFileSync(path.join(RADSVINN_ROOT, 'fixtures', 'e2e-sample', 'skeleton.json'), 'utf8'));
  s.items[0].depends_on = ['i2']; // fixture i2 already depends on i1
  return s;
}

test('human-approved zero-LLM create ignores exhausted plan and daily breakers without auto-creating', async (t) => {
  // Fake planning costs are 0.8 + 0.9. A $1 plan/daily cap permits phase1 and
  // groom (each checks the pre-call $0.8 state), then is exceeded at $1.7.
  // The explicit Jira create must still run: it is deterministic control-plane
  // work, not an LLM call. Mutating either pre-create breaker back in makes
  // this fail as budget_blocked.
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_PLAN_BUDGET_USD: '1',
    RADSVINN_DAILY_HARD_USD: '1',
  });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.cost_usd, 0.8);

  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  const planReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'grooming',
  );
  assert.equal(planReady.body.status, 'plan_ready');
  assert.equal(planReady.body.cost_usd, 1.7);
  assert.equal(planReady.body.created, undefined, 'spend exhaustion never auto-creates Jira work');
  assert.equal(
    fs.existsSync(path.join(agentRunDir(planId, ctx.resultsDir), 'created-record.json')),
    false,
    'the only path that can write Jira/create record is an explicit POST /create',
  );

  const createRes = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(createRes.status, 202);

  const final = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'creating',
  );
  assert.equal(final.body.status, 'created');
  assert.equal(final.body.cost_usd, 1.7, 'zero-LLM create leaves the immutable planning cost unchanged');
  assert.equal(getDailySpend(ctx.resultsDir), 1.7, 'zero-LLM create does not mutate the LLM spend ledger');
  assert.ok(final.body.created && final.body.created.record_path, 'the explicit create alone writes a Jira record');
});

test('daily hard cap (RADSVINN_DAILY_HARD_USD=0.5): first call proceeds, next call is refused', async (t) => {
  // Daily total starts at 0 for a fresh results dir, so phase1's own
  // pre-call check (0 < 0.5) is never blocked by its own future cost — it
  // must reach a state where the ALREADY-recorded total exceeds hard before
  // the next call is attempted.
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_DAILY_HARD_USD: '0.5' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.status, 'shape_ready', 'the first call of the day is not blocked by its own cost');

  const health1 = await getJson(ctx.baseUrl, '/healthz');
  assert.equal(health1.body.daily_spend_usd, 0.8);

  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approved.status, 202);

  const afterGroomAttempt = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status !== 'grooming',
  );
  assert.equal(afterGroomAttempt.body.status, 'budget_blocked');
  assert.ok(afterGroomAttempt.body.error && /daily/i.test(afterGroomAttempt.body.error));

  const health2 = await getJson(ctx.baseUrl, '/healthz');
  assert.equal(health2.body.daily_spend_usd, 0.8, 'no additional spend recorded once the daily breaker trips');
});

// ---------------------------------------------------------------------------
// B2 — the per-plan budget cap is enforced INSIDE the phase1 regen loop
// ---------------------------------------------------------------------------

test('B2: the per-plan cap trips BETWEEN regens (RADSVINN_PLAN_BUDGET_USD=0.5) — a regen cannot bypass it', async (t) => {
  // A permanently gate-failing decompose ($0.8/call) wants to regenerate. With
  // cap=0.5: the FIRST call is exempt (cost starts at 0), but before the FIRST
  // regen call the accumulated $0.8 >= $0.5 trips the cap → budget_blocked
  // after exactly ONE call. Without the in-loop B2 check the loop would run to
  // its N=2 ceiling (3 calls) — so this proves the cap bounds the regen loop.
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-b2-loop-'));
  const prev = process.env.RADSVINN_PLAN_BUDGET_USD;
  process.env.RADSVINN_PLAN_BUDGET_USD = '0.5';

  const calls = [];
  const engine = {
    ...createEngine('fake'),
    async phase1(args) {
      calls.push(args);
      fs.mkdirSync(args.runDir, { recursive: true });
      fs.writeFileSync(path.join(args.runDir, 'skeleton.json'), JSON.stringify(badCycleSkeleton(), null, 2));
      return { sessionId: `sess-${calls.length}`, costUsd: 0.8, resultText: 'x', durationMs: 0, numTurns: 1, model: 'fake' };
    },
  };
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    if (prev === undefined) delete process.env.RADSVINN_PLAN_BUDGET_USD;
    else process.env.RADSVINN_PLAN_BUDGET_USD = prev;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const done = await pollUntil(
    () => getJson(baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'budget_blocked' || r.body.status === 'failed',
    { timeoutMs: 30000 },
  );

  assert.equal(done.body.status, 'budget_blocked', 'the accumulated spend trips the cap before the first regen call');
  assert.equal(calls.length, 1, 'exactly one decompose ran — the regen was capped, not the N=2 loop');
  assert.equal(done.body.cost_usd, 0.8, 'only the first call was charged');
  assert.ok(/cap|budget/i.test(done.body.error), 'the error names the cap');
});

// ---------------------------------------------------------------------------
// spend serialization (Phase B) — lost-increment-proof daily spend
// ---------------------------------------------------------------------------

test('spend serialization: 50 concurrent recordSpend(0.01) total EXACTLY 0.50 — the in-process queue serializes every read-modify-write', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-spend-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const totals = await Promise.all(
    Array.from({ length: 50 }, () => recordSpend(dir, 0.01)),
  );

  assert.equal(getDailySpend(dir), 0.5, 'the durable total is exact — no increment was lost');

  // The stronger claim: each mutation observed the PREVIOUS one's result.
  // Interleaved read-modify-writes would make two calls read the same base
  // and return the same total; serialized ones return the 50 DISTINCT
  // running totals 0.01 … 0.50.
  const sorted = totals.slice().sort((a, b) => a - b);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(sorted[i], Number(((i + 1) * 0.01).toFixed(6)), `running total #${i + 1} is distinct and exact`);
  }
});

test('spend serialization: a failed spend write rejects its caller but never wedges the queue', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-spend-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A results "dir" that is actually a FILE makes writeDaily's mkdir throw.
  const bogus = path.join(dir, 'not-a-dir');
  fs.writeFileSync(bogus, 'x');

  await assert.rejects(() => recordSpend(bogus, 0.01), 'the caller sees the failure');
  assert.equal(await recordSpend(dir, 0.02), 0.02, 'the chain survives — the next spend records normally');
});

test('metering: concurrent sub-cent charges preserve every nanodollar and invalid fixed-point plan cost blocks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-nano-spend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 50 }, () => recordSpendNanos(dir, 1)));
  assert.equal(getDailySpendNanos(dir), 50, 'no sub-cent charge disappears in the serialized ledger');
  assert.equal(getDailySpend(dir), 0.00000005);
  for (const plan of [{ cost_nanos: -1, cost_usd: 0 }, { cost_nanos: '1', cost_usd: 0 }, { cost_usd: Number.NaN }]) {
    assert.equal(checkPlanBudget(plan).blocked, true, 'a malformed persisted cost must never fall back to zero');
  }
});

test('metering: a failed ledger write leaves a root-level in-memory lock for later LLM calls', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-lock-spend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bogus = path.join(dir, 'not-a-dir');
  fs.writeFileSync(bogus, 'x');
  await assert.rejects(() => recordSpendNanos(bogus, 1));
  assert.ok(getCostTelemetryLock(bogus), 'memory lock remains even though its durable write path was impossible');
  await assert.rejects(() => recordSpendNanos(bogus, 1), /locked|write|telemetry/i);
});

test('breaker threshold env can be injected without changing default policy or spend storage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-breaker-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(checkDaily(dir, {}).blocked, false, 'an empty injected env uses the documented daily defaults');
  assert.equal(
    checkDaily(dir, { RADSVINN_DAILY_HARD_USD: '0', RADSVINN_DAILY_SOFT_USD: '0' }).blocked,
    true,
    'an injected hard limit is honored',
  );
  assert.equal(checkPlanBudget({ cost_usd: 0 }, {}).blocked, false, 'an empty injected env uses the plan default');
  assert.equal(
    checkPlanBudget({ cost_usd: 0 }, { RADSVINN_PLAN_BUDGET_USD: '0' }).blocked,
    true,
    'an injected per-plan limit is honored',
  );
});
