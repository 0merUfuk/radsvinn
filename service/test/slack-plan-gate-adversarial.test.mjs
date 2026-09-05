// slack-plan-gate-adversarial.test.mjs — QA adversarial pass over content-visible gate + gate-truthfulness
// Covers hostile plan content, exact tier boundaries,
// skeleton/plan mismatches, degenerate plans, upload-leg failure isolation,
// and the honest-gate sweep. Complements the developer's
// slack-plan-gate.test.mjs; same zero-network house pattern.
//
// NOTE: two of these tests started life as DELIBERATE FAILING REPROS of
// real bugs found during QA (mrkdwn escaping; surrogate-splitting
// truncation). Both bugs are now fixed in slack-blocks.mjs and the repros
// live on below as ordinary green regression tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBridge } from '../slack.mjs';
import {
  skeletonMessage,
  planReadyMessage,
  renderPlanText,
  createdMessage,
  cancelledMessage,
  terminalMessage,
  preparingMessage,
} from '../slack-blocks.mjs';

const FAKE_ENV = { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' };
const SILENT_LOG = { error() {}, log() {} };

const fixtureGroomedPlan = JSON.parse(readFileSync(new URL('../../fixtures/e2e-sample/plan.json', import.meta.url), 'utf8'));
const fixtureSkeleton = JSON.parse(readFileSync(new URL('../../fixtures/e2e-sample/skeleton.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// shared helpers (self-contained — importing the sibling test file would run
// its tests twice)
// ---------------------------------------------------------------------------

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

/**
 * The REAL Slack budgets (50 blocks / 3000 chars per section text), plus the
 * structural invariants every gate message must keep no matter how hostile
 * the plan content is: header section first, actions block last, both
 * buttons wired to the plan id, and the whole payload JSON-round-trippable.
 */
function assertGateInvariants(msg, planId) {
  assert.ok(msg.blocks.length <= 50, `Slack caps a message at 50 blocks — got ${msg.blocks.length}`);
  for (const text of sectionTexts(msg)) {
    assert.ok(text.length <= 3000, `Slack caps a section text at 3000 chars — got ${text.length}`);
  }
  assert.equal(msg.blocks[0].type, 'section');
  assert.match(msg.blocks[0].text.text, /Groomed & gate-checked/);
  const actions = msg.blocks.at(-1);
  assert.equal(actions.type, 'actions', 'the actions block must survive as the last block');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['create', 'reject']);
  assert.equal(actions.elements[0].value, planId, 'Create must stay wired to the plan id');
  assert.equal(actions.elements[1].value, planId, 'Reject must stay wired to the plan id');
  // Hostile content must never structurally break the payload.
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg, 'the message must survive a JSON round-trip intact');
}

function syntheticItem(n, { anchors, whyLen = 40, ac, zones, why, taProse } = {}) {
  return {
    temp_id: `i${n}`,
    type: 'Task',
    effort_tier: 'low',
    fields: {
      why: why !== undefined ? why : `why for item ${n} `.padEnd(whyLen, 'w'),
      definition_of_done: `done when item ${n} works`,
      acceptance_criteria: ac || [`item ${n} criterion one`, `item ${n} criterion two`],
      related_links: { code_anchors: anchors || [`web-app:src/item${n}.ts:Symbol${n}`], external: [] },
      technical_analysis: { prose: taProse !== undefined ? taProse : `analysis for item ${n}`, coupling_zones: zones || ['none'] },
    },
  };
}

function planFromItems(items, { summaryFor } = {}) {
  return fixturePublicPlan({
    plan: { plan_id: 'synthetic', epic: { summary: 'synthetic epic', why: 'because' }, items },
    skeleton: {
      items: items.map((i) => ({
        temp_id: i.temp_id,
        type: i.type,
        one_line_summary: (summaryFor && summaryFor(i)) || `summary of ${i.temp_id}`,
      })),
    },
  });
}

function syntheticPlan(itemCount, itemOverrides = {}) {
  const items = [];
  for (let n = 1; n <= itemCount; n += 1) items.push(syntheticItem(n, itemOverrides));
  return planFromItems(items);
}

// ---------------------------------------------------------------------------
// 1 — hostile content in plan fields (the ask is untrusted end-to-end)
// ---------------------------------------------------------------------------

const HOSTILE = {
  backticks: 'inline `code` and ```fenced``` content trying to break ``` out of spans',
  channelPing: 'summary then <!channel> and <!here> ping attempt',
  evilLink: 'verify <http://evil.example/steal|web-app:src/auth.ts:verifySession> before merging',
  longWord: 'W'.repeat(3000), // 3000 chars, no spaces — nothing to truncate "at"
  newlines: 'line one\n\nline three\r\nline four after CRLF',
};

test('hostile rich tier: backticks / pings / fake links / 3000-char words / newlines / non-string & non-array fields — no crash, budgets + structure hold', () => {
  const items = [
    // Hostile strings in every rendered slot.
    {
      temp_id: 'h1',
      type: 'Task',
      effort_tier: 'low',
      fields: {
        why: HOSTILE.evilLink + '\n' + HOSTILE.newlines,
        definition_of_done: HOSTILE.longWord,
        acceptance_criteria: [HOSTILE.backticks, HOSTILE.channelPing],
        related_links: { code_anchors: ['web-app:src/`weird`/pa th.ts:Sym'], external: [] },
        technical_analysis: { prose: HOSTILE.backticks, coupling_zones: ['none'] },
      },
    },
    // Type confusion: none of these may crash the builder.
    {
      temp_id: 'h2',
      type: 'Story',
      effort_tier: 'medium',
      fields: {
        why: 12345, // number, not string
        definition_of_done: null,
        acceptance_criteria: 'not-an-array',
        related_links: { code_anchors: 'not-an-array' },
        technical_analysis: { prose: ['arr', 'ay'], coupling_zones: 'none' },
      },
    },
    // Null fields object entirely.
    { temp_id: 'h3', type: 'Task', effort_tier: 'low', fields: null },
  ];
  const plan = planFromItems(items);
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);

  const joined = sectionTexts(msg).join('\n');
  // Small item count + everything truncatable → this stays rich.
  assert.match(joined, /\*Why:\*/, 'sanity: hostile-but-small plan renders rich');
  // The 3000-char single word was cut with a visible mark, not passed whole.
  assert.match(joined, /W{300}…/, 'a no-spaces field is hard-cut at the budget with a visible …');
  assert.equal(joined.includes(HOSTILE.longWord), false, 'the full 3000-char word must not reach a section');
  // Type confusion coerces or renders (none) — never crashes, never vanishes silently.
  assert.match(joined, /\*Why:\* 12345/, 'a numeric why is coerced to its string form');
  const h2Section = sectionTexts(msg).find((t) => t.includes('summary of h2'));
  assert.match(h2Section, /\*DoD:\* \(none\)/);
  assert.match(h2Section, /\*AC:\* \(none\)/, 'a non-array AC renders as a visible (none)');
  assert.match(h2Section, /\*Anchors:\* \(none\)/, 'a non-array anchors list renders as a visible (none)');
  const h3Section = sectionTexts(msg).find((t) => t.includes('summary of h3'));
  assert.match(h3Section, /\*Why:\* \(none\)/, 'a null fields object renders all-(none), not a crash');
});

test('hostile compact tier: an unbounded coupling_zones list is the one untruncated-at-render slot — the packer still holds every section under Slack\'s 3000', () => {
  // zones are joined un-truncated into the compact line; 120 long zone names
  // make a single line of ~5600 chars. packCompactLines truncates it marked.
  const zones = Array.from({ length: 120 }, (_, i) => `zone-${'z'.repeat(40)}-${i}`);
  const plan = syntheticPlan(9, { zones });
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);

  const texts = sectionTexts(msg);
  assert.equal(texts.some((t) => /\*Why:\*/.test(t)), false, '9 items → compact');
  const maxLen = Math.max(...texts.map((t) => t.length));
  // Pins the implementation's actual margin: truncateMarked(line, 2900)
  // yields 2900+1 chars ('…' appended AFTER the slice), so the code's own
  // 2900 "safety margin" is exceeded by exactly one char — still 99 under
  // Slack's real 3000 limit. If this pin breaks, re-check the budget math.
  assert.equal(maxLen, 2901, 'the oversized packed line lands at exactly 2901 chars (marked truncation is slice(0,max)+…)');
  assert.ok(contextTexts(msg).some((t) => /see the attached file/.test(t)), 'compact keeps pointing at the full-truth file');
});

