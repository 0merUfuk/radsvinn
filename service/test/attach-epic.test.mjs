// attach-epic.test.mjs — `plan.epic.existing_key` means "attach the tree under an epic
// ALREADY on the board" — the decomposer contract has always advertised it
// (prompts/decomposer.md: epic = `{temp_id, summary, why, existing_key|null}`)
// but create-tree.mjs ignored the field and unconditionally POSTed a fresh
// epic, avoiding a duplicate with a byte-identical summary.
//
// This file proves the SERVICE wire on the fake engine: a runDir plan.json
// whose epic carries existing_key produces a created-record with
// `attached_epic` set and NO Epic entry in `created[]` — created[] is what
// cleanup/cancel sweep (create-tree.mjs cancelOrder), and an epic Mercury did
// not create must never be transitioned. The real tool's attach behavior (GET
// verification before any write, no epic POST, L0 parenting under the
// existing key, die-on-typo, cleanup exclusion) is proven at the tool level
// with a stubbed fetch — see the round-2 report evidence.
//
// Same zero-network house pattern as the rest of the suite: fake engine,
// fresh tmp results dir per test, the REAL treecheck skeleton gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { CREATED_RECORD_FILENAME } from '../engine.mjs';
import { skeletonMessage, createdMessage, renderPlanText } from '../slack-blocks.mjs';

// Drives a fresh plan to plan_ready and returns { planId, runDir }.
async function driveToPlanReady(ctx) {
  const res = await postJson(ctx.baseUrl, '/plan', { description: 'add more tasks under the existing epic for history search', requester: 'test-requester' });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approved.status, 202);
  const ready = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(ready.body.status, 'plan_ready');
  return { planId, runDir: path.join(ctx.resultsDir, 'agent', `svc-${planId}`) };
}

test('existing_key wire (fake engine): plan.json with epic.existing_key → record carries attached_epic, created[] has NO Epic entry', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, runDir } = await driveToPlanReady(ctx);

  // Stage the decomposer's contract output: the groomed plan.json carries
  // epic.existing_key (the fake groom copies the fixture, whose key is
  // null — flip it the way a real decomposer run would have emitted it).
  const planJsonPath = path.join(runDir, 'plan.json');
  const planJson = JSON.parse(fs.readFileSync(planJsonPath, 'utf8'));
  planJson.epic.existing_key = 'PROJ-451';
  fs.writeFileSync(planJsonPath, JSON.stringify(planJson, null, 2));

  const creating = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(creating.status, 202);
  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(settled.body.status, 'created');

  const record = JSON.parse(fs.readFileSync(path.join(runDir, CREATED_RECORD_FILENAME), 'utf8'));
  assert.deepEqual(
    record.attached_epic,
    { temp_id: planJson.epic.temp_id, key: 'PROJ-451', summary: planJson.epic.summary },
    'the attachment is recorded OUTSIDE created[] as attached_epic {temp_id, key, summary}',
  );
  assert.ok(Array.isArray(record.created) && record.created.length > 0, 'the record still journals the created items');
  assert.equal(
    record.created.some((c) => c.type === 'Epic'),
    false,
    'created[] carries NO Epic entry — cleanup/cancel sweep created[] and must never transition an epic Mercury did not create',
  );
  // The public view's created marker mirrors the record's created[] — the
  // attached epic never rides items/keys (cancel keys off this marker's
  // record) but DOES ride the marker's own attached_epic field, so the
  // terminal Slack surface (createdMessage) can render the attach target.
  assert.equal(settled.body.created.items.some((c) => c.type === 'Epic'), false);
  assert.deepEqual(
    settled.body.created.attached_epic,
    { temp_id: planJson.epic.temp_id, key: 'PROJ-451', summary: planJson.epic.summary },
    'engine.create lifts attached_epic onto the created marker and toPublicView surfaces it',
  );
});

test('existing_key wire (fake engine): a null existing_key keeps the pre-fix shape — Epic in created[], no attached_epic', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const { planId, runDir } = await driveToPlanReady(ctx);
  // No staging: the fixture plan.json ships existing_key: null.

  const creating = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(creating.status, 202);
  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(settled.body.status, 'created');

  const record = JSON.parse(fs.readFileSync(path.join(runDir, CREATED_RECORD_FILENAME), 'utf8'));
  assert.equal(record.attached_epic, undefined, 'no attach → no attached_epic key at all');
  assert.equal(record.created.some((c) => c.type === 'Epic'), true, 'the epic is created and journaled as before');
  assert.equal(settled.body.created.attached_epic, undefined, 'no attach → the public created marker carries no attached_epic either');
});

