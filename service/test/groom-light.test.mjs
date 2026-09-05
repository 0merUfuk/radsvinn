// groom-light.test.mjs — Light grounding extends to the GROOM phase. A
// decompose-only grounding-depth cap would leave
// groom — which RESUMES the decompose session — to re-crawl the grounding
// repos per item. The implementation injects a
// groom `# GROUNDING` directive (reuse the Phase-1 grounding, don't re-crawl
// per item) AND a plan-size-scaled `--max-turns` cap on the groom call.
//
// The subtlety this suite pins: groom is the QUALITY seat (verified anchors +
// coupling-zone routing), so the cap stops WASTEFUL re-exploration, NOT
// verification — a groom truncated at the cap yields an incomplete artifact
// the deterministic gate rejects → `failed`/retryable, never a
// silently-truncated `plan_ready`.
//
// Same zero-network house pattern as grounding-hint.test.mjs: fake engine,
// fresh tmp results dir, the createServer({engine, resultsDir}) seam, the REAL
// treecheck skeleton gate. Service-message-only: it exercises the groom wiring
// (groundingHint + itemCount), the `# GROUNDING` directive, and the
// plan-size-scaled `--max-turns` cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { createEngine, groomMessage, buildClaudeArgs, extractJsonArtifact } from '../engine.mjs';

const GROOM_BASE = { edited: false, runDir: '/tmp/run-x', outputLanguage: 'en' };

// Saves + restores one env var around a test (same discipline as
// service-mode-prompt.test.mjs / grounding-hint.test.mjs).
function stashEnv(t, key) {
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// wire — the service passes groundingHint AND itemCount into engine.groom
// ---------------------------------------------------------------------------

test('groom wire: the service passes groundingHint AND itemCount into engine.groom', async (t) => {
  // createServer(options.engine) is the documented test seam — wrap the fake
  // engine and record groom's args, exactly as the real engine would receive
  // them. This is the contract engine.groom relies on:
  // groundingHint + itemCount.
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-groom-wire-'));
  const fake = createEngine('fake');
  const groomArgs = [];
  const engine = {
    ...fake,
    async groom(args) {
      groomArgs.push(args);
      return fake.groom(args);
    },
  };
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  const res = await postJson(baseUrl, '/plan', {
    description: 'rotate the fal.ai API key',
    requester: 'test-requester',
    grounding_hint: 'light',
  });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;

  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  const approve = await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approve.status, 202);
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready', { timeoutMs: 30000 });

  assert.equal(groomArgs.length, 1, 'exactly one groom call');
  assert.equal(groomArgs[0].groundingHint, 'light', 'engine.groom must receive the persisted grounding_hint');
  // The fake phase1 copies fixtures/e2e-sample/skeleton.json, which carries 3
  // items — the count the server derives from plan.skeleton.items.length.
  assert.equal(groomArgs[0].itemCount, 3, 'engine.groom must receive the skeleton item count that sizes the cap');
});

// ---------------------------------------------------------------------------
// groomMessage — the `# GROUNDING` groom directive block
// ---------------------------------------------------------------------------

