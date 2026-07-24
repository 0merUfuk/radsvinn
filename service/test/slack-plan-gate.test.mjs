// slack-plan-gate.test.mjs — content-visible and truthful create-gate rendering:
// gate renders actual ticket CONTENT, uploads the full plan text in-thread,
// and both gate surfaces state honestly what was (and was not) checked.
//
// Same zero-network house pattern as slack.test.mjs: pure block builders are
// exercised directly; the poller's upload leg is driven through recorded-calls
// fake fetches — no sockets, no real Slack.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from '../slack.mjs';
import { skeletonMessage, planReadyMessage, renderPlanText } from '../slack-blocks.mjs';

const FAKE_ENV = { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' };
const SILENT_LOG = { error() {}, log() {} };

const fixtureGroomedPlan = JSON.parse(readFileSync(new URL('../../fixtures/e2e-sample/plan.json', import.meta.url), 'utf8'));
const fixtureSkeleton = JSON.parse(readFileSync(new URL('../../fixtures/e2e-sample/skeleton.json', import.meta.url), 'utf8'));

/** The shape GET /plan/{id} (toPublicView) hands the message builders. */
function fixturePublicPlan(overrides = {}) {
  return {
    plan_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
    status: 'plan_ready',
    cost_usd: 1.7,
    skeleton: fixtureSkeleton,
    plan: fixtureGroomedPlan,
    plan_gate: { ok: true },
    duplicate_search: { ok: true, output: 'no matches (fake)' },
    ...overrides,
  };
}

function sectionTexts(msg) {
  return msg.blocks.filter((b) => b.type === 'section' && b.text).map((b) => b.text.text);
}

function contextTexts(msg) {
  return msg.blocks.filter((b) => b.type === 'context').flatMap((b) => b.elements.map((e) => e.text));
}

function assertSlackBudgets(msg) {
  assert.ok(msg.blocks.length <= 50, `Slack caps a message at 50 blocks — got ${msg.blocks.length}`);
  for (const text of sectionTexts(msg)) {
    assert.ok(text.length <= 3000, `Slack caps a section text at 3000 chars — got ${text.length}`);
  }
}

/** A synthetic groomed item with controllable field sizes. */
function syntheticItem(n, { anchors, whyLen = 40 } = {}) {
  return {
    temp_id: `i${n}`,
    type: 'Task',
    effort_tier: 'low',
    fields: {
      why: `why for item ${n} `.padEnd(whyLen, 'w'),
      definition_of_done: `done when item ${n} works`,
      acceptance_criteria: [`item ${n} criterion one`, `item ${n} criterion two`],
      related_links: { code_anchors: anchors || [`web-app:src/item${n}.ts:Symbol${n}`], external: [] },
      technical_analysis: { prose: `analysis for item ${n}`, coupling_zones: ['none'] },
    },
  };
}

function syntheticPlan(itemCount, itemOverrides = {}) {
  const items = [];
  for (let n = 1; n <= itemCount; n += 1) items.push(syntheticItem(n, itemOverrides));
  return fixturePublicPlan({
    plan: { plan_id: 'synthetic', epic: { summary: 'synthetic epic', why: 'because' }, items },
    skeleton: { items: items.map((i) => ({ temp_id: i.temp_id, type: i.type, one_line_summary: `summary of ${i.temp_id}` })) },
  });
}

// ---------------------------------------------------------------------------
// content-visible gate — rich tier: the gate shows actual ticket content
// ---------------------------------------------------------------------------

// The blocks render the mrkdwn-ESCAPED form of every plan-derived field
// (Slack's escaping rules: & < > → entities, applied before truncation) —
// expected values must go through the same transform. Fixture i2's ACs
// really contain `<term>`, so this is exercised, not theoretical.
function mrkdwnEscaped(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('planReadyMessage rich tier: every fixture item\'s why/DoD/AC/TA/anchors reach the blocks — the gate is no longer blind', () => {
  const plan = fixturePublicPlan();
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n\n');

  for (const item of fixtureGroomedPlan.items) {
    const f = item.fields;
    // Truncation starts at 300 (why/DoD/TA) and 150 (AC), measured AFTER
    // escaping — a 100-char prefix of every escaped field must therefore
    // survive verbatim.
    assert.ok(joined.includes(mrkdwnEscaped(f.why).slice(0, 100)), `${item.temp_id} why must be rendered`);
    assert.ok(joined.includes(mrkdwnEscaped(f.definition_of_done).slice(0, 100)), `${item.temp_id} DoD must be rendered`);
    assert.ok(joined.includes(mrkdwnEscaped(f.technical_analysis.prose).slice(0, 100)), `${item.temp_id} TA prose must be rendered`);
    for (const ac of f.acceptance_criteria) {
      assert.ok(joined.includes(mrkdwnEscaped(ac).slice(0, 100)), `${item.temp_id} AC "${ac.slice(0, 40)}…" must be rendered`);
    }
    for (const anchor of f.related_links.code_anchors) {
      // Fixture anchors carry no mrkdwn control chars or backticks, so the
      // escaped form IS the verbatim path.
      assert.ok(joined.includes(`\`${anchor}\``), `${item.temp_id} anchor ${anchor} must be rendered verbatim in backticks`);
    }
  }

  // Summaries come from the skeleton lookup.
  for (const item of fixtureSkeleton.items) {
    assert.ok(joined.includes(item.one_line_summary), `${item.temp_id} skeleton summary must be rendered`);
  }

  // The rich per-item labels are present (this IS the rich tier).
  assert.match(joined, /\*Why:\*/);
  assert.match(joined, /\*DoD:\*/);
  assert.match(joined, /\*AC:\*/);
  assert.match(joined, /\*TA:\*/);
  assert.match(joined, /\*Anchors:\*/);

  // gate-truthfulness — the honest gate line (plan_gate ran → anchors were really checked).
  const contexts = contextTexts(msg);
  assert.ok(
    contexts.includes('structure ✅ · anchors resolve ✅ · correctness NOT auto-checked — you are the reviewer'),
    'the create gate must state exactly what was and was not checked',
  );
  // Rich tier carries everything inline — no file pointer line.
  assert.equal(contexts.some((t) => /full ticket text/.test(t)), false, 'the file pointer line is compact-only');

  // Header, dup line, cost, buttons — EXACTLY as before content-visible gate.
  assert.match(msg.blocks[0].text.text, /Groomed & gate-checked/);
  assert.ok(contexts.some((t) => /no matches/.test(t) && /cost \$1\.70/.test(t)));
  const actions = msg.blocks.at(-1);
  assert.equal(actions.type, 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['create', 'reject']);
  assert.equal(actions.elements[0].text.text, 'Create in Jira');
  assert.equal(actions.elements[0].style, 'primary');
  assert.equal(actions.elements[0].value, plan.plan_id);
  assert.equal(actions.elements[1].style, 'danger');

  assertSlackBudgets(msg);
});

test('planReadyMessage rich tier: anchor paths are never truncated; >8 anchors show 8 + an honest overflow count', () => {
  const longAnchors = [];
  for (let n = 1; n <= 10; n += 1) {
    longAnchors.push(`web-app:src/features/user/components/very/deeply/nested/path/number/${n}/GenerationHistorySearchPanel.tsx:useGenerationSearchQueryParam${n}`);
  }
  const plan = syntheticPlan(1, { anchors: longAnchors });
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');

  assert.match(joined, /\*Anchors:\*/, 'stays rich — 1 item, section under budget');
  for (const anchor of longAnchors.slice(0, 8)) {
    assert.ok(joined.includes(`\`${anchor}\``), 'the first 8 paths must appear COMPLETE — a truncated path is a lie');
  }
  assert.equal(joined.includes(longAnchors[8]), false, 'the 9th anchor is dropped whole, never cut');
  assert.equal(joined.includes(longAnchors[9]), false);
  assert.match(joined, /…and 2 more/);
  assertSlackBudgets(msg);
});

test('planReadyMessage rich tier: >6 ACs show 6 + overflow count; long fields carry a visible truncation mark', () => {
  const plan = syntheticPlan(1);
  plan.plan.items[0].fields.acceptance_criteria = ['ac-one', 'ac-two', 'ac-three', 'ac-four', 'ac-five', 'ac-six', 'ac-seven', 'ac-eight'];
  plan.plan.items[0].fields.why = 'W'.repeat(500);
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');

  assert.match(joined, /• ac-six/);
  assert.equal(/• ac-seven/.test(joined), false);
  assert.match(joined, /…and 2 more/);
  assert.match(joined, new RegExp(`\\*Why:\\* W{300}…`), 'a cut field ends in … so the reviewer knows to open the file');
});

// ---------------------------------------------------------------------------
// content-visible gate — the rich→compact threshold and compact budgets
// ---------------------------------------------------------------------------

test('planReadyMessage: 9 items tip the gate into the compact tier (one content line per item + the file pointer)', () => {
  const plan = syntheticPlan(9);
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');

  assert.equal(/\*Why:\*/.test(joined), false, '9 items must not render rich');
  for (let n = 1; n <= 9; n += 1) {
    assert.ok(joined.includes(`*Task* summary of i${n} — why: why for item ${n}`), `item i${n} compact line present`);
    assert.ok(joined.includes(`AC:2 · anchors:1 · zones:none · effort:low`), 'counts survive in the compact line');
  }
  // The pointer says "see the attached file … (or GET /plan/{id})", never
  // "attached below" — the upload leg can fail after this message posted,
  // so the pointer must not assert a file that may never arrive.
  assert.ok(
    contextTexts(msg).includes(`full ticket text: see the attached file in this thread (or GET /plan/${plan.plan_id})`),
    'compact must point the reviewer at the full-truth file without over-claiming its presence',
  );
  assertSlackBudgets(msg);
});

test('planReadyMessage: a single oversized rich section (long untruncatable anchors) also tips into compact', () => {
  // 8 anchors × ~380 chars each ≈ 3100 rendered — over the 2900 per-section
  // budget even though the item count (2) is small. Paths are never cut, so
  // the whole message must fall back to compact instead.
  const hugeAnchors = [];
  for (let n = 1; n <= 8; n += 1) hugeAnchors.push(`web-app:${'x'.repeat(370)}:Sym${n}`);
  const plan = syntheticPlan(2, { anchors: hugeAnchors });
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');

  assert.equal(/\*Anchors:\*/.test(joined), false, 'must not render rich when a section would burst 2900');
  assert.match(joined, /anchors:8/, 'compact still reports the anchor count');
  assert.ok(contextTexts(msg).some((t) => /see the attached file/.test(t)));
  assertSlackBudgets(msg);
});

test('planReadyMessage: a synthetic 20-item plan holds every Slack budget in compact', () => {
  const plan = syntheticPlan(20, { whyLen: 120 });
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');

  for (let n = 1; n <= 20; n += 1) {
    assert.ok(joined.includes(`summary of i${n}`), `all 20 items must be listed (i${n})`);
  }
  assert.ok(contextTexts(msg).some((t) => /see the attached file/.test(t)));
  assert.equal(msg.blocks[0].text.text.includes('Groomed & gate-checked'), true);
  assert.equal(msg.blocks.at(-1).type, 'actions', 'the buttons survive compaction');
  assertSlackBudgets(msg);
});

// ---------------------------------------------------------------------------
// gate-truthfulness — honest gate lines on both surfaces
// ---------------------------------------------------------------------------

test('gate-truthfulness skeletonMessage: the shape gate says structure-only, never "gate OK" — the human is the correctness check', () => {
  const msg = skeletonMessage({
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'search history',
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] },
  });
  const contexts = contextTexts(msg);
  assert.ok(
    contexts.includes('structure ✅ · correctness NOT auto-checked — you are the reviewer · cost so far $0.80'),
    `exact honest gate line expected, got: ${JSON.stringify(contexts)}`,
  );
  assert.equal(contexts.some((t) => /treecheck OK/.test(t)), false, 'the old overclaiming line must be gone');
});