// ---------------------------------------------------------------------------
// Attach-mode visibility. The create-time GET
// only proves the key EXISTS and is an Epic — a hallucinated-but-VALID
// existing_key passes it, so the HUMAN gates are the only check that the
// attach target is the intended one. These tests pin the attach target onto
// every human surface: the shape gate (skeletonMessage), the full-truth file
// at the create gate (renderPlanText), and the terminal created message
// (createdMessage) — and pin its ABSENCE when there is no attach, so the
// legacy exact-string contracts (slack-plan-gate.test.mjs) stay intact.
// ---------------------------------------------------------------------------

test('skeletonMessage: renders "↷ attaches to existing <KEY>" on the header ONLY when skeleton.epic.existing_key is set', () => {
  const base = {
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'add tasks under the existing epic',
    skeleton: {
      epic: { temp_id: 'e1', summary: 'existing epic', why: 'w', existing_key: 'PROJ-451' },
      items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }],
    },
  };

  const attached = skeletonMessage(base);
  const header = attached.blocks[0].text.text;
  assert.match(header, /↷ attaches to existing \*PROJ-451\*/, 'the attach target is prominent on the header section');

  // Escaped like every skeleton-derived value: a hostile "key" must not
  // smuggle mrkdwn through the header (the tool would reject it at create,
  // but the shape gate renders BEFORE create).
  const hostile = skeletonMessage({
    ...base,
    skeleton: { ...base.skeleton, epic: { ...base.skeleton.epic, existing_key: '<!channel>' } },
  });
  assert.equal(hostile.blocks[0].text.text.includes('<!channel>'), false, 'the raw control sequence never survives');
  assert.match(hostile.blocks[0].text.text, /&lt;!channel&gt;/, 'the key is entity-escaped');

  // Absent / null / blank → no attach line at all (legacy shape preserved).
  for (const epic of [undefined, { temp_id: 'e1', summary: 's', why: 'w', existing_key: null }, { temp_id: 'e1', summary: 's', why: 'w', existing_key: '   ' }]) {
    const msg = skeletonMessage({ ...base, skeleton: { ...base.skeleton, epic } });
    assert.equal(msg.blocks[0].text.text.includes('attaches to existing'), false, `epic=${JSON.stringify(epic)} must not render an attach line`);
  }
});

test('renderPlanText: the EPIC line appends "(attaches to existing <KEY>)" only when plan.epic.existing_key is set', () => {
  const base = {
    plan_id: 'PID',
    skeleton: { items: [] },
    plan: { epic: { temp_id: 'e1', summary: 'Search history', why: 'w', existing_key: 'PROJ-451' }, items: [] },
  };
  const text = renderPlanText(base);
  assert.match(text, /^EPIC: Search history \(attaches to existing PROJ-451\)$/m, 'the full-truth file names the attach target on the EPIC line');

  const noAttach = renderPlanText({ ...base, plan: { ...base.plan, epic: { temp_id: 'e1', summary: 'Search history', why: 'w', existing_key: null } } });
  assert.match(noAttach, /^EPIC: Search history$/m, 'no attach → the EPIC line keeps its exact legacy shape');
  assert.equal(noAttach.includes('attaches to existing'), false);
});

test('createdMessage: renders "↷ attached under <KEY>" with a browse link only when the created marker carries attached_epic', () => {
  const attached = createdMessage({
    plan_id: 'PID-1',
    created: {
      keys: ['PROJ-1000'],
      verify_ok: true,
      attached_epic: { temp_id: 'e1', key: 'PROJ-451', summary: 'existing epic' },
    },
  });
  const section = attached.blocks[0].text.text;
  assert.match(
    section,
    /↷ attached under <https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-451\|PROJ-451>/,
    'the attach target renders as a browse link at the terminal surface',
  );
  assert.match(section, /PROJ-1000/, 'the created keys still render');
  assert.match(section, /verify: ✅/, 'the verify line survives');

  // Absent / keyless → no attached line (legacy exact shape preserved).
  const plain = createdMessage({ plan_id: 'PID-2', created: { keys: ['PROJ-100'], verify_ok: true } });
  assert.equal(plain.blocks[0].text.text.includes('attached under'), false);
  const keyless = createdMessage({ plan_id: 'PID-3', created: { keys: ['PROJ-100'], verify_ok: true, attached_epic: { temp_id: 'e1' } } });
  assert.equal(keyless.blocks[0].text.text.includes('attached under'), false, 'a malformed attached_epic without a key renders nothing rather than a broken link');
});