test('groomMessage: `light` injects the `# GROUNDING` groom directive AFTER `# TOOLS` and BEFORE `Shape APPROVED`; full/absent/unknown byte-identical', (t) => {
  stashEnv(t, 'RADSVINN_AGENT_ALLOWED_TOOLS');
  delete process.env.RADSVINN_AGENT_ALLOWED_TOOLS; // the safe default → the # TOOLS directive is present

  const light = groomMessage({ ...GROOM_BASE, groundingHint: 'light' });
  assert.match(light, /# GROUNDING/);
  assert.match(light, /RESUMES the grounding already done in Phase 1/);
  assert.match(light, /reuse the coupling map/);
  assert.match(light, /do NOT re-crawl or re-grep the repos per item/);
  assert.match(light, /read at most 1-2 files TOTAL for the entire plan/);
  assert.match(light, /every code_anchor must still be real/);
  assert.match(light, /reduces exploration, not/, 'the cap trades exploration, not rigor');
  assert.match(light, /OVERRIDES your default grooming thoroughness/, 'the directive states it is the user decision, not a suggestion');

  // Placement contract: directives precede the operative body, and the groom
  // directive sits after the tools directive (same order as phase1Message).
  assert.ok(light.indexOf('# TOOLS') < light.indexOf('# GROUNDING'), '# TOOLS precedes # GROUNDING');
  assert.ok(light.indexOf('# GROUNDING') < light.indexOf('Shape APPROVED'), '# GROUNDING precedes the operative Shape APPROVED body');

  // The asymmetric default, proven byte-for-byte: full/absent/unknown all
  // produce EXACTLY the uncapped groom message. The null-prototype map makes
  // 'toString'/'constructor' miss cleanly (no inherited member injected).
  const noHint = groomMessage({ ...GROOM_BASE });
  for (const hint of ['full', undefined, 'medium', 'toString', 'constructor']) {
    assert.equal(groomMessage({ ...GROOM_BASE, groundingHint: hint }), noHint,
      `groom grounding "${hint}" must inject nothing — byte-identical to no hint`);
  }
});

// ---------------------------------------------------------------------------
// buildClaudeArgs — the light GROOM `--max-turns` cap table
// ---------------------------------------------------------------------------

test('buildClaudeArgs: light GROOM adds a plan-size-scaled --max-turns (base + perItem × n); env-overridable; full/absent groom argv byte-identical', (t) => {
  const prevBase = process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
  const prevPer = process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;
  t.after(() => {
    if (prevBase === undefined) delete process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
    else process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS = prevBase;
    if (prevPer === undefined) delete process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;
    else process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS = prevPer;
  });
  delete process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
  delete process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;

  const cap = (itemCount) => argValue(
    buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', groundingHint: 'light', itemCount }),
    '--max-turns',
  );

  // Defaults: base 6 + perItem 4 × n. n falls back to 4 for
  // missing/0/negative/non-integer item counts.
  assert.equal(cap(1), '10', '6 + 4×1');
  assert.equal(cap(4), '22', '6 + 4×4');
  assert.equal(cap(10), '46', '6 + 4×10');
  assert.equal(cap(undefined), '22', 'missing itemCount → fallback n=4 → 22');
  assert.equal(cap(0), '22', 'zero itemCount → fallback n=4 → 22');
  assert.equal(cap(-1), '22', 'negative itemCount → fallback n=4 → 22');
  assert.equal(cap(1.5), '22', 'non-integer itemCount → fallback n=4 → 22');

  // Both new env vars respected.
  process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS = '10';
  process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS = '5';
  assert.equal(cap(4), '30', 'overridden base 10 + perItem 5 × 4');
  assert.equal(cap(undefined), '30', 'the fallback n=4 uses the overridden vars too');

  // Junk overrides fall back to the per-var defaults independently.
  for (const junk of ['abc', '0', '-3', '2.5', '']) {
    process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS = junk;
    process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS = junk;
    assert.equal(cap(4), '22', `junk overrides "${junk}" fall back to 6 + 4×4`);
  }
  delete process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
  delete process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;

  // full/absent groom → NO cap flag; itemCount is inert without a light hint.
  const fullGroom = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', groundingHint: 'full', itemCount: 4 });
  const absentGroom = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', itemCount: 4 });
  const noItemGroom = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom' });
  assert.equal(fullGroom.includes('--max-turns'), false, 'full groom passes no cap');
  assert.deepEqual(fullGroom, absentGroom, 'full and absent groom build the same argv');
  assert.deepEqual(absentGroom, noItemGroom, 'itemCount is inert without a light hint');
});

// ---------------------------------------------------------------------------
// fail-closed #1 (fake engine) — a truncated groom lands `failed`, never
// `plan_ready`
// ---------------------------------------------------------------------------

test('fail-closed (fake): a groom truncated at the cap lands `failed`, never a silent `plan_ready`', async (t) => {
  // RADSVINN_FAKE_GROOM_TRUNCATED=1 makes the fake groom throw a
  // max-turns-shaped error (the real engine's runClaudeSpawn rejects on the
  // CLI's non-zero exit) WITHOUT writing plan.json — exactly the fail-closed
  // fail-closed path: the incomplete artifact never reaches plan_ready.
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_GROOM_TRUNCATED: '1' });
  t.after(() => ctx.close());

  const res = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', grounding_hint: 'light' });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;

  // phase1 is unaffected by the knob → shape_ready.
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  const approve = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approve.status, 202);

  const terminal = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'failed' || r.body.status === 'plan_ready',
    { timeoutMs: 30000 },
  );
  assert.equal(terminal.body.status, 'failed', 'a truncated groom fails closed — never plan_ready');
  assert.equal(terminal.body.plan, undefined, 'no groomed plan artifact is surfaced on a truncated groom');
});

