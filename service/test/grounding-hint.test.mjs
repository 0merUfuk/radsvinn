// grounding-hint.test.mjs — grounding-depth control and phase-timing
// observability. Every decompose pays
// for the agent's Grep/Read exploration in tool-loop TURNS (cost AND
// latency); `grounding_hint: light` is the requester's OPT-IN way to skip
// deep code reading for simple asks. The default MUST stay `full` —
// under-grounding a task that needed it silently degrades ticket quality
// (the asymmetric failure mode) — so every test here also proves the
// full/absent path stays byte-identical to pre-change behavior.
//
// The wire mirrors scope_hint exactly (see scope-hint.test.mjs): wizard
// radio → view_submission extraction → POST /plan validation → plan record
// → toPublicView → engine.phase1 args → phase1Message `# GROUNDING` block →
// buildClaudeArgs `--max-turns` cap (decompose here; groom coverage is in
// groom-light.test.mjs) → Slack shape-gate note.
//
// Same zero-network house pattern as the rest of the suite: fake engine,
// fresh tmp results dir per test, recorded-calls fake fetches for the
// bridge, the REAL treecheck skeleton gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';
import { createEngine, phase1Message, buildClaudeArgs } from '../engine.mjs';
import { createBridge } from '../slack.mjs';
import { skeletonMessage } from '../slack-blocks.mjs';

const FAKE_ENV = { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' };
const SILENT_LOG = { error() {}, log() {} };

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function makeRecordingFetch(responder) {
  const calls = [];
  async function fn(url, options = {}) {
    const record = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body };
    calls.push(record);
    return responder(record, calls.length - 1);
  }
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// wizard view — the grounding radio
// ---------------------------------------------------------------------------

test('wizard view: grounding is a TWO-option radio (full initial, light) placed BELOW scope and ABOVE the description', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(
    {
      envelope_id: 'env-grd-wiz',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: '', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 'trig-g' },
    },
    () => {},
  );

  const call = slackFetch.calls.find((c) => c.url.endsWith('/views.open'));
  assert.ok(call, 'views.open must be called');
  const opened = JSON.parse(call.body);

  const groundingBlock = opened.view.blocks.find((b) => b.block_id === 'grounding');
  assert.ok(groundingBlock, 'the grounding input block must exist');
  assert.equal(groundingBlock.label.text, 'Code grounding');
  assert.equal(groundingBlock.element.type, 'radio_buttons');
  assert.equal(groundingBlock.element.action_id, 'grounding_hint');
  assert.deepEqual(groundingBlock.element.options.map((o) => o.value), ['full', 'light'], 'exactly two options, full then light');
  assert.equal(groundingBlock.element.initial_option.value, 'full', 'Full is the initial option — Light is opt-in, never the silent default');
  assert.match(groundingBlock.element.options[0].text.text, /Full — read the code \(default\)/);
  assert.match(groundingBlock.element.options[1].text.text, /Light — skip deep code reading \(faster\/cheaper; for simple asks\)/);

  // Order contract: the wizard reads top-to-bottom simple→specific —
  // language, scope, grounding, description.
  const ids = opened.view.blocks.map((b) => b.block_id);
  const [lang, scope, grounding, desc] = ['lang', 'scope', 'grounding', 'desc'].map((id) => ids.indexOf(id));
  assert.ok(lang >= 0 && scope > lang && grounding > scope && desc > grounding,
    `wizard block order must be lang < scope < grounding < desc — got ${JSON.stringify(ids)}`);
});

// ---------------------------------------------------------------------------
// view_submission — extraction + POST body
// ---------------------------------------------------------------------------

test('view_submission: light radio -> POST /plan carries grounding_hint, with the stderr extraction trace', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') {
      return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-00000000g001', status: 'breaking_down' });
    }
    return fakeResponse(404, { error: 'unexpected' });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const logged = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => logged.push(String(m)) } });

  await bridge.handleEnvelope(
    {
      envelope_id: 'sub-grd-1',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: {
            values: {
              lang: { output_language: { type: 'radio_buttons', selected_option: { value: 'en' } } },
              scope: { scope_hint: { type: 'radio_buttons', selected_option: { value: 'auto' } } },
              grounding: { grounding_hint: { type: 'radio_buttons', selected_option: { value: 'light' } } },
              desc: { description: { value: 'rotate the fal.ai API key' } },
            },
          },
        },
      },
    },
    () => {},
  );

  const posts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/plan'));
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body);
  assert.equal(body.grounding_hint, 'light', 'the selected grounding depth must reach the service');
  assert.equal(body.scope_hint, 'auto', 'the neighboring radios still ride the same POST');

  // The diagnosability contract extends to the new radio: the raw
  // extracted value is on stderr, so a live mismatch is log-diagnosable.
  assert.ok(
    logged.some((l) => /wizard grounding extracted: light \(raw block present: yes\)/.test(l)),
    `the raw grounding extraction must be logged — got: ${JSON.stringify(logged)}`,
  );
});