test('skeletonMessage: an advisory over-cap sizing WARN surfaces a concise oversized-ticket nudge in the context (non-blocking)', () => {
  // 2026-07-13 sizing-warn demotion: the leaf-cost cap no longer blocks the
  // shape gate, so an over-cap leaf reaches this pass line carrying a
  // non-blocking sizing_sane WARN. The reviewer must still SEE it — mirroring
  // how the zero-anchor flag / grounding note are surfaced.
  const gate = {
    ok: true,
    raw: {
      ok: true,
      checks: {
        sizing_sane: {
          pass: true,
          complaints: [
            'WARN: i1: leaf predicted_cost_usd $48.00 exceeds $10.00 — consider splitting (advisory)',
            'WARN: i2: leaf predicted_cost_usd $22.00 exceeds $10.00 — consider splitting (advisory)',
          ],
        },
      },
    },
  };
  const msg = skeletonMessage({
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'search history',
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] },
    skeleton_gate: gate,
  });
  const ctx = contextTexts(msg).join(' | ');
  assert.match(ctx, /⚠ 2 oversized tickets — consider splitting/, 'the count + advisory is surfaced');
  assert.match(ctx, /structure ✅/, 'still a PASS gate — the WARN is informational, not a block');
});

test('skeletonMessage: one advisory over-cap WARN reads singular; the warn-band / floor WARNs are NOT counted', () => {
  const gate = {
    ok: true,
    raw: {
      ok: true,
      checks: {
        sizing_sane: {
          pass: true,
          complaints: [
            'WARN: i1: leaf predicted_cost_usd $48.00 exceeds $10.00 — consider splitting (advisory)',
            'WARN: i2: leaf predicted_cost_usd $8.00 is in the warn band (> $7.50) — consider splitting',
            'WARN: i3: leaf predicted_cost_usd $1.00 is below the min $2.00 — a leaf this small is a fold candidate; consider merging it into a sibling or parent (non-blocking)',
          ],
        },
      },
    },
  };
  const msg = skeletonMessage({ plan_id: 'PID', cost_usd: 0.8, description: 'x', skeleton: { items: [] }, skeleton_gate: gate });
  const ctx = contextTexts(msg).join(' | ');
  assert.match(ctx, /⚠ 1 oversized ticket — consider splitting/, 'singular for a single over-cap leaf');
  assert.doesNotMatch(ctx, /oversized tickets/, 'the warn-band and micro-leaf-floor WARNs are a different signal, not counted');
});