// ---------------------------------------------------------------------------
// fail-closed #2 (real extractJsonArtifact) — a truncated JSON reply yields no
// artifact, so the gate step has nothing to promote
// ---------------------------------------------------------------------------

test('fail-closed (extractJsonArtifact): a truncated JSON reply (valid prefix, no closing brace/fence) extracts to null', () => {
  // This is the real seam the service uses to recover the plan artifact from
  // the agent's fenced reply when the Write tool call was denied (runPhase).
  // A groom truncated at the cap emits a valid PREFIX with no closing brace
  // and no closing fence — there is no balanced brace region and no complete
  // fenced block, so extraction MUST fail (→ null), which leaves plan.json
  // absent and the gate step fails closed on the missing file.
  const truncated = [
    'Working on it. Here is the groomed plan:',
    '```json',
    '{',
    '  "epic": { "temp_id": "epic-1", "summary": "Do the thing",',
    '  "items": [',
    '    { "temp_id": "i1", "type": "Task", "one_line_summary": "first item, cut off here',
  ].join('\n');
  assert.equal(extractJsonArtifact(truncated), null, 'a truncated JSON fragment yields no artifact — fail closed');

  // Sanity anchor: the SAME content, completed, DOES extract — proving the
  // null above is the truncation, not a broken extractor.
  const complete = [
    'Here is the groomed plan:',
    '```json',
    '{ "epic": { "temp_id": "epic-1", "summary": "Do the thing" }, "items": [] }',
    '```',
  ].join('\n');
  assert.deepEqual(extractJsonArtifact(complete), { epic: { temp_id: 'epic-1', summary: 'Do the thing' }, items: [] });
});

// ---------------------------------------------------------------------------
// Adversarial cap-table, prototype
// safety, and the two wire edges the developer's own suite didn't exercise:
// a POST-skeleton_edits item count, and a missing/malformed skeleton.
// ---------------------------------------------------------------------------

test('buildClaudeArgs: light GROOM cap table gaps — n=2, a STRING itemCount falls back like any other junk shape, and non-light hints never carry a cap regardless of itemCount', (t) => {
  const prevBase = process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
  const prevPer = process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;
  t.after(() => {
    if (prevBase === undefined) delete process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
    else process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS = prevBase;
    if (prevPer === undefined) delete process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;
    else process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS = prevPer;
  });
  delete process.env.RADSVINN_LIGHT_GROOM_BASE_TURNS;
  delete process.env.RADSVINN_LIGHT_GROOM_PER_ITEM_TURNS;

  const cap = (itemCount) => argValue(
    buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', groundingHint: 'light', itemCount }),
    '--max-turns',
  );

  // n=2 fills the gap between the existing 1/4/10 sample points: 6 + 4×2.
  assert.equal(cap(2), '14', '6 + 4×2');

  // A STRING itemCount ('3') fails `Number.isInteger` (that predicate is
  // `number`-type-only — it never coerces) — same fallback as
  // undefined/0/negative/non-integer: n=4 → 22. Never coerced, never a crash.
  assert.equal(cap('3'), '22', "a string itemCount ('3') is not Number.isInteger — falls back to n=4 → 22, same as any other junk shape");

  // Every non-light groundingHint — unknown, absent, or a
  // prototype-property-shaped string — must carry NO --max-turns on a groom
  // call, regardless of itemCount: the cap is gated on groundingHint ===
  // 'light' alone, never on itemCount being present.
  for (const hint of ['full', undefined, 'medium', 'toString', 'constructor', '__proto__']) {
    const args = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', groundingHint: hint, itemCount: 4 });
    assert.equal(args.includes('--max-turns'), false, `groundingHint "${hint}" must never add --max-turns to a groom call`);
  }
});