test('hostile multibyte: emoji/CJK-heavy fields keep every budget in the code\'s own units and survive JSON round-trip', () => {
  const cjk = '生成履歴をプロンプト本文で検索できるようにする。'.repeat(30); // BMP: 1 code unit each
  const emoji = '🚀'.repeat(400); // astral: 2 code units, 4 utf-8 bytes each
  const plan = planFromItems([
    syntheticItem(1, { why: cjk, taProse: emoji, ac: [cjk, emoji] }),
    syntheticItem(2, { why: 'x' + '😀'.repeat(300) }), // truncation boundary lands mid-pair
  ]);
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);
  const joined = sectionTexts(msg).join('\n');
  assert.match(joined, /…/, 'oversized multibyte fields carry the visible truncation mark');
  // The code measures budgets in UTF-16 code units (.length). Slack's block
  // limit counts characters, and code units >= code points, so the code's
  // own measure is the conservative one — assert its self-consistency.
  for (const t of sectionTexts(msg)) assert.ok(t.length <= 3000);
});

// Regression (ex-KNOWN BUG repro #1, fixed by mrkdwnEscape in
// slack-blocks.mjs). Slack mrkdwn REQUIRES &, <, > in user-sourced text to
// be escaped as &amp; &lt; &gt; (docs.slack.dev "Escaping text"). Unescaped,
// at the money-adjacent create gate:
//   (a) legitimate technical prose is EATEN: "<Suspense>", "Promise<T>",
//       "a<b" — Slack parses <…> as a link/mention token and hides it, so
//       the reviewer approves content they literally cannot see;
//   (b) a hostile ask can smuggle "<!channel>" (mass ping) or a forged link
//       "<http://evil|web-app:src/auth.ts>" that renders as innocent text.
// The rendering is the human gate's safety surface, so hidden/forged gate
// content defeats the fix's purpose.
test('mrkdwn escaping: control chars in untrusted plan fields are escaped before hitting section text', () => {
  const plan = planFromItems([
    syntheticItem(1, {
      why: 'wraps the grid in <Suspense> & falls back when a<b',
      taProse: HOSTILE.channelPing + ' — ' + HOSTILE.evilLink,
    }),
  ]);
  const joined = sectionTexts(planReadyMessage(plan)).join('\n');
  assert.equal(joined.includes('<!channel>'), false,
    'a raw <!channel> in a plan field must never reach Slack unescaped — mass-ping injection at the create gate');
  assert.equal(joined.includes('<http://evil.example/steal|'), false,
    'a raw mrkdwn link token in a plan field must never reach Slack unescaped — forged-link injection at the create gate');
  assert.ok(joined.includes('&lt;Suspense&gt;'),
    'legitimate <angle-bracket> prose must be escaped (&lt;/&gt;) or Slack swallows it and the reviewer never sees it');
  assert.ok(joined.includes('&lt;!channel&gt;'),
    'the neutralized ping stays VISIBLE as literal text — the reviewer sees what the ask tried to do');
  assert.ok(joined.includes('&amp; falls back when a&lt;b'),
    '& is escaped first so entities are never double-escaped, and bare a<b prose survives visibly');
});

// Regression (ex-KNOWN BUG repro #2, fixed in truncateMarked).
// truncateMarked slices at fixed UTF-16 code-unit indices (300/150/100/200/
// 2900). When an astral char (emoji) straddles the boundary the naive slice
// emits a LONE SURROGATE: the section text is no longer well-formed Unicode
// (renders as � at best; ill-formed UTF-8 on the wire at worst). The fix
// drops a trailing unpaired high surrogate after slicing, inside the helper,
// so every budget path inherits it.
test('marked truncation never splits a surrogate pair — section text stays well-formed Unicode', () => {
  const plan = planFromItems([syntheticItem(1, { why: 'x' + '😀'.repeat(300) })]);
  const msg = planReadyMessage(plan);
  for (const t of sectionTexts(msg)) {
    assert.ok(t.isWellFormed(), 'section text contains a lone surrogate after truncation — ill-formed Unicode sent to Slack');
  }
});

// Same escaping class, remaining ask-derived surfaces: the skeleton tree
// (a ``` fence a hostile summary could close early) and the "Preparing…"
// placeholder (raw ask description in section mrkdwn).
test('hostile ask surfaces: the skeleton fence cannot be closed early or made to ping; the preparing placeholder escapes the description', () => {
  const msg = skeletonMessage({
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'evil & <desc>',
    skeleton: {
      items: [
        { temp_id: 'i1', type: 'Task', one_line_summary: 'break ``` out of the fence' },
        { temp_id: 'i2', type: 'Task', one_line_summary: 'ping <!channel> now & then' },
      ],
    },
  });
  const treeSection = msg.blocks[1].text.text;
  assert.ok(treeSection.startsWith('```') && treeSection.endsWith('```'), 'the fence itself survives');
  const inner = treeSection.slice(3, -3);
  assert.equal(inner.includes('```'), false, 'no run of three consecutive backticks may survive inside the fence');
  assert.equal(inner.includes('<!channel>'), false, 'no raw ping token inside the fence');
  assert.ok(inner.includes('&lt;!channel&gt;'), 'the neutralized ping stays visible to the reviewer');
  assert.ok(msg.blocks[0].text.text.includes('evil &amp; &lt;desc&gt;'), 'the header description is escaped');

  const prep = preparingMessage({ description: 'pinging <!here> & co', outputLanguage: 'en' });
  assert.equal(prep.blocks[0].text.text.includes('<!here>'), false);
  assert.ok(prep.blocks[0].text.text.includes('&lt;!here&gt; &amp; co'));
});