test('skeletonMessage: no sizing WARN (or no gate at all) keeps the exact legacy context line — no oversized nudge', () => {
  const noGate = skeletonMessage({ plan_id: 'PID', cost_usd: 0.8, description: 'x', skeleton: { items: [] } });
  assert.equal(contextTexts(noGate).some((t) => t.includes('oversized')), false, 'no gate → no nudge');
  const passNoWarn = skeletonMessage({
    plan_id: 'PID', cost_usd: 0.8, description: 'x', skeleton: { items: [] },
    skeleton_gate: { ok: true, raw: { ok: true, checks: { sizing_sane: { pass: true } } } },
  });
  assert.equal(contextTexts(passNoWarn).some((t) => t.includes('oversized')), false, 'a clean sizing check → no nudge');
});

test('gate-truthfulness planReadyMessage: the gate line fails CLOSED — only a present, non-skipped, ok plan gate earns ANY ✅ (structure included)', () => {
  // A fake createServer translates MERCURY_SKIP_PLAN_ANCHORS=1 into
  // {ok:true, skipped:true}; that skips the WHOLE plan gate (structure AND
  // anchors), so `structure ✅` must not print either.
  const skipped = planReadyMessage(fixturePublicPlan({ plan_gate: { ok: true, skipped: true } }));
  assert.ok(
    contextTexts(skipped).includes('plan gate skipped — not checked · correctness NOT auto-checked — you are the reviewer'),
    'a skipped plan gate must claim nothing — not anchors, not structure',
  );

  // Fail closed: an ABSENT plan_gate (the service never reported a gate
  // result at all) must read as not-checked too. The original build
  // rendered an optimistic ✅ here — flipped by the QA fix rounds.
  const absent = planReadyMessage(fixturePublicPlan({ plan_gate: undefined }));
  assert.ok(
    contextTexts(absent).includes('plan gate: no result — not checked · correctness NOT auto-checked — you are the reviewer'),
    'a missing plan gate must claim nothing — not anchors, not structure',
  );

  // Defensive: plan_ready should never carry a failed gate (the worker
  // routes a red gate to `failed`), but if it ever does — never a ✅.
  const failedGate = planReadyMessage(fixturePublicPlan({ plan_gate: { ok: false } }));
  assert.ok(
    contextTexts(failedGate).includes('plan gate failed ❌ · correctness NOT auto-checked — you are the reviewer'),
    'a failed plan gate must never render any ✅',
  );

  // No ✅ of any kind survives on the three not-passed variants.
  for (const msg of [skipped, absent, failedGate]) {
    assert.equal(contextTexts(msg).some((t) => t.includes('structure ✅') || t.includes('anchors resolve ✅')), false,
      'no not-passed gate variant may print a ✅ segment');
  }

  const checked = planReadyMessage(fixturePublicPlan({ plan_gate: { ok: true } }));
  assert.ok(
    contextTexts(checked).includes('structure ✅ · anchors resolve ✅ · correctness NOT auto-checked — you are the reviewer'),
  );
});