test('view_submission: grounding block MISSING from state.values -> full fallback, LOUD stderr log, no throw', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') {
      return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-00000000g002', status: 'breaking_down' });
    }
    return fakeResponse(404, { error: 'unexpected' });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const logged = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => logged.push(String(m)) } });

  await assert.doesNotReject(() => bridge.handleEnvelope(
    {
      envelope_id: 'sub-grd-missing',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: { values: { desc: { description: { value: 'add a thing' } } } },
        },
      },
    },
    () => {},
  ));

  const posts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/plan'));
  assert.equal(posts.length, 1, 'the submission still starts a plan');
  assert.equal(JSON.parse(posts[0].body).grounding_hint, 'full',
    'a missing grounding block falls back to full — Light must be an explicit choice, never an accident');

  assert.ok(
    logged.some((l) => /wizard grounding extracted: \(missing\) \(raw block present: no\)/.test(l)),
    `the missing extraction must be logged — got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((l) => /"grounding" block MISSING from view\.state\.values/.test(l)),
    'the missing grounding block must be logged loudly',
  );
});

// ---------------------------------------------------------------------------
// POST /plan validation + persistence + toPublicView echo
// ---------------------------------------------------------------------------

test('grounding_hint: validated on POST /plan (400 on junk/non-string), defaulted to full, persisted and echoed in the view', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const junk = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', grounding_hint: 'medium' });
  assert.equal(junk.status, 400, 'an unsupported grounding_hint must be rejected');
  assert.ok(junk.body.details.some((d) => /grounding_hint must be one of 'full' \| 'light'/.test(d)), 'the validation error names the field, same message shape as scope');

  const nonString = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', grounding_hint: 5 });
  assert.equal(nonString.status, 400, 'a non-string grounding_hint must be rejected');

  const light = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', grounding_hint: 'light' });
  assert.equal(light.status, 202);
  const view = await getJson(ctx.baseUrl, `/plan/${light.body.plan_id}`);
  assert.equal(view.body.grounding_hint, 'light', 'the chosen depth is persisted and surfaced (the Slack shape gate reads it)');

  const dflt = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const dview = await getJson(ctx.baseUrl, `/plan/${dflt.body.plan_id}`);
  assert.equal(dview.body.grounding_hint, 'full', 'absent grounding_hint defaults to full — the asymmetric-default rule');

  // Let the fire-and-forget phase-1 workers finish before ctx.close() tears
  // down the tmp results dir (house discipline — see http-e2e.test.mjs).
  for (const id of [light.body.plan_id, dflt.body.plan_id]) {
    await pollUntil(() => getJson(ctx.baseUrl, `/plan/${id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  }
});

// ---------------------------------------------------------------------------
// engine wire — the service passes groundingHint into engine.phase1
// ---------------------------------------------------------------------------