test('hostile terminal surface: plan.error is escaped BEFORE the 500 truncation — no ping/forged-link injection at the failure surface; the runnable cleanup command survives byte-identical', () => {
  // Engine errors embed agent-influenced stdout/stderr tails, so the
  // failure surface carries untrusted text like the gates do.
  const hostileError = 'engine died: <!channel> see <http://evil.example/x|tools/create-tree.mjs> & retry';
  const msg = terminalMessage({ plan_id: PLAN_ID, status: 'failed', error: hostileError });
  const body = msg.blocks[0].text.text;
  assert.equal(body.includes('<!channel>'), false, 'a raw ping token in an engine error must never reach Slack');
  assert.equal(body.includes('<http://evil.example/x|'), false, 'a raw link token in an engine error must never reach Slack');
  assert.ok(body.includes('&lt;!channel&gt;'), 'the neutralized ping stays VISIBLE in the error text');
  assert.ok(body.includes('&amp; retry'), '& escaped first — no double-escaping');
  assert.equal(msg.text.includes('<!channel>'), false, 'the notification fallback text is escaped too');

  // Escape-before-truncate: the 500 budget is measured on the escaped form.
  const long = terminalMessage({ plan_id: PLAN_ID, status: 'failed', error: '&'.repeat(400) });
  const errorLine = long.blocks[0].text.text.split('\n')[1];
  assert.equal(errorLine, '&amp;'.repeat(100), '400 raw & escape to 2000 chars — cut at the escaped 500, never mid-budget on raw chars');

  // The load-bearing verbatim parts contain no & < > — escaping is a no-op
  // on them, so the re-click guidance and runnable command are untouched.
  const guidance = 'cancel failed — the tree may be only partially cancelled.\nClick "Cancel tree" again or run: node tools/create-tree.mjs --cleanup /rec.json --live';
  const failedCancel = terminalMessage({ plan_id: PLAN_ID, status: 'failed', error: guidance, created: { record_path: '/rec.json' } });
  assert.ok(failedCancel.blocks[0].text.text.includes(guidance), 'the guidance + cleanup command survive byte-identical');
});

test('hostile anchors: a backtick inside an anchor path cannot terminate its inline code span early', () => {
  const plan = planFromItems([syntheticItem(1, { anchors: ['web-app:src/`rm -rf`/x.ts:Sym'] })]);
  const joined = sectionTexts(planReadyMessage(plan)).join('\n');
  assert.equal(joined.includes('`web-app:src/`'), false,
    'a raw backtick in the value would close the span after "src/" and spill the rest into live mrkdwn');
  assert.ok(joined.includes('`web-app:src/ʼrm -rfʼ/x.ts:Sym`'),
    'backticks are swapped for ʼ inside the span; the path is otherwise verbatim and the span stays intact');
});

// ---------------------------------------------------------------------------
// 2 — boundary tiers, measured exactly
// ---------------------------------------------------------------------------

test('boundary: exactly 8 small items render RICH (no file pointer); 9 flip to compact', () => {
  const rich = planReadyMessage(syntheticPlan(8));
  assert.equal(rich.blocks.length, 1 + 8 + 1 + 1, 'header + 8 item sections + context + actions');
  assert.ok(sectionTexts(rich).slice(1).every((t) => /\*Why:\*/.test(t)), '8 items is the last rich count');
  assert.equal(contextTexts(rich).some((t) => /full ticket text/.test(t)), false);

  const compact = planReadyMessage(syntheticPlan(9));
  assert.equal(sectionTexts(compact).some((t) => /\*Why:\*/.test(t)), false, '9 items must not render rich');
  assert.ok(contextTexts(compact).some((t) => /see the attached file/.test(t)));
});

test('boundary: 8 items with ONE section rendered at exactly 2900 stays rich; the same section at 2901 tips the whole gate compact', () => {
  // Anchor paths are never truncated, so the 8th item's single anchor length
  // controls its rendered section length exactly linearly. Measure, then tune.
  const build = (anchorLen) => {
    const items = [];
    for (let n = 1; n <= 8; n += 1) {
      items.push(syntheticItem(n, n === 8 ? { anchors: ['A'.repeat(anchorLen)] } : {}));
    }
    return planFromItems(items);
  };
  const probe = planReadyMessage(build(50));
  const probeLen = probe.blocks[8].text.text.length;
  assert.ok(probe.blocks[8].text.text.includes('summary of i8'), 'probe sanity: blocks[8] is item 8');
  const tunedLen = 50 + (2900 - probeLen);

  const atBudget = planReadyMessage(build(tunedLen));
  assert.equal(atBudget.blocks[8].text.text.length, 2900, 'the tuned section renders at exactly the 2900 budget');
  assert.match(atBudget.blocks[8].text.text, /\*Why:\*/, '2900 is INSIDE the rich budget (<=)');

  const overBudget = planReadyMessage(build(tunedLen + 1));
  assert.equal(sectionTexts(overBudget).some((t) => /\*Why:\*/.test(t)), false,
    'one char over the per-section budget must flip the whole message compact');
  assert.ok(contextTexts(overBudget).some((t) => /see the attached file/.test(t)));
  assertGateInvariants(overBudget, fixturePublicPlan().plan_id);
});

test('boundary: exactly 8 anchors all render verbatim with NO overflow line; 9 render 8 + "…and 1 more" and drop the 9th whole', () => {
  const mkAnchors = (n) => Array.from({ length: n }, (_, i) => `web-app:src/deep/path${i}.ts:Sym${i}`);

  const at8 = planReadyMessage(planFromItems([syntheticItem(1, { anchors: mkAnchors(8) })]));
  const s8 = sectionTexts(at8).find((t) => t.includes('summary of i1'));
  for (const a of mkAnchors(8)) assert.ok(s8.includes(`\`${a}\``), `anchor ${a} must render complete`);
  assert.equal(/…and \d+ more/.test(s8), false, 'exactly 8 anchors must not fabricate an overflow count');

  const at9 = planReadyMessage(planFromItems([syntheticItem(1, { anchors: mkAnchors(9) })]));
  const s9 = sectionTexts(at9).find((t) => t.includes('summary of i1'));
  for (const a of mkAnchors(8)) assert.ok(s9.includes(`\`${a}\``));
  assert.equal(s9.includes(mkAnchors(9)[8]), false, 'the 9th anchor is dropped whole — never cut');
  assert.ok(s9.includes('…and 1 more'), 'the overflow count is exact');
});

test('boundary: exactly 6 ACs all render with NO overflow line; 7 render 6 + "…and 1 more"', () => {
  const mkAc = (n) => Array.from({ length: n }, (_, i) => `criterion number ${i + 1}`);

  const at6 = planReadyMessage(planFromItems([syntheticItem(1, { ac: mkAc(6) })]));
  const s6 = sectionTexts(at6).find((t) => t.includes('summary of i1'));
  for (const ac of mkAc(6)) assert.ok(s6.includes(`• ${ac}`), `AC "${ac}" must render`);
  assert.equal(/…and \d+ more/.test(s6), false, 'exactly 6 ACs must not fabricate an overflow count');

  const at7 = planReadyMessage(planFromItems([syntheticItem(1, { ac: mkAc(7) })]));
  const s7 = sectionTexts(at7).find((t) => t.includes('summary of i1'));
  assert.ok(s7.includes('• criterion number 6'));
  assert.equal(s7.includes('• criterion number 7'), false);
  assert.ok(s7.includes('…and 1 more'));
});

