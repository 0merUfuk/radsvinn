// scope-hint.test.mjs — the scope control prevents simple asks from being
// inflated into Epics; the
// requester owns the epic-ization decision now, as a hard user-supplied
// constraint. These tests assert the WIRE end-to-end on the service side:
// POST /plan validation → plan record → toPublicView → engine.phase1 args →
// phase1Message's `# SCOPE` block. The fake engine deliberately ignores the
// hint (it copies a fixture skeleton), so shape OBEDIENCE is a live/prompt
// concern — the wire is what this suite proves.
//
// Same zero-network house pattern as the rest of the suite: fake engine,
// fresh tmp results dir per test, the REAL treecheck skeleton gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { createEngine, phase1Message } from '../engine.mjs';

test('scope_hint: validated on POST /plan (400 on junk/non-string), defaulted to auto, persisted and echoed in the view', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const junk = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', scope_hint: 'gigantic' });
  assert.equal(junk.status, 400, 'an unsupported scope_hint must be rejected');
  assert.ok(junk.body.details.some((d) => /scope_hint/.test(d)), 'the validation error names the field');

  const nonString = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', scope_hint: 5 });
  assert.equal(nonString.status, 400, 'a non-string scope_hint must be rejected');

  const single = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', scope_hint: 'single' });
  assert.equal(single.status, 202);
  const view = await getJson(ctx.baseUrl, `/plan/${single.body.plan_id}`);
  assert.equal(view.body.scope_hint, 'single', 'the chosen scope is persisted and surfaced (the Slack shape gate reads it)');

  const dflt = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const dview = await getJson(ctx.baseUrl, `/plan/${dflt.body.plan_id}`);
  assert.equal(dview.body.scope_hint, 'auto', 'absent scope_hint defaults to auto');

  // Let the fire-and-forget phase-1 workers finish before ctx.close() tears
  // down the tmp results dir (house discipline — see http-e2e.test.mjs).
  for (const id of [single.body.plan_id, dflt.body.plan_id]) {
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

test('scope_hint wire: the service passes scopeHint (and outputLanguage) into engine.phase1', async (t) => {
  // createServer(options.engine) is the documented test seam — wrap the
  // fake engine and record phase1's args, exactly as the real engine would
  // receive them. This is the contract the engine.phase1 path relies on:
  // signature gained `scopeHint`.
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-scope-wire-'));
  const fake = createEngine('fake');
  const phase1Args = [];
  const engine = {
    ...fake,
    async phase1(args) {
      phase1Args.push(args);
      return fake.phase1(args);
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
    description: 'one small config change',
    requester: 'test-requester',
    scope_hint: 'single',
    output_language: 'tr',
  });
  assert.equal(res.status, 202);
  await pollUntil(() => getJson(baseUrl, `/plan/${res.body.plan_id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });

  assert.equal(phase1Args.length, 1, 'exactly one phase-1 call');
  assert.equal(phase1Args[0].scopeHint, 'single', 'engine.phase1 must receive the persisted scope_hint');
  assert.equal(phase1Args[0].outputLanguage, 'tr', 'the language rides the same arg contract');
  assert.equal(phase1Args[0].ask, 'one small config change');
});

test('phase1Message: `# SCOPE` injected with HARD wording for single/small/epic; auto and absent inject nothing', () => {
  const base = { ask: 'do the thing', requester: 'test-requester', roleLens: 'business', runDir: '/tmp/run-x', outputLanguage: 'en' };
  const directiveTail = (message) => {
    const marker = '\n\n# OUTPUT LANGUAGE\n';
    const index = message.lastIndexOf(marker);
    assert.notEqual(index, -1, 'the composed directive tail has an output-language anchor');
    return message.slice(index + 2);
  };

  const single = phase1Message({ ...base, scopeHint: 'single' });
  const singleTail = directiveTail(single);
  assert.match(singleTail, /# SCOPE/);
  assert.match(singleTail, /ONE-NODE skeleton: epic null, milestones \[\], exactly one item — do NOT decompose further/);
  assert.match(singleTail, /OVERRIDES your size judgment/, 'the directive states it is the user decision, not a suggestion');
  // The directive must precede the ask so it governs the decomposition
  // instead of reading as part of the request text.
  assert.ok(singleTail.indexOf('# SCOPE') < singleTail.indexOf('do the thing'), 'the SCOPE block precedes the ask');
  assert.ok(single.startsWith('# Radsvinn Decomposer — Phase 1 (Break-Down)'),
    'the decomposer prompt body now leads the composed message');
  assert.ok(singleTail.indexOf('# OUTPUT LANGUAGE') < singleTail.indexOf('# SCOPE'),
    'the language directive still leads the service-specific directives');

  const smallTail = directiveTail(phase1Message({ ...base, scopeHint: 'small' }));
  assert.match(smallTail, /# SCOPE/);
  assert.match(smallTail, /2-5 items, epic null — no epic ceremony/);

  const epicTail = directiveTail(phase1Message({ ...base, scopeHint: 'epic' }));
  assert.match(epicTail, /# SCOPE/);
  assert.match(epicTail, /full epic breakdown is expected/);

  for (const hint of ['auto', undefined]) {
    const tail = directiveTail(phase1Message({ ...base, scopeHint: hint }));
    assert.equal(tail.includes('# SCOPE'), false, `scope "${hint}" must inject nothing — the prompt rules stand`);
  }
});

test('scope_hint e2e (fake engine): a single-scoped plan flows to shape_ready — the deterministic skeleton gate is untouched by scope', async (t) => {
  // The fake engine copies the multi-item fixture regardless of scope —
  // deliberately: the gate must stay green for ALL shapes (one-node
  // skeletons are already legal per internal/checks/skeleton.go), and the
  // scope directive is a prompt-level constraint checked by the HUMAN at
  // the shape gate, never a new machine gate.
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const res = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', scope_hint: 'single' });
  assert.equal(res.status, 202);
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${res.body.plan_id}`),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.status, 'shape_ready', 'scope never blocks the pipeline');
  assert.equal(shapeReady.body.scope_hint, 'single', 'the hint survives to the gate view');
  assert.equal(shapeReady.body.skeleton_gate.ok, true);
});