test('groomMessage: prototype-pollution-shaped groundingHint values inject nothing — the null-prototype map cannot resolve an inherited member', (t) => {
  stashEnv(t, 'RADSVINN_AGENT_ALLOWED_TOOLS');
  delete process.env.RADSVINN_AGENT_ALLOWED_TOOLS;

  const noHint = groomMessage({ ...GROOM_BASE });
  // '__proto__' is the sharpest case: on a PLAIN object literal, `obj['__proto__']`
  // resolves through Object.prototype's accessor to the prototype itself (a
  // truthy object) — exactly the kind of surprise a null-prototype map exists
  // to prevent. 'constructor'/'toString'/'hasOwnProperty'/'valueOf' are the
  // same class of risk (inherited functions that would otherwise be truthy).
  for (const hint of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const msg = groomMessage({ ...GROOM_BASE, groundingHint: hint });
    assert.equal(msg, noHint, `groundingHint "${hint}" must inject nothing — byte-identical to no hint (prototype-safety)`);
    assert.equal(msg.includes('# GROUNDING'), false, `groundingHint "${hint}" must not surface a # GROUNDING block`);
  }
});

test('groom wire: itemCount reflects the skeleton POST-edit count (skeleton_edits), not the original decomposed count', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-groom-edit-wire-'));
  const fake = createEngine('fake');
  const groomArgs = [];
  const engine = {
    ...fake,
    async groom(args) {
      groomArgs.push(args);
      return fake.groom(args);
    },
  };
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  const res = await postJson(baseUrl, '/plan', {
    description: 'rotate the fal.ai API key',
    requester: 'test-requester',
    grounding_hint: 'light',
  });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;
  const shapeReady = await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  assert.equal(shapeReady.body.skeleton.items.length, 3, 'sanity: the fixture skeleton starts with 3 items');

  // A real human trim at the shape gate: drop i3 (which nothing else depends
  // on — only i3 itself depends on i2). Milestone m2 is left with zero
  // items, which is legal (no check requires every declared milestone to be
  // used) — verified independently against the real treecheck binary before
  // this test was written.
  const edited = {
    ...shapeReady.body.skeleton,
    items: shapeReady.body.skeleton.items.filter((it) => it.temp_id !== 'i3'),
  };
  assert.equal(edited.items.length, 2);

  const approve = await postJson(baseUrl, `/plan/${planId}/approve-shape`, { skeleton_edits: edited });
  assert.equal(approve.status, 202, `edited skeleton must pass the real gate — got ${JSON.stringify(approve.body)}`);

  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming', { timeoutMs: 30000 });

  assert.equal(groomArgs.length, 1, 'exactly one groom call');
  assert.equal(groomArgs[0].itemCount, 2, 'itemCount must reflect the POST-edit (trimmed) count, not the original 3-item decomposition');
});

test('groom wire: a corrupted plan.skeleton (no items array) never crashes the worker — itemCount is undefined and the cap falls back to n=4', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-groom-noskel-wire-'));
  const fake = createEngine('fake');
  const groomArgs = [];
  const engine = {
    ...fake,
    async groom(args) {
      groomArgs.push(args);
      return fake.groom(args);
    },
  };
  const app = createServer({ engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(async () => {
    await app.close();
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  const res = await postJson(baseUrl, '/plan', {
    description: 'rotate the fal.ai API key',
    requester: 'test-requester',
    grounding_hint: 'light',
  });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  // Corrupt the in-memory plan's skeleton via the documented test seam
  // (`app._state` — "exposed for tests that want direct state/engine
  // access", server.mjs's own trailing comment) to the exact shape
  // runGroomWorker's itemCount computation must survive without throwing:
  // an object with no `items` array at all.
  app._state.update(planId, { skeleton: { epic: null, milestones: [] } });

  const approve = await postJson(baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approve.status, 202);

  await assert.doesNotReject(() =>
    pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming', { timeoutMs: 30000 }),
  );

  assert.equal(groomArgs.length, 1, 'exactly one groom call — the worker never crashed');
  assert.equal(groomArgs[0].itemCount, undefined, 'plan.skeleton.items is not an array → itemCount is undefined, never fabricated and never a throw');
});