test('boundary: a 1400-item plan degrades to the SERIALIZED-blocks budget with an HONEST dropped count (rendered + N == total)', () => {
  const items = [];
  for (let n = 1; n <= 1400; n += 1) items.push(syntheticItem(n, { whyLen: 300 }));
  const plan = planFromItems(items, { summaryFor: (i) => `summary of ${i.temp_id} `.padEnd(400, 's') });
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);

  // Slack rejects any chat.postMessage whose serialized `blocks` argument is
  // >= 100,001 chars (empirically proven against blocks.validate 2026-07-10)
  // — a cap the 50-block/3000-char budgets do NOT imply. The old pin here
  // ("exactly 50 blocks") blessed a 123K payload Slack refuses; the payload
  // must land under the code's own 90K safety margin.
  const serialized = JSON.stringify(msg.blocks).length;
  assert.ok(serialized <= 90_000, `serialized blocks must respect MAX_BLOCKS_JSON — got ${serialized}`);

  const note = contextTexts(msg).join('\n').match(/…and (\d+) more item\(s\) — full ticket text/);
  assert.ok(note, 'the dropped tail must be declared, never silent');
  const renderedCount = (sectionTexts(msg).join('\n').match(/\*Task\* /g) || []).length;
  assert.equal(renderedCount + Number(note[1]), 1400,
    'every item is either rendered or counted in the honest overflow note');
});

test('serialized budget: 300 quote/backslash-heavy compact items inflate under JSON.stringify past the raw char budgets — the final measure still lands under 90K with honest counts', () => {
  // `"` and `\` double under JSON escaping — content that passes every
  // per-section char budget can still breach Slack's serialized cap. This is
  // the exact shape blocks.validate rejected live (300 items → 112K).
  const noisy = '"\\x'.repeat(120); // 360 chars, ~2/3 of them JSON-doubling
  const items = [];
  for (let n = 1; n <= 300; n += 1) items.push(syntheticItem(n, { why: noisy }));
  const plan = planFromItems(items, { summaryFor: () => noisy });
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);
  const serialized = JSON.stringify(msg.blocks).length;
  assert.ok(serialized <= 90_000, `inflated payload must degrade under the budget — got ${serialized}`);
  const rendered = (sectionTexts(msg).join('\n').match(/\*Task\* /g) || []).length;
  const note = contextTexts(msg).join('\n').match(/…and (\d+) more item\(s\)/);
  assert.equal(rendered + (note ? Number(note[1]) : 0), 300, 'honest arithmetic under JSON-inflation degrade');
});

test('serialized budget: a RICH-eligible plan whose control-char content inflates 6x under JSON falls back to compact rendering', () => {
  // A control char serializes as 6 JSON chars (backslash-u0001) - 8 rich sections that each pass
  // the 2900 char budget can serialize past 90K. The degrade path must fall
  // rich -> compact FIRST (compact carries strictly less text per item).
  const ctl = '\u0001'.repeat(280);
  const items = [];
  for (let n = 1; n <= 8; n += 1) {
    items.push(syntheticItem(n, { why: ctl, taProse: ctl, ac: [ctl, ctl, ctl, ctl, ctl, ctl], anchors: Array(8).fill(ctl.slice(0, 110)) }));
  }
  const plan = planFromItems(items);
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);
  const serialized = JSON.stringify(msg.blocks).length;
  assert.ok(serialized <= 90_000, `rich JSON-inflation must degrade — got ${serialized}`);
  const joined = sectionTexts(msg).join('\n');
  assert.equal(joined.includes('*Why:*'), false, 'rich rendering must have been abandoned');
  assert.match(joined, / — why: /, 'compact one-liners render instead');
  assert.match(contextTexts(msg).join('\n'), /full ticket text/, 'the file pointer appears with the compact tier');
});