test('B5 planReadyMessage: the create gate signals a light-grounded GROOM (mirrors the shape gate); full/legacy show nothing', () => {
  // B5 extends light grounding to GROOM, whose output THIS gate reviews — so
  // the approver must see it before clicking Create (the same asymmetric-
  // default rubber-stamp guard the shape gate already applies at shape_ready).
  const light = planReadyMessage(fixturePublicPlan({ grounding_hint: 'light' }));
  assert.ok(
    contextTexts(light).some((t) => t.includes('grounding: light (groom ran reduced exploration)')),
    'a light-grounded plan must mark the create gate so the approver knows groom ran reduced exploration',
  );

  // full and legacy (absent) plans keep the exact original context line.
  const full = planReadyMessage(fixturePublicPlan({ grounding_hint: 'full' }));
  const legacy = planReadyMessage(fixturePublicPlan({ grounding_hint: undefined }));
  for (const msg of [full, legacy]) {
    assert.equal(contextTexts(msg).some((t) => /grounding: light/.test(t)), false,
      'full/legacy plans must not render the light grounding note');
  }
});

// ---------------------------------------------------------------------------
// renderPlanText — the full-truth file body
// ---------------------------------------------------------------------------

test('renderPlanText: the COMPLETE fixture content is present untruncated — including the longest field', () => {
  const plan = fixturePublicPlan();
  const text = renderPlanText(plan);

  assert.ok(text.includes(fixtureGroomedPlan.epic.summary));
  assert.ok(text.includes(fixtureGroomedPlan.epic.why));

  let longestField = '';
  for (const item of fixtureGroomedPlan.items) {
    const f = item.fields;
    assert.ok(text.includes(f.why), `${item.temp_id} why must be complete`);
    assert.ok(text.includes(f.definition_of_done), `${item.temp_id} DoD must be complete`);
    assert.ok(text.includes(f.technical_analysis.prose), `${item.temp_id} TA prose must be complete`);
    for (const ac of f.acceptance_criteria) assert.ok(text.includes(ac), `${item.temp_id} AC must be complete`);
    for (const anchor of f.related_links.code_anchors) assert.ok(text.includes(anchor), `${item.temp_id} anchor must be complete`);
    for (const candidate of [f.why, f.definition_of_done, f.technical_analysis.prose, ...f.acceptance_criteria]) {
      if (candidate.length > longestField.length) longestField = candidate;
    }
    assert.ok(text.includes(`Effort: ${item.effort_tier}`));
  }
  assert.ok(longestField.length > 300, `sanity: the fixture's longest field (${longestField.length} chars) exceeds every Slack-side truncation`);
  assert.ok(text.includes(longestField), 'the single longest field is present verbatim');
  // (No zero-'…' assertion: the fixture's own DoD text legitimately contains
  // an ellipsis — verbatim inclusion of every full field is the real proof.)
});