test('grounding wire: the service passes groundingHint (alongside scopeHint) into engine.phase1', async (t) => {
  // createServer(options.engine) is the documented test seam — wrap the
  // fake engine and record phase1's args, exactly as the real engine would
  // receive them (same contract scope_hint rides on).
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-grounding-wire-'));
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
    description: 'rotate the fal.ai API key',
    requester: 'test-requester',
    grounding_hint: 'light',
    scope_hint: 'single',
  });
  assert.equal(res.status, 202);
  await pollUntil(() => getJson(baseUrl, `/plan/${res.body.plan_id}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });

  assert.equal(phase1Args.length, 1, 'exactly one phase-1 call');
  assert.equal(phase1Args[0].groundingHint, 'light', 'engine.phase1 must receive the persisted grounding_hint');
  assert.equal(phase1Args[0].scopeHint, 'single', 'the scope hint rides the same arg contract, untouched');
});

// ---------------------------------------------------------------------------
// phase1Message — the `# GROUNDING` directive block
// ---------------------------------------------------------------------------

test('phase1Message: `light` injects the `# GROUNDING` block after `# SCOPE`; full/absent/unknown inject nothing (byte-identical)', () => {
  const base = { ask: 'do the thing', requester: 'test-requester', roleLens: 'business', runDir: '/tmp/run-x', outputLanguage: 'en' };

  const light = phase1Message({ ...base, groundingHint: 'light' });
  assert.match(light, /# GROUNDING/);
  assert.match(light, /MINIMIZE code exploration/);
  assert.match(light, /Lean on the coupling map and the ask itself/);
  assert.match(light, /Read at most a FEW files/);
  assert.match(light, /do NOT exhaustively grep or crawl the repos/);
  assert.match(light, /acceptable for this plan to\ncarry fewer code_anchors/);
  assert.match(light, /OVERRIDES your default grounding thoroughness/, 'the directive states it is the user decision, not a suggestion');
  // Placement: directives precede the ask so they govern the decomposition
  // instead of reading as request text; language still leads.
  assert.ok(light.indexOf('# GROUNDING') < light.indexOf('do the thing'), 'the GROUNDING block precedes the ask');
  assert.ok(light.startsWith('# OUTPUT LANGUAGE'), 'the language directive still leads');

  // Both directives present: SCOPE (what to produce) before GROUNDING (how
  // to verify it) — the deliberate order documented in engine.mjs.
  const both = phase1Message({ ...base, scopeHint: 'single', groundingHint: 'light' });
  assert.ok(both.indexOf('# SCOPE') < both.indexOf('# GROUNDING'), 'SCOPE precedes GROUNDING');
  assert.ok(both.indexOf('# GROUNDING') < both.indexOf('do the thing'), 'both precede the ask');

  // The asymmetric default, proven byte-for-byte: full/absent/unknown all
  // produce EXACTLY the pre-change message — today's behavior untouched.
  const noHint = phase1Message({ ...base });
  for (const hint of ['full', undefined, 'medium', 'constructor', 'toString']) {
    assert.equal(phase1Message({ ...base, groundingHint: hint }), noHint,
      `grounding "${hint}" must inject nothing — byte-identical to no hint`);
  }
});

// ---------------------------------------------------------------------------
// buildClaudeArgs — flat Phase-1 and plan-size-scaled Groom `--max-turns` caps
// ---------------------------------------------------------------------------

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test('buildClaudeArgs: light adds --max-turns to DECOMPOSE (flat) and GROOM (plan-size-scaled); env-overridable; full/absent argv stays byte-identical', (t) => {
  const prev = process.env.MERCURY_LIGHT_MAX_TURNS;
  t.after(() => {
    if (prev === undefined) delete process.env.MERCURY_LIGHT_MAX_TURNS;
    else process.env.MERCURY_LIGHT_MAX_TURNS = prev;
  });
  delete process.env.MERCURY_LIGHT_MAX_TURNS;

  // light + phase1 → the cap, with the default bound.
  const lightP1 = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1', groundingHint: 'light' });
  assert.equal(argValue(lightP1, '--max-turns'), '12', 'light decompose carries --max-turns with the default 12');

  // env override respected.
  process.env.MERCURY_LIGHT_MAX_TURNS = '5';
  const overridden = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1', groundingHint: 'light' });
  assert.equal(argValue(overridden, '--max-turns'), '5', 'MERCURY_LIGHT_MAX_TURNS override respected');

  // garbage overrides fall back to the default — never pass junk to the CLI.
  for (const junk of ['abc', '0', '-3', '2.5', '']) {
    process.env.MERCURY_LIGHT_MAX_TURNS = junk;
    const args = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1', groundingHint: 'light' });
    assert.equal(argValue(args, '--max-turns'), '12', `junk override "${junk}" falls back to 12`);
  }
  delete process.env.MERCURY_LIGHT_MAX_TURNS;

  // Groom is turn-capped for light grounding:
  // light groom is NOW capped too. The decompose-only cap left groom
  // re-crawling the repos per item (49 turns / $1.61, 94% of a real Light
  // plan's bill) even though it RESUMES decompose's grounded session. The groom
  // cap scales with plan size (base 6 + perItem 4 × itemCount; the fallback
  // n=4 applies here since itemCount is absent → 22) and — unlike a raw
  // truncation — never weakens verification: a groom that hits the cap yields
  // an incomplete artifact the deterministic gate rejects (fail-closed), never
  // a silent plan_ready. Full-mode groom stays uncapped (asserted in
  // groom-light.test.mjs).
  const lightGroom = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom', groundingHint: 'light' });
  assert.equal(argValue(lightGroom, '--max-turns'), '22', 'light groom is now turn-capped — base 6 + perItem 4 × the fallback n=4 (itemCount absent here)');

  // full/absent → byte-identical argv, no cap flag anywhere.
  const fullP1 = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1', groundingHint: 'full' });
  const absentP1 = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1' });
  assert.deepEqual(fullP1, absentP1, 'full and absent build the same argv');
  assert.equal(fullP1.includes('--max-turns'), false, 'full mode passes no cap — pre-change argv preserved');
});

// ---------------------------------------------------------------------------
// shape-gate surfacing — `grounding: light` in the context line
// ---------------------------------------------------------------------------

test('skeletonMessage: `grounding: light` is visible at the shape gate ONLY when light; full/legacy keep the exact original line', () => {
  const base = {
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'search history',
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] },
  };

  const light = skeletonMessage({ ...base, grounding_hint: 'light' });
  const ctx = light.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.match(ctx, /· grounding: light/, 'a shallow-grounded plan is visibly marked where it is approved');
  assert.match(ctx, /correctness NOT auto-checked/, 'the honest gate tail survives the addition');

  const full = skeletonMessage({ ...base, grounding_hint: 'full' });
  const ctxFull = full.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.equal(/grounding:/.test(ctxFull), false, 'full is the default — never surfaced');

  // Legacy plans (no grounding_hint) keep the exact original context line —
  // the same exact-string contract slack-plan-gate.test.mjs pins.
  const legacy = skeletonMessage(base);
  const ctxLegacy = legacy.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.equal(ctxLegacy, 'structure ✅ · correctness NOT auto-checked — you are the reviewer · cost so far $0.80');

  // The hint note composes with the fetch-before-plan fetch-failure note, not against it.
  const both = skeletonMessage({ ...base, grounding_hint: 'light', grounding: { ok: false } });
  const ctxBoth = both.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.match(ctxBoth, /· grounding: light ·/, 'the hint note precedes the fetch warning');
  assert.match(ctxBoth, /⚠ grounding fetch failed/);
});

// ---------------------------------------------------------------------------
// phase-timing observability
// ---------------------------------------------------------------------------

test('phase timing: the engine result carries {durationMs, numTurns, model}; the server emits the structured phase log for decompose AND groom', async (t) => {
  // (a) the engine-return seam — the fake reports plausible DETERMINISTIC
  // stubs so this stays byte-reproducible (never a real clock read).
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-timing-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const fake = createEngine('fake');
  const p1 = await fake.phase1({ runDir });
  assert.equal(p1.durationMs, 0);
  assert.equal(p1.numTurns, 1);
  assert.equal(p1.model, 'fake');
  const groomed = await fake.groom({ runDir, sessionId: p1.sessionId });
  assert.equal(groomed.durationMs, 0);
  assert.equal(groomed.numTurns, 1);
  assert.equal(groomed.model, 'fake');

  // (b) the server-side structured stderr line, captured by patching
  // console.error for the duration of the run (node:test runs the tests in
  // this file sequentially, so the global patch cannot race a sibling).
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  t.after(() => { console.error = originalError; });

  const res = await postJson(ctx.baseUrl, '/plan', {
    description: 'x'.repeat(50),
    requester: 'test-requester',
    grounding_hint: 'light',
  });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;
  const id8 = planId.slice(0, 8);

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  assert.ok(
    logged.includes(`[mercury] phase=decompose plan=${id8} model=fake grounding=light turns=1 duration_ms=0 cost_usd=0.8`),
    `the decompose phase log must carry the exact structured fields — got: ${JSON.stringify(logged)}`,
  );

  const approve = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approve.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready', { timeoutMs: 30000 });
  assert.ok(
    logged.includes(`[mercury] phase=groom plan=${id8} model=fake grounding=light turns=1 duration_ms=0 cost_usd=0.9`),
    `the groom phase log must carry the exact structured fields — got: ${JSON.stringify(logged)}`,
  );
});

// ---------------------------------------------------------------------------
// e2e — a light plan flows to shape_ready; the gate is untouched by grounding
// ---------------------------------------------------------------------------

test('grounding e2e (fake engine): a light plan flows to shape_ready — the deterministic skeleton gate is untouched by grounding depth', async (t) => {
  // The fake engine copies the fixture regardless of grounding depth —
  // deliberately: grounding is a prompt-level (+ argv) constraint on the
  // agent's exploration, never a new machine gate; the human at the shape
  // gate (who now SEES `grounding: light`) owns the depth trade-off.
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const res = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', grounding_hint: 'light' });
  assert.equal(res.status, 202);
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${res.body.plan_id}`),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.status, 'shape_ready', 'grounding depth never blocks the pipeline');
  assert.equal(shapeReady.body.grounding_hint, 'light', 'the hint survives to the gate view');
  assert.equal(shapeReady.body.skeleton_gate.ok, true);
});