test('skeleton tree budget: a 40-item skeleton fences at <= 3000 chars/section with an honest in-fence overflow marker', () => {
  const items = [];
  for (let n = 1; n <= 40; n += 1) {
    items.push({ temp_id: `i${n}`, type: 'Task', milestone_id: 'm1', one_line_summary: `summary line for item number ${n} `.padEnd(90, 'x') });
  }
  const plan = fixturePublicPlan({
    status: 'shape_ready',
    skeleton: { items, milestones: [{ milestone_id: 'm1', name: 'M1', order: 1 }] },
    description: 'a very large approved shape',
  });
  const msg = skeletonMessage(plan);
  const treeSection = msg.blocks[1].text.text;
  assert.ok(treeSection.length <= 3000, `the fenced tree section must stay under Slack's 3000/section — got ${treeSection.length}`);
  const marker = treeSection.match(/… \(\+(\d+) more lines — full shape via GET \/plan\//);
  assert.ok(marker, 'dropped tree lines must be declared in-fence, never silent');
  // 41 tree lines total (1 milestone header + 40 items): kept + dropped == 41.
  const keptItemLines = (treeSection.match(/\[Task\]/g) || []).length;
  assert.equal(keptItemLines + Number(marker[1]) + 1, 41 + (marker ? 0 : 0), 'kept lines + dropped count must cover the whole tree (+1 milestone header)');
  assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg, 'the message survives a JSON round-trip intact');
});

test('terminalMessage: an emoji straddling the 500-char error cut never yields a lone surrogate, and the notification fallback text is capped', () => {
  const plan = { plan_id: 'x-1', status: 'failed', error: 'e'.repeat(499) + '😀'.repeat(40) };
  const msg = terminalMessage(plan);
  for (const b of msg.blocks) {
    if (b.text) assert.ok(b.text.text.isWellFormed(), 'block text must stay well-formed Unicode');
  }
  assert.ok(msg.text.isWellFormed(), 'the notification fallback must stay well-formed Unicode');
  assert.ok(msg.text.length <= 'failed: '.length + 500, 'the fallback text inherits the 500 cut');
});

test('duplicateSearchLine: hostile duplicate_search output is escaped on both the ok and not-ok branches', () => {
  for (const dup of [
    { ok: true, output: 'PROJ-1 <!channel> & <http://evil.example|x> match' },
    { ok: false, output: '<!here> & backend failure' },
  ]) {
    const msg = planReadyMessage(fixturePublicPlan({ duplicate_search: dup }));
    const ctx = contextTexts(msg).join('\n');
    assert.equal(ctx.includes('<!'), false, 'raw ping syntax must not survive into context mrkdwn');
    assert.ok(ctx.includes('&lt;!'), 'the escaped form renders instead');
  }
});

test('renderPlanText: null elements inside AC/anchors/external lists are dropped — no literal "null" lines in the full-truth file', () => {
  const item = syntheticItem(1, {});
  item.fields.acceptance_criteria = ['a real criterion', null, undefined];
  item.fields.related_links.code_anchors = ['web-app:src/a.ts:Sym', null];
  item.fields.related_links.external = [null, 'https://example.com/doc'];
  const plan = planFromItems([item]);
  const text = renderPlanText(plan);
  assert.equal(/^\s*(?:\d+\.|-)\s*null\s*$/m.test(text), false, 'no literal null list lines');
  assert.ok(text.includes('a real criterion'));
  assert.ok(text.includes('https://example.com/doc'));
});

test('renderPlanText divergence: duplicate dep ids collapse to set equality, and an orphan groomed item (no skeleton match) never flags', () => {
  const plan = fixturePublicPlan();
  const groomed = JSON.parse(JSON.stringify(plan.plan));
  const skeleton = JSON.parse(JSON.stringify(plan.skeleton));
  // Duplicates collapse: create-tree's selectScope dedups Blocks links via a
  // seen-set, so ['i1','i1'] and ['i1'] produce identical Jira writes.
  groomed.items[1].depends_on = ['i1', 'i1'];
  const skelMatch = skeleton.items.find((i) => i.temp_id === groomed.items[1].temp_id);
  skelMatch.depends_on = ['i1'];
  // Orphan groomed item: deps present but no skeleton row to diverge FROM.
  groomed.items.push({
    temp_id: 'i99',
    type: 'Task',
    effort_tier: 'low',
    depends_on: ['i1'],
    fields: { why: 'orphan why', definition_of_done: 'done', acceptance_criteria: ['ac'], related_links: { code_anchors: [] }, technical_analysis: { prose: 'ta' } },
  });
  const text = renderPlanText(fixturePublicPlan({ plan: groomed, skeleton }));
  assert.equal(text.includes('DIVERGES'), false, 'neither duplicate-collapse nor the orphan may raise the divergence flag');
  assert.ok(text.includes('i99'), 'the orphan item still renders (temp_id fallback)');
});

// ---------------------------------------------------------------------------
// 3 — skeleton/plan mismatch & degenerate plans
// ---------------------------------------------------------------------------

test('mismatch: compact tier also falls back to the bare temp_id when a groomed item has no skeleton match', () => {
  const items = [];
  for (let n = 1; n <= 9; n += 1) items.push(syntheticItem(n));
  const plan = planFromItems(items);
  // Remove i5 from the skeleton — its compact line must show the temp_id.
  plan.skeleton = { items: plan.skeleton.items.filter((i) => i.temp_id !== 'i5') };
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');
  assert.ok(joined.includes('*Task* i5 — why: why for item 5'), 'the orphan item falls back to its temp_id, not a blank');
  assert.equal(joined.includes('summary of i5'), false);
});

test('mismatch: duplicate temp_ids in the skeleton resolve deterministically (last one wins) — no crash, no dropped item', () => {
  const plan = planFromItems([syntheticItem(1)]);
  plan.skeleton = {
    items: [
      { temp_id: 'i1', type: 'Task', one_line_summary: 'FIRST duplicate summary' },
      { temp_id: 'i1', type: 'Task', one_line_summary: 'SECOND duplicate summary' },
    ],
  };
  const msg = planReadyMessage(plan);
  const joined = sectionTexts(msg).join('\n');
  // Pins Map-construction semantics: later entries overwrite. Either pick
  // would be acceptable; what matters is determinism and no crash.
  assert.ok(joined.includes('SECOND duplicate summary'));
  assert.equal(joined.includes('FIRST duplicate summary'), false);
  assertGateInvariants(msg, plan.plan_id);
});

test('degenerate: plan_ready with plan.plan missing entirely — builders render a sane empty gate and the poller still posts + uploads without throwing', async () => {
  const publicPlan = fixturePublicPlan({ plan: undefined });

  // Builders.
  const msg = planReadyMessage(publicPlan);
  assert.equal(msg.blocks.length, 3, 'header + context + actions, zero item sections');
  assert.equal(msg.blocks.at(-1).type, 'actions');
  const text = renderPlanText(publicPlan);
  assert.ok(text.includes('EPIC: (none)'), 'the full-truth file makes the absence visible, not a crash');
  assert.ok(text.includes(`plan: ${publicPlan.plan_id}`));

  // Poller drive: gate posts, upload runs with the degenerate content.
  const { bridge, slackFetch } = makePlanReadyBridge(happyPathResponder, publicPlan);
  await assert.doesNotReject(() => bridge.pollOnce());
  const bytesCall = slackFetch.calls.find((c) => c.url === UPLOAD_URL);
  assert.ok(bytesCall, 'the upload leg still runs for a degenerate plan');
  assert.ok(String(bytesCall.body).includes('EPIC: (none)'));
});

test('degenerate: a truthy NON-ARRAY plan.plan.items (or skeleton.items) renders the same sane empty/fallback gate — never a crash', () => {
  // Same Array.isArray guard renderPlanText already uses — a poller crash
  // here would silence every later plan's messages.
  for (const items of ['not-an-array', 42, { i1: {} }]) {
    const msg = planReadyMessage(fixturePublicPlan({ plan: { epic: {}, items } }));
    assert.equal(msg.blocks.length, 3, 'header + context + actions, zero item sections');
    assert.equal(msg.blocks.at(-1).type, 'actions');
  }
  // Non-array skeleton items with a valid plan: summaries fall back to temp_id.
  const msg = planReadyMessage(fixturePublicPlan({ skeleton: { items: 'not-an-array' } }));
  const joined = sectionTexts(msg).join('\n');
  assert.ok(joined.includes('*Task* i1'), 'orphan items fall back to their temp_id when the skeleton is unusable');
  assertGateInvariants(msg, fixturePublicPlan().plan_id);
});

test('degenerate: null/undefined ELEMENTS inside plan.items / skeleton.items are dropped, never crashed on — the valid item still renders in both builders', () => {
  const plan = planFromItems([syntheticItem(1)]);
  plan.plan.items = [null, plan.plan.items[0], undefined];
  plan.skeleton.items = [undefined, plan.skeleton.items[0], null];

  // planReadyMessage: the valid item renders (with its skeleton summary —
  // proving the skeleton Map build survived its null element too).
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);
  const joined = sectionTexts(msg).join('\n');
  assert.ok(joined.includes('summary of i1'), 'the valid item renders through the null-riddled arrays');
  assert.equal(sectionTexts(msg).length, 2, 'header + exactly ONE item section — nulls are dropped, not rendered');

  // renderPlanText: same guard; the [1/1] header proves the nulls were
  // filtered BEFORE the item count was computed.
  const text = renderPlanText(plan);
  assert.ok(text.includes('[1/1] Task i1 — summary of i1'), 'the full-truth file renders the valid item with a null-free count');
});

// ---------------------------------------------------------------------------
// 4 — renderPlanText: hostile passthrough, determinism, systematic coverage
// ---------------------------------------------------------------------------

test('renderPlanText: hostile content passes through RAW (it is a text file) and stays byte-identical across calls', () => {
  const plan = planFromItems([
    syntheticItem(1, {
      why: HOSTILE.evilLink,
      taProse: HOSTILE.backticks + '\n' + HOSTILE.channelPing,
      ac: [HOSTILE.longWord, HOSTILE.newlines],
      anchors: ['web-app:src/`weird`.ts:Sym'],
    }),
  ]);
  plan.plan.epic = { summary: HOSTILE.channelPing, why: '🚀 emoji epic — ' + HOSTILE.backticks };

  const first = renderPlanText(plan);
  assert.equal(renderPlanText(plan), first, 'hostile input must not break determinism');
  // Every hostile string arrives complete and uncut — the file is the truth.
  for (const s of [HOSTILE.evilLink, HOSTILE.backticks, HOSTILE.channelPing, HOSTILE.longWord, HOSTILE.newlines]) {
    assert.ok(first.includes(s), 'the full-truth file must carry the field verbatim, however hostile');
  }
  assert.ok(first.includes('🚀 emoji epic'));
});