test('renderPlanText: deterministic, plan-ordered, with skeleton summaries and item separators', () => {
  const plan = fixturePublicPlan();
  const first = renderPlanText(plan);
  assert.equal(renderPlanText(plan), first, 'same input → byte-identical output');

  const i1 = first.indexOf('[1/3] Task i1 — Add prompt-text search index migration for generations');
  const i2 = first.indexOf('[2/3] Story i2 — Add prompt-text filter to generation history endpoint');
  const i3 = first.indexOf('[3/3] Story i3 — Add prompt search input to history page');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, 'items render in plan order with skeleton summaries');
  assert.ok(first.includes(`plan: ${plan.plan_id}`));
});

// ---------------------------------------------------------------------------
// poller upload leg — the 3-step external upload, and graceful degradation
// ---------------------------------------------------------------------------

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

const PLAN_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const UPLOAD_URL = 'https://files.slack.com/upload/v1/CwABAAAA';
const GATE_TS = '1730000001.000001';

function makePlanReadyBridge(slackResponder) {
  const publicPlan = fixturePublicPlan();
  const serviceFetch = makeRecordingFetch((call) =>
    (call.url.endsWith(`/plan/${PLAN_ID}`) ? fakeResponse(200, publicPlan) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(slackResponder);
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(PLAN_ID, { channel: 'C1', requester: 'test-requester', description: 'search history', lastStatus: 'grooming', messageTs: undefined });
  return { bridge, slackFetch, publicPlan };
}

function happyPathResponder(call) {
  if (call.url.endsWith('chat.postMessage')) return fakeResponse(200, { ok: true, ts: GATE_TS, channel: 'C1' });
  if (call.url.endsWith('files.getUploadURLExternal')) return fakeResponse(200, { ok: true, upload_url: UPLOAD_URL, file_id: 'F-42' });
  if (call.url === UPLOAD_URL) return fakeResponse(200, {});
  if (call.url.endsWith('files.completeUploadExternal')) return fakeResponse(200, { ok: true });
  return fakeResponse(200, { ok: true });
}

test('poller plan_ready: gate message first, then the exact 3-step external upload into its thread', async () => {
  const { bridge, slackFetch, publicPlan } = makePlanReadyBridge(happyPathResponder);
  await bridge.pollOnce();

  const urls = slackFetch.calls.map((c) => c.url);
  const postIdx = urls.findIndex((u) => u.endsWith('chat.postMessage'));
  const getUrlIdx = urls.findIndex((u) => u.endsWith('files.getUploadURLExternal'));
  const bytesIdx = urls.findIndex((u) => u === UPLOAD_URL);
  const completeIdx = urls.findIndex((u) => u.endsWith('files.completeUploadExternal'));
  assert.ok(postIdx >= 0 && getUrlIdx > postIdx && bytesIdx > getUrlIdx && completeIdx > bytesIdx,
    `the gate message must post FIRST, then getUploadURLExternal → bytes → complete; got ${JSON.stringify(urls)}`);

  // The plan actually rendered — content, not the plan object.
  const expectedContent = renderPlanText({ ...publicPlan, description: 'search history' });

  // Step 1: form-encoded — the current docs accept BOTH form and JSON for
  // files.getUploadURLExternal; form matches the docs' own example and keeps
  // the bridge's deviation from slackApi self-contained. Sent with the BYTE
  // length of the utf-8 content — not the JS string length (the fixture is
  // full of multi-byte em-dashes, so the two must differ).
  const getUrlCall = slackFetch.calls[getUrlIdx];
  assert.equal(getUrlCall.method, 'POST');
  assert.equal(getUrlCall.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(getUrlCall.headers.Authorization, 'Bearer xoxb-test-token');
  const params = new URLSearchParams(getUrlCall.body);
  assert.equal(params.get('filename'), 'mercury-plan-99999999.txt', 'filename = mercury-plan-<plan_id first 8>.txt');
  assert.equal(params.get('length'), String(Buffer.byteLength(expectedContent, 'utf8')));
  assert.notEqual(Number(params.get('length')), expectedContent.length,
    'sanity: byte length must differ from char length here — proving bytes were counted');

  // Step 2: the raw bytes go to the returned upload_url.
  const bytesCall = slackFetch.calls[bytesIdx];
  assert.equal(bytesCall.method, 'POST');
  assert.equal(bytesCall.body, expectedContent, 'the file body is the full rendered plan text');

  // Step 3: JSON complete, attached into the gate message's thread.
  const completeCall = JSON.parse(slackFetch.calls[completeIdx].body);
  assert.deepEqual(completeCall.files, [{ id: 'F-42', title: 'Full plan — read before Create' }]);
  assert.equal(completeCall.channel_id, 'C1');
  assert.equal(completeCall.thread_ts, GATE_TS, 'the file lands in the thread of the gate message');

  // Success → exactly one chat.postMessage (the gate), no warning reply.
  assert.equal(urls.filter((u) => u.endsWith('chat.postMessage')).length, 1);
});

const SCOPE_HINT = /the Slack app is missing the files:write scope — an admin must add it/;

for (const [label, responder, reasonPattern, expectScopeHint] of [
  ['step 1 fails (missing files:write scope)', (call) => {
    if (call.url.endsWith('files.getUploadURLExternal')) return fakeResponse(200, { ok: false, error: 'missing_scope' });
    return happyPathResponder(call);
  }, /missing_scope/, true],
  ['step 2 fails (upload_url POST non-ok)', (call) => {
    if (call.url === UPLOAD_URL) return fakeResponse(500, {});
    return happyPathResponder(call);
  }, /upload POST failed: HTTP 500/, false],
  ['step 3 fails (completeUploadExternal not ok)', (call) => {
    if (call.url.endsWith('files.completeUploadExternal')) return fakeResponse(200, { ok: false, error: 'invalid_auth' });
    return happyPathResponder(call);
  }, /invalid_auth/, false],
  ['network throw mid-upload', (call) => {
    if (call.url.endsWith('files.getUploadURLExternal')) throw new Error('network down');
    return happyPathResponder(call);
  }, /network down/, false],
]) {
  test(`poller plan_ready degradation: ${label} → gate still posted, visible thread warning, pollOnce never throws`, async () => {
    const { bridge, slackFetch } = makePlanReadyBridge(responder);
    await assert.doesNotReject(() => bridge.pollOnce(), 'an upload failure must never take down the poller');

    const posts = slackFetch.calls
      .filter((c) => c.url.endsWith('chat.postMessage'))
      .map((c) => JSON.parse(c.body));
    assert.equal(posts.length, 2, 'the gate message AND the warning reply');
    assert.match(posts[0].blocks[0].text.text, /Groomed & gate-checked/, 'the gate message posts FIRST, unblocked');
    assert.equal(posts[1].thread_ts, GATE_TS, 'the warning lands in the gate thread');
    assert.match(posts[1].text, /⚠️ could not attach the full plan file/);
    assert.match(posts[1].text, reasonPattern, 'the warning names the reason');
    assert.match(posts[1].text, new RegExp(`GET /plan/${PLAN_ID}`), 'and points at the always-available full content');
    // missing_scope is the one failure a retry can never fix — the warning
    // must name the scope AND who acts; every other reason must NOT carry
    // the hint (it would send an admin chasing the wrong cause).
    if (expectScopeHint) {
      assert.match(posts[1].text, SCOPE_HINT, 'the missing-scope warning is actionable');
    } else {
      assert.doesNotMatch(posts[1].text, SCOPE_HINT, 'no false scope hint on unrelated failures');
    }
  });
}

test('poller plan_ready degradation: gate post itself fails → upload skipped, plain-text FALLBACK pointer posts instead, no throw', async () => {
  const posts = [];
  const { bridge, slackFetch } = makePlanReadyBridge((call) => {
    if (call.url.endsWith('chat.postMessage')) {
      const body = JSON.parse(call.body);
      posts.push(body);
      // The gate message (carries blocks) fails; the plain-text fallback
      // (deliberately block-free — nothing that can fail the same way)
      // succeeds.
      return body.blocks
        ? fakeResponse(200, { ok: false, error: 'invalid_blocks' })
        : fakeResponse(200, { ok: true, ts: '1730000002.000002', channel: 'C1' });
    }
    return happyPathResponder(call);
  });
  await assert.doesNotReject(() => bridge.pollOnce());
  const urls = slackFetch.calls.map((c) => c.url);
  assert.equal(urls.some((u) => u.endsWith('files.getUploadURLExternal')), false, 'no ts → nothing to thread onto → no upload attempt');
  assert.equal(posts.length, 2, 'the failed gate attempt AND the plain-text fallback');
  assert.equal(posts[1].blocks, undefined, 'the fallback is plain text');
  assert.match(posts[1].text, /could not be rendered \(invalid_blocks\)/);
  assert.match(posts[1].text, new RegExp(`GET /plan/${PLAN_ID}`), 'the fallback carries the full-content pointer');
});

test('poller plan_ready degradation: gate post AND its fallback both fail (channel gone) → pollOnce still never throws', async () => {
  const { bridge, slackFetch } = makePlanReadyBridge((call) => {
    if (call.url.endsWith('chat.postMessage')) return fakeResponse(200, { ok: false, error: 'channel_not_found' });
    return happyPathResponder(call);
  });
  await assert.doesNotReject(() => bridge.pollOnce());
  assert.equal(
    slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).length,
    2,
    'both the gate attempt and the best-effort fallback were made',
  );
});