test('renderPlanText: systematic per-item structure — numbered headers, structural links, numbered ACs, dashed anchors, external links, zones, effort for EVERY fixture item', () => {
  const text = renderPlanText(fixturePublicPlan());
  const summaries = new Map(fixtureSkeleton.items.map((i) => [i.temp_id, i.one_line_summary]));
  const milestoneNames = new Map(fixtureSkeleton.milestones.map((m) => [m.milestone_id, m.name]));

  // One '='-separated block per item (prelude before the first separator,
  // empty tail after the closing one) — lets every structural assertion be
  // made against ITS item's block, not the whole document.
  const itemBlocks = text.split('='.repeat(78)).slice(1, -1);
  assert.equal(itemBlocks.length, fixtureGroomedPlan.items.length, 'one separated block per item');

  fixtureGroomedPlan.items.forEach((item, idx) => {
    const f = item.fields;
    const block = itemBlocks[idx];
    const skeletonItem = fixtureSkeleton.items.find((s) => s.temp_id === item.temp_id);
    assert.ok(
      block.includes(`[${idx + 1}/${fixtureGroomedPlan.items.length}] ${item.type} ${item.temp_id} — ${summaries.get(item.temp_id)}`),
      `${item.temp_id}: positional header with type + temp_id + skeleton summary`,
    );
    // Structural link fields (content-visible gate fix rounds): parent, WRITER-sourced
    // depends_on (the GROOMED item's — what create-tree.mjs selectScope
    // actually turns into Jira Blocks links), milestone name, repo(s) —
    // the approver verifies what will actually be written at the gate.
    assert.ok(block.includes(`Parent: ${item.parent_temp_id}`), `${item.temp_id}: parent link`);
    const expectedDeps = item.depends_on.length > 0 ? item.depends_on.join(', ') : '(none)';
    assert.ok(block.includes(`Depends on: ${expectedDeps}`), `${item.temp_id}: groomed (writer-sourced) depends_on (visible (none) when empty)`);
    assert.ok(block.includes(`Milestone: ${milestoneNames.get(skeletonItem.milestone_id)}`), `${item.temp_id}: milestone resolved by name from the skeleton`);
    assert.ok(block.includes(`Repo: ${item.repo}`), `${item.temp_id}: repo`);
    assert.ok(block.includes(`Affected repos: ${f.technical_analysis.affected_repos.join(', ')}`), `${item.temp_id}: affected repos`);
    // The structural lines sit between the header rule and the Why: body.
    assert.ok(block.indexOf('Parent:') < block.indexOf('Why:'), `${item.temp_id}: structure renders before content`);
    f.acceptance_criteria.forEach((ac, i) => {
      assert.ok(block.includes(`  ${i + 1}. ${ac}`), `${item.temp_id} AC ${i + 1} must be numbered and complete`);
    });
    for (const anchor of f.related_links.code_anchors) {
      assert.ok(block.includes(`  - ${anchor}`), `${item.temp_id} anchor listed complete`);
    }
    assert.ok(block.includes(`Effort: ${item.effort_tier}`));
  });
  // Fixture externals are all empty and zones are all "none" — absence must
  // be visible for every one of the 3 items, not skipped.
  assert.equal((text.match(/External links:\n {2}\(none\)/g) || []).length, 3);
  assert.equal((text.match(/Coupling zones: none/g) || []).length, 3);
  // Fixture groom matches the approved shape exactly — no divergence flag
  // may be fabricated anywhere in the document.
  assert.equal(text.includes('DIVERGES'), false, 'a groom that matches the shape must carry no divergence flag');

  // Synthetic externals DO render as dashed lines; a synthetic skeleton with
  // no milestones/repos renders no Milestone/Repo lines but keeps the
  // always-on links visible as (none).
  const withExternals = planFromItems([syntheticItem(1)]);
  withExternals.plan.items[0].fields.related_links.external = ['https://example.com/rfc', 'https://example.com/spec'];
  const t2 = renderPlanText(withExternals);
  assert.ok(t2.includes('  - https://example.com/rfc'));
  assert.ok(t2.includes('  - https://example.com/spec'));
  assert.ok(t2.includes('Parent: (none)'), 'a missing parent is a VISIBLE absence');
  assert.ok(t2.includes('Depends on: (none)'), 'missing groomed depends_on is a VISIBLE absence');
  assert.equal(t2.includes('DIVERGES'), false, 'empty groomed deps + empty shape deps is NOT a divergence');
  assert.equal(t2.includes('Milestone:'), false, 'no milestone line when the skeleton cannot resolve one');
  assert.equal(t2.includes('Repo:'), false, 'no repo line when the item carries none');
});

test('renderPlanText: Depends on is WRITER-sourced (the groomed item) and groom-vs-shape drift is flagged — set-inequality only, order-insensitive', () => {
  // create-tree.mjs selectScope builds the Jira Blocks links from the
  // GROOMED plan.items[].depends_on — so the gate document must render the
  // groomed deps as the primary line (what will actually be written) and
  // flag any drift from the approved shape as the alarm it is.
  const plan = planFromItems([syntheticItem(1), syntheticItem(2), syntheticItem(3), syntheticItem(4)]);
  // i1 — same SET, different order: NOT a divergence (order-insensitive).
  plan.skeleton.items[0].depends_on = ['i2', 'i3'];
  plan.plan.items[0].depends_on = ['i3', 'i2'];
  // i2 — groom ADDED a dep the approved shape never had: flagged.
  plan.skeleton.items[1].depends_on = ['i1'];
  plan.plan.items[1].depends_on = ['i1', 'i3'];
  // i3 — groom DROPPED the approved dep (the create path will NOT write
  // this link — the most dangerous drift direction): flagged, with the
  // shape's version named.
  plan.skeleton.items[2].depends_on = ['i1'];
  plan.plan.items[2].depends_on = [];
  // i4 — both empty: nothing to diverge.
  const text = renderPlanText(plan);
  const itemBlocks = text.split('='.repeat(78)).slice(1, -1);
  assert.equal(itemBlocks.length, 4);

  assert.ok(itemBlocks[0].includes('Depends on: i3, i2'), 'i1: the groomed deps ARE the primary line, in groomed order');
  assert.equal(itemBlocks[0].includes('DIVERGES'), false, 'i1: same set in a different order is NOT drift');

  assert.ok(itemBlocks[1].includes('Depends on: i1, i3'), 'i2: the groomed (written) deps render, not the shape\'s');
  assert.ok(itemBlocks[1].includes('⚠ DIVERGES from approved shape (shape had: i1)'), 'i2: an added dep is flagged with the shape\'s version');

  assert.ok(itemBlocks[2].includes('Depends on: (none)'), 'i3: the groomed absence is the primary line — no link will be written');
  assert.ok(itemBlocks[2].includes('⚠ DIVERGES from approved shape (shape had: i1)'), 'i3: a dropped dep is flagged — the approved link will silently not be created');

  assert.ok(itemBlocks[3].includes('Depends on: (none)'));
  assert.equal(itemBlocks[3].includes('DIVERGES'), false, 'i4: empty == empty, no flag');
});

// ---------------------------------------------------------------------------
// 5 — upload-leg edge cases the developer suite does not cover
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
const UPLOAD_URL = 'https://files.slack.com/upload/v1/QA';
const GATE_TS = '1730000001.000001';

function makePlanReadyBridge(slackResponder, publicPlan = fixturePublicPlan()) {
  const serviceFetch = makeRecordingFetch((call) =>
    (call.url.endsWith(`/plan/${publicPlan.plan_id}`) ? fakeResponse(200, publicPlan) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(slackResponder);
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(publicPlan.plan_id, { channel: 'C1', requester: 'test-requester', description: 'search history', lastStatus: 'grooming', messageTs: undefined });
  return { bridge, slackFetch, publicPlan };
}

function happyPathResponder(call) {
  if (call.url.endsWith('chat.postMessage')) return fakeResponse(200, { ok: true, ts: GATE_TS, channel: 'C1' });
  if (call.url.endsWith('files.getUploadURLExternal')) return fakeResponse(200, { ok: true, upload_url: UPLOAD_URL, file_id: 'F-QA' });
  if (call.url === UPLOAD_URL) return fakeResponse(200, {});
  if (call.url.endsWith('files.completeUploadExternal')) return fakeResponse(200, { ok: true });
  return fakeResponse(200, { ok: true });
}

for (const [label, body] of [
  ['upload_url missing from an ok:true response', { ok: true, file_id: 'F-QA' }],
  ['file_id missing from an ok:true response', { ok: true, upload_url: UPLOAD_URL }],
]) {
  test(`upload degradation: ${label} → no bytes POST, no complete call, visible warning, no throw`, async () => {
    const { bridge, slackFetch } = makePlanReadyBridge((call) => {
      if (call.url.endsWith('files.getUploadURLExternal')) return fakeResponse(200, body);
      return happyPathResponder(call);
    });
    await assert.doesNotReject(() => bridge.pollOnce());
    const urls = slackFetch.calls.map((c) => c.url);
    assert.equal(urls.includes(UPLOAD_URL), false, 'must not POST bytes without an upload_url AND file_id');
    assert.equal(urls.some((u) => u.endsWith('files.completeUploadExternal')), false);
    const warning = slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).map((c) => JSON.parse(c.body)).at(-1);
    assert.equal(warning.thread_ts, GATE_TS);
    assert.match(warning.text, /could not attach the full plan file/);
    assert.match(warning.text, /files\.getUploadURLExternal failed: HTTP 200/, 'the malformed-but-200 response is named as the reason');
  });
}

test('upload degradation: network throw at step 2 (bytes POST rejects) → complete never called, warning names the reason, no throw', async () => {
  const { bridge, slackFetch } = makePlanReadyBridge((call) => {
    if (call.url === UPLOAD_URL) throw new Error('bytes socket reset');
    return happyPathResponder(call);
  });
  await assert.doesNotReject(() => bridge.pollOnce());
  const urls = slackFetch.calls.map((c) => c.url);
  assert.equal(urls.some((u) => u.endsWith('files.completeUploadExternal')), false, 'a failed bytes POST must not be "completed"');
  const warning = slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).map((c) => JSON.parse(c.body)).at(-1);
  assert.match(warning.text, /bytes socket reset/);
  assert.match(warning.text, new RegExp(`GET /plan/${PLAN_ID}`));
});

test('upload degradation: network throw at step 3 (completeUploadExternal rejects) → warning posted, no throw', async () => {
  const { bridge, slackFetch } = makePlanReadyBridge((call) => {
    if (call.url.endsWith('files.completeUploadExternal')) throw new Error('complete conn reset');
    return happyPathResponder(call);
  });
  await assert.doesNotReject(() => bridge.pollOnce());
  const warning = slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).map((c) => JSON.parse(c.body)).at(-1);
  assert.equal(warning.thread_ts, GATE_TS);
  assert.match(warning.text, /complete conn reset/);
});

test('double degradation: the upload fails AND the warning thread reply itself rejects → pollOnce still resolves (both attempts recorded)', async () => {
  const { bridge, slackFetch } = makePlanReadyBridge((call) => {
    if (call.url.endsWith('chat.postMessage')) {
      const body = JSON.parse(call.body);
      if (body.thread_ts) throw new Error('warning post network down'); // the warning reply
      return fakeResponse(200, { ok: true, ts: GATE_TS, channel: 'C1' }); // the gate
    }
    if (call.url.endsWith('files.getUploadURLExternal')) throw new Error('upload network down');
    return happyPathResponder(call);
  });
  await assert.doesNotReject(() => bridge.pollOnce(), 'a failing warning about a failing upload must still never take down the poller');
  const posts = slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 2, 'the gate post succeeded and the warning was attempted');
});

test('iteration isolation: plan A double-degrades mid-upload, plan B (watched after A) still gets its gate AND its full 3-step upload', async () => {
  const PLAN_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const PLAN_B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const planA = fixturePublicPlan({ plan_id: PLAN_A });
  const planB = fixturePublicPlan({ plan_id: PLAN_B });
  const URL_B = 'https://files.slack.com/upload/v1/B';

  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith(`/plan/${PLAN_A}`)) return fakeResponse(200, planA);
    if (call.url.endsWith(`/plan/${PLAN_B}`)) return fakeResponse(200, planB);
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('chat.postMessage')) {
      const body = JSON.parse(call.body);
      if (body.thread_ts && body.channel === 'CA') throw new Error('A warning also down'); // A's double degradation
      return fakeResponse(200, { ok: true, ts: body.channel === 'CA' ? 'TS-A' : 'TS-B', channel: body.channel });
    }
    if (call.url.endsWith('files.getUploadURLExternal')) {
      if (String(call.body).includes('radsvinn-plan-aaaaaaaa')) throw new Error('A upload network down');
      return fakeResponse(200, { ok: true, upload_url: URL_B, file_id: 'F-B' });
    }
    if (call.url === URL_B) return fakeResponse(200, {});
    if (call.url.endsWith('files.completeUploadExternal')) return fakeResponse(200, { ok: true });
    return fakeResponse(200, { ok: true });
  });

  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(PLAN_A, { channel: 'CA', requester: 'test-requester', description: 'a', lastStatus: 'grooming', messageTs: undefined });
  bridge.watched.set(PLAN_B, { channel: 'CB', requester: 'test-requester', description: 'b', lastStatus: 'grooming', messageTs: undefined });

  await assert.doesNotReject(() => bridge.pollOnce(), 'plan A\'s failures must be contained to plan A');

  const gates = slackFetch.calls
    .filter((c) => c.url.endsWith('chat.postMessage'))
    .map((c) => JSON.parse(c.body))
    .filter((b) => !b.thread_ts);
  assert.deepEqual(gates.map((g) => g.channel), ['CA', 'CB'], 'both gates posted, in watch order');

  const completes = slackFetch.calls.filter((c) => c.url.endsWith('files.completeUploadExternal')).map((c) => JSON.parse(c.body));
  assert.equal(completes.length, 1, 'exactly one upload completed — B\'s');
  assert.equal(completes[0].channel_id, 'CB');
  assert.equal(completes[0].thread_ts, 'TS-B');
});

test('upload byte-length: astral emoji in plan fields — the declared length is utf-8 BYTES (4/emoji), never UTF-16 code units (2/emoji)', async () => {
  const publicPlan = fixturePublicPlan({
    plan: {
      ...fixtureGroomedPlan,
      epic: { ...fixtureGroomedPlan.epic, why: `${fixtureGroomedPlan.epic.why} 🚀🎯🧪` },
    },
  });
  const { bridge, slackFetch } = makePlanReadyBridge(happyPathResponder, publicPlan);
  await bridge.pollOnce();

  const rendered = renderPlanText({ ...publicPlan, description: 'search history' });
  assert.ok(rendered.includes('🚀🎯🧪'), 'sanity: the astral chars reach the file body');
  const getUrlCall = slackFetch.calls.find((c) => c.url.endsWith('files.getUploadURLExternal'));
  const declared = Number(new URLSearchParams(getUrlCall.body).get('length'));
  assert.equal(declared, Buffer.byteLength(rendered, 'utf8'));
  assert.ok(declared > rendered.length, 'bytes must exceed code units when astral chars are present — pins Buffer.byteLength vs .length');
  const bytesCall = slackFetch.calls.find((c) => c.url === UPLOAD_URL);
  assert.equal(Buffer.byteLength(String(bytesCall.body), 'utf8'), declared, 'the declared length matches the bytes actually sent');
});

// ---------------------------------------------------------------------------
// 6 — interplay: placeholder evolution unchanged by the upload leg
// ---------------------------------------------------------------------------

test('interplay: shape_ready still updates the placeholder IN PLACE; plan_ready then posts FRESH and threads the upload on the NEW ts', async () => {
  const planId = PLAN_ID;
  let currentPlan = {
    plan_id: planId, status: 'shape_ready', cost_usd: 0.8,
    skeleton: fixtureSkeleton, skeleton_gate: { ok: true },
  };
  const serviceFetch = makeRecordingFetch((call) =>
    (call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('chat.update')) return fakeResponse(200, { ok: true, ts: JSON.parse(call.body).ts });
    return happyPathResponder(call);
  });
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, {
    channel: 'C1', requester: 'test-requester', description: 'search history',
    lastStatus: 'breaking_down', messageTs: 'PH_TS', placeholderActive: true,
  });

  // shape_ready → the placeholder evolves in place; no post, no upload.
  await bridge.pollOnce();
  const updates = slackFetch.calls.filter((c) => c.url.endsWith('chat.update')).map((c) => JSON.parse(c.body));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, 'PH_TS', 'the placeholder message itself is transformed');
  assert.match(updates[0].blocks[0].text.text, /Proposed plan/);
  assert.equal(slackFetch.calls.some((c) => c.url.endsWith('chat.postMessage')), false, 'no fresh post at shape_ready');
  assert.equal(slackFetch.calls.some((c) => c.url.endsWith('files.getUploadURLExternal')), false, 'no upload at shape_ready');

  // plan_ready → fresh gate post + upload threaded on the NEW ts, placeholder untouched.
  currentPlan = fixturePublicPlan();
  await bridge.pollOnce();
  assert.equal(slackFetch.calls.filter((c) => c.url.endsWith('chat.update')).length, 1, 'the placeholder is not touched again');
  const gate = slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).map((c) => JSON.parse(c.body)).find((b) => !b.thread_ts);
  assert.match(gate.blocks[0].text.text, /Groomed & gate-checked/);
  const complete = slackFetch.calls.filter((c) => c.url.endsWith('files.completeUploadExternal')).map((c) => JSON.parse(c.body));
  assert.equal(complete.length, 1);
  assert.equal(complete[0].thread_ts, GATE_TS, 'the file hangs off the fresh gate post, not the old placeholder');
  assert.equal(bridge.watched.get(planId).messageTs, GATE_TS, 'messageTs advances to the gate post');
});

// ---------------------------------------------------------------------------
// 7 — gate-truthfulness sweep: no overclaiming gate line survives on ANY surface
// ---------------------------------------------------------------------------

test('gate-truthfulness sweep: no surface anywhere still says "treecheck OK"; created\'s verify icon is conditional, not always-green', () => {
  const surfaces = [
    skeletonMessage(fixturePublicPlan({ status: 'shape_ready', description: 'search history' })),
    planReadyMessage(fixturePublicPlan()),
    planReadyMessage(fixturePublicPlan({ plan_gate: { ok: true, skipped: true } })),
    planReadyMessage(syntheticPlan(9)), // compact
    createdMessage({ plan_id: PLAN_ID, created: { keys: ['PROJ-1'], verify_ok: true } }),
    createdMessage({ plan_id: PLAN_ID, created: { keys: ['PROJ-1'], verify_ok: false } }),
    terminalMessage({ plan_id: PLAN_ID, status: 'failed', error: 'x', created: { record_path: '/r' } }),
    cancelledMessage({ plan_id: PLAN_ID, created: { keys: ['PROJ-1'] } }),
    preparingMessage({ description: 'search history', outputLanguage: 'en' }),
  ];
  for (const msg of surfaces) {
    assert.equal(JSON.stringify(msg).includes('treecheck'), false, 'the old overclaiming gate wording must be gone from every surface');
  }
  // Both gate surfaces name the human reviewer.
  assert.ok(contextTexts(surfaces[0]).some((t) => t.includes('correctness NOT auto-checked — you are the reviewer')));
  assert.ok(contextTexts(surfaces[1]).some((t) => t === 'structure ✅ · anchors resolve ✅ · correctness NOT auto-checked — you are the reviewer'));
  // A skipped plan gate skipped the WHOLE gate (structure included) — no ✅
  // segment of any kind may survive, only the honest not-checked line.
  assert.ok(contextTexts(surfaces[2]).some((t) => t === 'plan gate skipped — not checked · correctness NOT auto-checked — you are the reviewer'));
  assert.equal(contextTexts(surfaces[2]).some((t) => t.includes('✅')), false, 'a skipped gate must not print any ✅');
  // Fail closed: an absent gate result must never earn any ✅ either.
  const absentGate = planReadyMessage(fixturePublicPlan({ plan_gate: undefined }));
  assert.ok(contextTexts(absentGate)
    .some((t) => t === 'plan gate: no result — not checked · correctness NOT auto-checked — you are the reviewer'));
  assert.equal(contextTexts(absentGate).some((t) => t.includes('✅')), false, 'an absent gate result must not print any ✅');
  // created's ✅ is a REAL claim (post-create verify result), so it must flip.
  assert.match(surfaces[4].blocks[0].text.text, /verify: ✅/);
  assert.match(surfaces[5].blocks[0].text.text, /verify: ⚠️/);
});

// ---------------------------------------------------------------------------
// The zero-anchor safeguard exposes a possible no-go-zone dodge at the gate.
// ---------------------------------------------------------------------------

test('zero-anchor safeguard: a zero-anchor item on a multi-item plan is flagged in the rich tier AND the full-truth file; anchored siblings and one-node plans are exempt', () => {
  const items = [syntheticItem(1, { anchors: [] }), syntheticItem(2, {})];
  const plan = planFromItems(items);
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);

  const joined = sectionTexts(msg).join('\n');
  assert.match(joined, /⚠ 0 anchors — coupling-zone routing not machine-checkable/,
    'the flag must render at the gate (mirrors the Go gate: precheck.go checkZoneRouting (c))');
  assert.equal(joined.split('⚠ 0 anchors').length - 1, 1, 'ONLY the dodging item is flagged, never its anchored sibling');

  const text = renderPlanText(plan);
  assert.match(text, /⚠ 0 anchors — coupling-zone routing not machine-checkable/,
    'the full-truth file carries the same flag');

  // One-node plans are exempt by design (quick single-ticket fixes).
  const single = planFromItems([syntheticItem(1, { anchors: [] })]);
  assert.equal(sectionTexts(planReadyMessage(single)).join('\n').includes('⚠ 0 anchors'), false,
    'a one-node plan must not be flagged');
  assert.equal(renderPlanText(single).includes('⚠ 0 anchors'), false);
});

test('zero-anchor safeguard compact tier: the zero-anchor item carries the ⚠ marker on its packed line — and only that item', () => {
  const items = [];
  for (let n = 1; n <= 10; n += 1) items.push(syntheticItem(n, n === 3 ? { anchors: [] } : {}));
  const plan = planFromItems(items);
  const msg = planReadyMessage(plan);
  assertGateInvariants(msg, plan.plan_id);
  const joined = sectionTexts(msg).join('\n');
  assert.match(joined, /anchors:0 ⚠/, 'the compact line marks the dodge');
  assert.equal(joined.split('anchors:0 ⚠').length - 1, 1, 'only the dodging item is marked');
  assert.equal(joined.split('⚠').length - 1, 1, 'no stray flag on anchored items');
});
