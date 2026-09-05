import { readEnv } from '../dashboard/lib/env.mjs';
// slack-blocks.mjs — pure Slack Block Kit message builders for the Radsvinn
// Slack bridge (service/slack.mjs). No IO, no Slack/HTTP calls: every export
// here is a plain function that takes plan data (the shape GET /plan/{id}
// returns — `toPublicView()` in server.mjs — optionally carrying a
// bridge-tracked `description`; see slack.mjs's file header for why that
// field isn't part of the service's own response) and returns a
// JSON-serializable Slack payload fragment (`{text, blocks}` or an ack
// object). Kept separate from slack.mjs's Socket Mode / fetch plumbing so
// every message shape is unit-testable with zero sockets and zero network
// (service/test/slack.test.mjs).
//
// Implements the Slack approval surface described in docs/ARCHITECTURE.md.

// The Jira browse base is derived from RADSVINN_JIRA_SITE_URL (the operator's
// Jira site, e.g. https://your-domain.atlassian.net) — browse links are
// `${site}/browse/<KEY>`. No hardcoded site: the value is read once at module
// load (the container env is populated before the Slack bridge imports this
// module) and the falls-back-to-example placeholder keeps this pure renderer
// crash-free when the site is unconfigured. This is the module's only env read;
// every export stays a pure function of its plan-data argument.
const JIRA_SITE_URL = String(readEnv('RADSVINN_JIRA_SITE_URL') || 'https://your-domain.atlassian.net').trim().replace(/\/+$/, '');
const JIRA_BROWSE_BASE = `${JIRA_SITE_URL}/browse`;
const DEFAULT_ACK_TEXT = "📋 Planning… I'll post the proposed shape here shortly.";

// ---------------------------------------------------------------------------
// small formatting helpers (private)
// ---------------------------------------------------------------------------

// Never emit a lone surrogate: the fixed code-unit slice can land mid
// astral pair (emoji), and an unpaired high surrogate makes the whole
// section text ill-formed Unicode on the wire (� at best, a rejected
// payload at worst). Dropping the dangling half costs one code unit and
// keeps every caller's budget intact. The guard lives HERE, in the plain
// helper, so every fixed-cut caller inherits it: truncateMarked below,
// terminalMessage's 500-cut error and fallback text, the preparing 140,
// the skeleton-header 80, and the dup-line 80/160 cuts.
function truncate(value, max) {
  let cut = String(value || '').slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// Truncation that leaves a visible mark: the reader of the create gate must
// be able to tell "this field was cut — the full text is in the attached
// file" from "this field really ends here". Never used on code-anchor paths
// (a truncated path is a lie about what the groomer verified). Delegates
// the cut (and its surrogate guard) to truncate above.
function truncateMarked(value, max) {
  const s = String(value == null ? '' : value).trim();
  if (s.length <= max) return s;
  return `${truncate(s, max)}…`;
}

// ---------------------------------------------------------------------------
// mrkdwn safety helpers (private)
// ---------------------------------------------------------------------------

// Slack's official "Escaping text" rules (docs.slack.dev, verified
// 2026-07-10): exactly three characters are control characters in message
// text — & < > — and they must be sent as HTML entities, & first so the
// entities just produced aren't re-escaped. Plan/skeleton/ask-derived text
// is untrusted end-to-end and this rendering IS
// the safety gate, so this is not cosmetic: a raw `<!channel>` in a plan
// field mass-pings, a raw `<http://evil|innocent-path>` forges a link, and
// legitimate prose like `<Suspense>` or `Promise<T>` is silently EATEN by
// Slack's parser — the approver approves content they cannot see. Applied
// at the render boundary only (NEVER in renderPlanText — the attached file
// is raw text by design) and always BEFORE truncation/budget measurement,
// so the 2900/3000 budgets hold on the lengthened (`&amp;` = 5 chars)
// output.
function mrkdwnEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// For values rendered inside an INLINE `code span` (anchor paths): a
// backtick in the value terminates the span early and spills the rest of
// the value into live mrkdwn. mrkdwn has no escape sequence for a backtick
// inside a span, so swap it for the visually-close ʼ (U+02BC) — anchor
// paths are the one never-truncated slot, and a one-glyph substitution is
// preferable to letting the value break out of its span.
function codeSpanText(value) {
  return mrkdwnEscape(value).replace(/`/g, 'ʼ');
}

// For the skeleton tree rendered inside a ``` fence: a summary containing a
// run of three-plus backticks would CLOSE the fence early and spill the
// rest of the tree (plus any smuggled formatting) into live mrkdwn. Space
// such runs out (``` → ` ` `) so no three consecutive backticks survive;
// lone backticks are harmless inside a fence. Entity-escaping still applies
// — Slack decodes entities inside fences, so &lt; renders as a literal <.
function fenceText(value) {
  return mrkdwnEscape(value).replace(/`{3,}/g, (run) => run.split('').join(' '));
}

// The skeleton tree's fence body budget: 2800 post-escape chars keeps the
// whole section (body + 6 fence backticks) safely under Slack's 3000/section
// hard limit. Unbudgeted, a ~31-item skeleton overflows post-escape and
// chat.postMessage rejects it — the shape gate then silently never posts and
// the plan stalls at shape_ready with no retry.
const SKELETON_FENCE_CHARS = 2800;

// Budgets an already-fenceText'd tree to `maxChars` by dropping whole LINES
// from the end (never mid-line — a half line would misread as a real item)
// and appending an in-fence honest marker naming the dropped count and the
// full-shape fallback. Whole-line drops can never split an entity, a spaced
// backtick run, or a surrogate pair (none of those span a '\n').
// Terminating by construction: `kept` strictly decreases to 0, and at
// kept === 0 the marker alone is returned unconditionally (bounded — the
// plan id is a service-validated UUID).
function budgetFenceTree(tree, planId, maxChars = SKELETON_FENCE_CHARS) {
  if (tree.length <= maxChars) return tree;
  const lines = tree.split('\n');
  for (let kept = lines.length - 1; kept >= 0; kept -= 1) {
    const marker = `… (+${lines.length - kept} more lines — full shape via GET /plan/${fenceText(String(planId || '(unknown)'))})`;
    const body = kept > 0 ? `${lines.slice(0, kept).join('\n')}\n${marker}` : marker;
    if (body.length <= maxChars || kept === 0) return body;
  }
  return tree; // unreachable — the kept === 0 iteration always returns
}

// A missing field at the create gate must be VISIBLE, not silently omitted —
// an item with no why / DoD / AC is exactly the kind of thing the human
// reviewer (the human correctness check) needs to see and reject.
function orNone(value) {
  const s = String(value == null ? '' : value).trim();
  return s.length > 0 ? s : '(none)';
}

function formatCost(costUsd) {
  const n = Number(costUsd);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

// The groomed plan's `technical_analysis.coupling_zones` uses the literal
// string "none" (not an empty array) to mean "no zone" (see
// fixtures/e2e-sample/plan.json) — normalize both that and a genuinely
// empty/missing array to the same human-readable "none".
function formatZones(zones) {
  if (!Array.isArray(zones) || zones.length === 0) return 'none';
  const named = zones.filter((z) => z && z !== 'none');
  return named.length > 0 ? named.join(', ') : 'none';
}

// "dup check: no matches" when the advisory search found nothing (including
// the fake engine's canned "no matches (fake)" output); otherwise the first
// couple of output lines, so the context block this feeds stays short.
function duplicateSearchLine(duplicateSearch) {
  if (!duplicateSearch) return 'dup check: unavailable';
  // The search output can echo ask-derived text (matched ticket summaries)
  // and lands in context mrkdwn — escaped like every other plan-derived
  // field, before the 80/160 cuts so the budgets hold post-escape.
  const output = mrkdwnEscape(String(duplicateSearch.output || '').trim());
  if (duplicateSearch.ok === false) {
    return `dup check: unavailable${output ? ` (${truncate(output, 80)})` : ''}`;
  }
  if (output.length === 0 || /no matches/i.test(output)) return 'dup check: no matches';
  const firstLines = output.split('\n').slice(0, 2).join(' / ');
  return `dup check: ${truncate(firstLines, 160)}`;
}

function statusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

// Honest gate line. The old "gate: ✅ treecheck
// OK" read as "this plan was checked and passed"; what the machine actually
// verified is STRUCTURE (and, at plan_ready, anchor existence — unless a
// fake-engine server translated RADSVINN_SKIP_PLAN_ANCHORS=1 into an explicit
// whole-plan-gate skip, whose result is `{ok:true, skipped:true}`).
// Correctness of the ticket CONTENT is checked by nobody but the human
// reading this message — say so on both gate surfaces.
const HONEST_GATE_TAIL = 'correctness NOT auto-checked — you are the reviewer';

function planGateLine(planGate) {
  // Fail closed: only a PRESENT, non-skipped, ok gate result has actually
  // verified anything. The fake-server-only RADSVINN_SKIP_PLAN_ANCHORS
  // compatibility knob covers the WHOLE plan gate (structure AND anchors),
  // not just anchor resolution — so a skipped or absent gate must not print
  // `structure ✅` either; that would claim a check that never ran, exactly
  // the overclaiming this guard prevents, on the gate where it matters most.
  // Each not-checked case names its own reason so the reviewer knows
  // whether to ask "why was the gate skipped?" or "why is there no gate
  // result at all?". The honest tail survives in EVERY variant.
  if (!planGate) return `plan gate: no result — not checked · ${HONEST_GATE_TAIL}`;
  if (planGate.skipped) return `plan gate skipped — not checked · ${HONEST_GATE_TAIL}`;
  // Defensive: plan_ready should never carry a failed gate (the worker
  // routes a red gate to `failed`), but if it ever does, say so — never ✅.
  if (planGate.ok !== true) return `plan gate failed ❌ · ${HONEST_GATE_TAIL}`;
  return `structure ✅ · anchors resolve ✅ · ${HONEST_GATE_TAIL}`;
}

function mrkdwn(text) {
  return { type: 'mrkdwn', text };
}

function actionsBlock(buttons) {
  return {
    type: 'actions',
    elements: buttons.map((b) => ({
      type: 'button',
      text: { type: 'plain_text', text: b.label, emoji: true },
      action_id: b.actionId,
      value: b.value,
      ...(b.style ? { style: b.style } : {}),
      // Optional Slack confirmation dialog — the click only reaches the
      // bridge after the user confirms (used by the destructive Cancel tree
      // button; every other button stays one-click).
      ...(b.confirm ? { confirm: b.confirm } : {}),
    })),
  };
}

// The confirm-guarded "Cancel tree" button — shared by createdMessage
// and terminalMessage's failed-with-record case so both surfaces carry the
// exact same button + confirmation dialog. `style: 'danger'` on the confirm
// object makes the dialog's confirm button red (Slack's own guidance for
// destructive confirms).
function cancelTreeButton(planId) {
  return {
    label: 'Cancel tree',
    actionId: 'cancel_tree',
    value: planId,
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: 'Cancel this tree?' },
      text: {
        type: 'plain_text',
        text: 'Every ticket in this tree will be transitioned to a terminal state (cancelled/closed where available), never deleted. This cannot be undone from Slack.',
      },
      confirm: { type: 'plain_text', text: 'Cancel tree' },
      deny: { type: 'plain_text', text: 'Keep it' },
      style: 'danger',
    },
  };
}

// ---------------------------------------------------------------------------
// renderSkeletonTree — the ```code block``` body inside the shape_ready post
// ---------------------------------------------------------------------------

/**
 * Renders a skeleton's items as a plain-text tree: `[Type] tid —
 * one_line_summary`, grouped under each milestone's name (ordered by
 * `order`) when the skeleton has MORE THAN ONE item AND at least one
 * milestone. A one-node skeleton always renders as just that single line,
 * ungrouped, regardless of whether a milestone happens to exist. Items
 * whose `milestone_id` doesn't match any milestone fall into a trailing
 * "(unassigned)" bucket rather than being silently dropped.
 */
export function renderSkeletonTree(skeleton) {
  // .filter(Boolean): a null/undefined ELEMENT inside an otherwise-valid
  // array must be dropped, not crash the builder (same fail-open discipline
  // as the Array.isArray guards — a throw here silences the poller).
  const items = Array.isArray(skeleton && skeleton.items) ? skeleton.items.filter(Boolean) : [];
  const milestones = Array.isArray(skeleton && skeleton.milestones) ? skeleton.milestones.filter(Boolean) : [];
  const itemLine = (item) => `[${item.type || '?'}] ${item.temp_id || '?'} — ${item.one_line_summary || '(no summary)'}`;

  if (items.length === 0) return '(no items)';
  if (items.length === 1 || milestones.length === 0) {
    return items.map(itemLine).join('\n');
  }

  const ordered = milestones.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const itemsByMilestone = new Map(ordered.map((m) => [m.milestone_id, []]));
  const unassigned = [];
  for (const item of items) {
    const bucket = itemsByMilestone.get(item.milestone_id);
    if (bucket) bucket.push(item);
    else unassigned.push(item);
  }

  const lines = [];
  for (const m of ordered) {
    lines.push(`${m.name}:`);
    for (const item of itemsByMilestone.get(m.milestone_id)) lines.push(`  ${itemLine(item)}`);
  }
  if (unassigned.length > 0) {
    lines.push('(unassigned):');
    for (const item of unassigned) lines.push(`  ${itemLine(item)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// message builders
// ---------------------------------------------------------------------------

// The shared "asked by <@id>" attribution line is a standalone context
// block. `requesterId` is the stable Slack id captured at slash time, so
// `<@id>` renders as a real member reference. Returns null when the id is
// absent (legacy plans predate requester_id, and a bare `asked by <@>` is
// noise), and callers spread it in conditionally. The id is mrkdwnEscape'd
// defensively: requester_id rides POST /plan UN-validated (fail-open), so a
// poisoned value like `U1>x<!channel` must never break out of the `<@…>`
// wrapper and smuggle a channel-wide ping onto a create/preparing surface —
// a valid Slack id ([UW][A-Z0-9]+) contains none of & < > and passes through
// byte-identical. Deliberately NOT applied to the two GATE builders
// (skeletonMessage / planReadyMessage): each gate prepends a <@id> mention,
// which doubles as attribution — adding a line here too would
// double-mention/double-ping the same person.
export function requesterAttributionLine(requesterId) {
  // Truncate defensively BEFORE escaping/wrapping. requester_id rides POST
  // /plan UN-validated (fail-open) and is the only user-text-into-a-block field
  // in this file without a length cap — every sibling (description 140, prefill
  // 2900, skeleton tree 2800) is budgeted against Slack's ~3000-char per-block
  // limit. An oversized id would push createdMessage past that limit →
  // chat.postMessage `invalid_blocks` → the `created` announcement (and its
  // only non-CLI Cancel-tree undo) would DETERMINISTICALLY never post (the
  // created branch, unlike plan_ready, has no degraded fallback). 80 chars is
  // generous headroom over any real Slack id (~11 chars).
  const id = truncate(String(requesterId == null ? '' : requesterId).trim(), 80);
  if (id.length === 0) return null;
  return { type: 'context', elements: [mrkdwn(`asked by <@${mrkdwnEscape(id)}>`)] };
}

// Counts the advisory over-cap sizing WARNs the skeleton gate carries
// (2026-07-13 sizing-warn demotion): the per-leaf $10 cost cap no longer BLOCKS
// the shape gate — an over-cap leaf rides through as a non-blocking WARN on
// sizing_sane. Derived from the gate result ALREADY on the plan
// (plan.skeleton_gate, surfaced by toPublicView) — not a re-parse of raw. Only
// the demoted-cap advisory WARN is counted (it carries "exceeds $" AND
// "(advisory)"); the warn-band and micro-leaf-floor WARNs are a different
// signal and deliberately NOT surfaced here. Any shape anomaly → 0 (silent).
function oversizedLeafCount(gate) {
  try {
    const complaints = gate && gate.raw && gate.raw.checks
      && gate.raw.checks.sizing_sane && gate.raw.checks.sizing_sane.complaints;
    if (!Array.isArray(complaints)) return 0;
    return complaints.filter(
      (c) => typeof c === 'string' && c.includes('exceeds $') && c.includes('(advisory)'),
    ).length;
  } catch {
    return 0;
  }
}

/**
 * shape_ready. The skeleton gate is always green (ok:true) by the time a plan
 * reaches this status (runPhase1Worker routes a failed gate to `failed`, never
 * `shape_ready` — see server.mjs), so the gate line is always the pass line. It
 * MAY still carry non-blocking WARN complaints — an oversized-ticket advisory
 * is surfaced concisely in the context (see oversizedLeafCount), mirroring how
 * the zero-anchor flag / grounding note are surfaced: informational, the
 * human decides.
 *
 * Gate messages get requester attribution through the prepended mention —
 * do not add requesterAttributionLine here (it would double-ping the
 * requester).
 */
export function skeletonMessage(plan) {
  // Ask/skeleton-derived → escaped BEFORE the 80-char cut so the budget
  // holds post-escape. The same escaped value feeds the header section AND
  // the top-level notification fallback `text` (also mrkdwn-parsed).
  const description = truncate(
    mrkdwnEscape(plan.description || (plan.skeleton && plan.skeleton.epic && plan.skeleton.epic.summary) || '(no description)'),
    80,
  );
  // fenceText: escape + neutralize ```-runs so a hostile summary can
  // neither ping/link nor close the code fence early (see the helper).
  // budgetFenceTree: measured on the escaped (lengthened) text, same
  // escape-before-budget discipline as every other surface — whole lines
  // are dropped with an in-fence honest marker, never a mid-line cut.
  const tree = budgetFenceTree(fenceText(renderSkeletonTree(plan.skeleton || {})), plan.plan_id);
  const cost = formatCost(plan.cost_usd);
  // Surface the chosen language — and the scope directive when the
  // requester constrained it — at the FIRST gate, where regenerating is
  // still cheap (a wrong output_language discovered only after Groom would
  // waste that phase's work). Both values ride
  // toPublicView (`output_language` / `scope_hint`) and are server-validated
  // enums, but they are escaped anyway — house rule: every plan-derived
  // value is escaped at the render boundary. Omitted (not "(none)") when
  // absent, so legacy plans keep the exact original context line (an
  // exact-string contract in slack-plan-gate.test.mjs).
  const langNote = plan.output_language ? ` · lang: ${mrkdwnEscape(plan.output_language)}` : '';
  const scopeNote = plan.scope_hint && plan.scope_hint !== 'auto' ? ` · scope: ${mrkdwnEscape(plan.scope_hint)}` : '';
  // Grounding depth at the shape gate (2026-07-11, mirrors scopeNote): a
  // light-grounded plan MUST be visibly marked where it is approved, so the
  // human never rubber-stamps an under-grounded ticket thinking its anchors
  // were deeply verified. `full` is the default and shows nothing — legacy
  // plans (no grounding_hint) keep the exact original context line.
  const groundingHintNote = plan.grounding_hint === 'light' ? ` · grounding: ${mrkdwnEscape(plan.grounding_hint)}` : '';
  // A failed fetch-before-plan must be VISIBLE at the first
  // human gate — anchors were validated against whatever origin/main the
  // local clones held, which may be stale. Absent or ok:true → no note
  // (legacy plans and flag-off keep the exact original context line).
  const groundingNote = plan.grounding && !plan.grounding.ok
    ? ' · ⚠ grounding fetch failed — anchors may validate against stale code'
    : '';
  // Attach mode must be VISIBLE at the human gates: the create-time GET only
  // proves the key EXISTS and is an
  // Epic — a hallucinated-but-valid existing_key sails through it, so the
  // approver is the only check that the attach TARGET is the intended one.
  // Rendered on the header section (the most prominent slot), escaped like
  // every skeleton-derived value (the key is untrusted text until create).
  // Absent/blank → no line at all, preserving the legacy message shape.
  const rawAttachKey = plan.skeleton && plan.skeleton.epic && plan.skeleton.epic.existing_key;
  const attachNote = typeof rawAttachKey === 'string' && rawAttachKey.trim().length > 0
    ? `\n↷ attaches to existing *${mrkdwnEscape(rawAttachKey.trim())}*`
    : '';
  // Advisory over-cap sizing WARN (2026-07-13): the leaf-cost cap no longer
  // blocks the gate, so an oversized ticket reaches this pass line — surface a
  // concise, non-blocking nudge so the reviewer still sees it. Absent (0) → no
  // note, preserving the exact legacy context line.
  const oversized = oversizedLeafCount(plan.skeleton_gate);
  const sizingNote = oversized > 0
    ? ` · ⚠ ${oversized} oversized ticket${oversized === 1 ? '' : 's'} — consider splitting`
    : '';

  return {
    text: `Proposed plan — ${description}`,
    blocks: [
      { type: 'section', text: mrkdwn(`🧩 Proposed plan — *${description}*${attachNote}`) },
      { type: 'section', text: mrkdwn('```' + tree + '```') },
      { type: 'context', elements: [mrkdwn(`structure ✅ · ${HONEST_GATE_TAIL} · cost so far $${cost}${langNote}${scopeNote}${groundingHintNote}${groundingNote}${sizingNote}`)] },
      actionsBlock([
        { label: 'Approve — write tickets', actionId: 'approve_shape', value: plan.plan_id, style: 'primary' },
        { label: 'Reject', actionId: 'reject', value: plan.plan_id, style: 'danger' },
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// planReadyMessage — the create gate
// ---------------------------------------------------------------------------
// The human approve-gate is the ONLY correctness check of the
// whole pipeline, so this message must show the actual ticket CONTENT — the
// old counts line ("AC: 4 · anchors: 2 · …") made the reviewer click "Create
// in Jira" blind. Two adaptive tiers, chosen by COMPUTED budget against
// Slack's hard limits (50 blocks/message, 3000 chars per section text):
//
// - RICH: one section per item with why / DoD / AC / TA / anchor paths.
//   Chosen when items ≤ RICH_MAX_ITEMS AND every rendered per-item section
//   is ≤ RICH_MAX_SECTION_CHARS (computed on the actual rendered text, never
//   guessed — long untruncatable anchor paths are what push a small plan
//   over).
// - COMPACT: one line per item (summary + first ~100 chars of why + counts),
//   packed into as few sections as fit; the FULL untruncated text arrives as
//   the in-thread file upload (renderPlanText below), which the context line
//   points at.

const RICH_MAX_ITEMS = 8;
const RICH_MAX_SECTION_CHARS = 2900; // safety margin under Slack's 3000/section
const RICH_MAX_AC_SHOWN = 6;
const RICH_MAX_ANCHORS_SHOWN = 8;
const COMPACT_SECTION_CHARS = 2900;
// Slack caps a message at 50 blocks; header + context + actions are always
// present, so compact item sections may use at most 50 - 3.
const COMPACT_MAX_ITEM_SECTIONS = 47;
// Slack ALSO rejects any chat.postMessage whose serialized `blocks` argument
// is >= 100,001 characters (`invalid_arguments`, empirically proven against
// blocks.validate 2026-07-10) — a limit the per-section and per-block-count
// budgets above do NOT imply: 47 sections × ~2900 chars is ~136K, and JSON
// escaping inflates further (`"`/`\` double, control chars go 6× as \uXXXX).
// 90K leaves a 10% margin under the hard limit.
const MAX_BLOCKS_JSON = 90_000;

function groomedItemView(item, skeletonByTempId) {
  const skeletonMatch = skeletonByTempId.get(item.temp_id);
  const fields = item.fields || {};
  const relatedLinks = fields.related_links || {};
  const technicalAnalysis = fields.technical_analysis || {};
  return {
    type: item.type || '?',
    summary: (skeletonMatch && skeletonMatch.one_line_summary) || item.temp_id,
    why: fields.why,
    definitionOfDone: fields.definition_of_done,
    // .filter(Boolean) on the element lists: a null/undefined ELEMENT inside
    // an otherwise-valid array must be dropped, not rendered as a literal
    // "null" line ("1. null" in the full-truth file, "• (none)" bullets and
    // inflated AC/anchor counts at the gate) — same discipline as the
    // top-level items guards.
    acceptanceCriteria: Array.isArray(fields.acceptance_criteria) ? fields.acceptance_criteria.filter(Boolean) : [],
    taProse: technicalAnalysis.prose,
    anchors: Array.isArray(relatedLinks.code_anchors) ? relatedLinks.code_anchors.filter(Boolean) : [],
    zones: formatZones(technicalAnalysis.coupling_zones),
    effort: item.effort_tier || 'unknown',
  };
}

/**
 * The RICH tier's per-item mrkdwn text — actual content, marked truncation.
 * Every plan-derived value is mrkdwn-escaped here, at the render boundary,
 * BEFORE its truncation budget is measured (see mrkdwnEscape); anchors go
 * through codeSpanText so a backtick in a path can't break out of its span.
 */
// The zero-anchor flag line, rendered when an item
// on a MULTI-item plan declares zero code anchors — the omission that gives
// zone routing nothing to match, so coupled work can dodge the no-go-zone
// gate while rendering a plausible `zones: none`. This mirrors the
// deterministic gate's own flag predicate (internal/checks/precheck.go,
// checkZoneRouting (c)) as a DERIVED render rather than a parse of
// plan_gate.raw — gates.mjs deliberately never depends on treecheck's verdict
// JSON shape, and this surface keeps that decoupling. Non-blocking by
// This is deliberately non-blocking: the human sees it and decides.
const ZERO_ANCHOR_FLAG = '⚠ 0 anchors — coupling-zone routing not machine-checkable';

function renderRichItemText(view, flagZeroAnchors = false) {
  const lines = [`*${mrkdwnEscape(view.type)}* ${mrkdwnEscape(view.summary)}`];
  lines.push(`*Why:* ${orNone(truncateMarked(mrkdwnEscape(view.why), 300))}`);
  lines.push(`*DoD:* ${orNone(truncateMarked(mrkdwnEscape(view.definitionOfDone), 300))}`);
  if (view.acceptanceCriteria.length === 0) {
    lines.push('*AC:* (none)');
  } else {
    lines.push('*AC:*');
    for (const ac of view.acceptanceCriteria.slice(0, RICH_MAX_AC_SHOWN)) {
      lines.push(`• ${orNone(truncateMarked(mrkdwnEscape(ac), 150))}`);
    }
    if (view.acceptanceCriteria.length > RICH_MAX_AC_SHOWN) {
      lines.push(`…and ${view.acceptanceCriteria.length - RICH_MAX_AC_SHOWN} more`);
    }
  }
  lines.push(`*TA:* ${orNone(truncateMarked(mrkdwnEscape(view.taProse), 300))}`);
  if (view.anchors.length === 0) {
    lines.push('*Anchors:* (none)');
    if (flagZeroAnchors) lines.push(ZERO_ANCHOR_FLAG);
  } else {
    lines.push('*Anchors:*');
    // Anchor paths are the point — the reviewer verifies the groomer looked
    // at the right code. NEVER truncate a path; overflow drops whole paths
    // with an honest count instead.
    for (const anchor of view.anchors.slice(0, RICH_MAX_ANCHORS_SHOWN)) {
      lines.push(`\`${codeSpanText(anchor)}\``);
    }
    if (view.anchors.length > RICH_MAX_ANCHORS_SHOWN) {
      lines.push(`…and ${view.anchors.length - RICH_MAX_ANCHORS_SHOWN} more`);
    }
  }
  lines.push(`zones: ${mrkdwnEscape(view.zones)} · effort: ${mrkdwnEscape(view.effort)}`);
  return lines.join('\n');
}

/**
 * The COMPACT tier's one-line-per-item form. Same escape-before-truncate
 * discipline as the rich tier (the packer then measures the escaped lines).
 */
function renderCompactItemLine(view, flagZeroAnchors = false) {
  const why = orNone(truncateMarked(mrkdwnEscape(view.why), 100));
  const summary = truncateMarked(mrkdwnEscape(view.summary), 200);
  const acCount = view.acceptanceCriteria.length;
  // Compact form: `anchors:0` alone reads like ordinary
  // metadata — the ⚠ marks it as the coupling-zone dodge signal (see
  // ZERO_ANCHOR_FLAG above; the full wording rides the rich tier and the
  // attached file).
  const flag = flagZeroAnchors ? ' ⚠' : '';
  return `*${mrkdwnEscape(view.type)}* ${summary} — why: ${why} · AC:${acCount} · anchors:${view.anchors.length}${flag} · zones:${mrkdwnEscape(view.zones)} · effort:${mrkdwnEscape(view.effort)}`;
}

/**
 * Packs compact item lines into as few section blocks as fit, each within
 * `maxChars`, using at most `maxSections` blocks. Returns
 * `{sections: [{text, itemCount}], dropped}` — each section carries how many
 * item lines it holds and `dropped` counts the tail that didn't fit the
 * section cap, so planReadyMessage's honest "…and N more item(s)" context
 * line (and its later JSON-budget degrade) can always keep
 * rendered + dropped === total. The attached file always carries the full
 * list either way.
 */
function packCompactSections(lines, maxChars, maxSections) {
  const sections = [];
  let current = [];
  let currentLen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = truncateMarked(lines[i], maxChars);
    const extra = (current.length > 0 ? 1 : 0) + line.length; // +1 for '\n'
    if (current.length > 0 && currentLen + extra > maxChars) {
      sections.push({ text: current.join('\n'), itemCount: current.length });
      if (sections.length === maxSections) {
        return { sections, dropped: lines.length - i };
      }
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += (current.length > 1 ? 1 : 0) + line.length;
  }
  if (current.length > 0) sections.push({ text: current.join('\n'), itemCount: current.length });
  return { sections, dropped: 0 };
}

/**
 * plan_ready — the create gate. Renders actual ticket content per item
 * (rich tier) or one content-bearing line per item plus a pointer at the
 * attached full-plan file (compact tier); see the tier note above. The
 * groomed plan.json items don't carry `one_line_summary` (only the skeleton
 * items do), so each item's display summary is looked up from the matching
 * skeleton item by `temp_id`, falling back to the bare `temp_id` when no
 * match exists. Header, dup-check line, cost, and the Create/Reject buttons
 * are unchanged from the prior message.
 *
 * Gate messages get requester attribution through the prepended mention —
 * do not add requesterAttributionLine here (it would double-ping the
 * requester).
 */
export function planReadyMessage(plan) {
  // Same Array.isArray guard renderPlanText already uses — a truthy
  // non-array `items` must render the sane empty gate, never crash the
  // poller (a throw here would silence every later plan's messages).
  // .filter(Boolean) extends the same guard to null/undefined ELEMENTS
  // inside a valid array: drop them, render the rest.
  const groomedItems = (plan.plan && Array.isArray(plan.plan.items)) ? plan.plan.items.filter(Boolean) : [];
  const skeletonItems = (plan.skeleton && Array.isArray(plan.skeleton.items)) ? plan.skeleton.items.filter(Boolean) : [];
  const skeletonByTempId = new Map(skeletonItems.map((i) => [i.temp_id, i]));
  const views = groomedItems.map((item) => groomedItemView(item, skeletonByTempId));
  // A one-node plan is exempt from the
  // zero-anchor flag by design — the flag targets multi-item plans where a
  // single anchor-less item can hide among anchored siblings.
  const multiItem = groomedItems.length > 1;
  const flagFor = (view) => multiItem && view.anchors.length === 0;

  // Tier choice is computed on the ACTUAL rendered rich sections.
  const richTexts = views.map((v) => renderRichItemText(v, flagFor(v)));
  const useRich = groomedItems.length <= RICH_MAX_ITEMS
    && richTexts.every((t) => t.length <= RICH_MAX_SECTION_CHARS);

  const packCompact = () =>
    packCompactSections(views.map((v) => renderCompactItemLine(v, flagFor(v))), COMPACT_SECTION_CHARS, COMPACT_MAX_ITEM_SECTIONS);

  let tier = useRich ? 'rich' : 'compact';
  let { sections, dropped } = tier === 'rich'
    ? { sections: richTexts.map((text) => ({ text, itemCount: 1 })), dropped: 0 }
    : packCompact();

  const dupLine = duplicateSearchLine(plan.duplicate_search);
  const cost = formatCost(plan.cost_usd);
  // The create gate — the pipeline's ONLY real correctness check — must
  // signal a light-grounded GROOM, mirroring the shape gate's
  // groundingHintNote (skeletonMessage). `light` affects both decompose and
  // GROOM, whose output THIS gate reviews, so the approver must know Groom ran
  // reduced exploration before clicking Create. `full`/legacy → no note.
  const groundingHintNote = plan.grounding_hint === 'light' ? ' · grounding: light (groom ran reduced exploration)' : '';

  const assemble = () => {
    const contextElements = [mrkdwn(`${dupLine} · cost $${cost}${groundingHintNote}`), mrkdwn(planGateLine(plan.plan_gate))];
    if (tier === 'compact') {
      // "see the attached file … (or GET /plan/{id})", NOT "attached below":
      // the upload leg can fail (missing files:write scope, network) after
      // this message already posted — the pointer must not assert a file
      // that may never arrive, and the GET fallback is always available.
      // When any items were dropped (the 47-section cap and/or the JSON
      // budget below), the honest count is folded into this same line so
      // rendered + dropped always equals the plan's item total.
      const pointer = `full ticket text: see the attached file in this thread (or GET /plan/${mrkdwnEscape(plan.plan_id)})`;
      contextElements.push(mrkdwn(dropped > 0 ? `…and ${dropped} more item(s) — ${pointer}` : pointer));
    }
    return {
      text: 'Groomed & gate-checked',
      blocks: [
        { type: 'section', text: mrkdwn('📋 Groomed & gate-checked') },
        ...sections.map((s) => ({ type: 'section', text: mrkdwn(s.text) })),
        { type: 'context', elements: contextElements },
        actionsBlock([
          { label: 'Create in Jira', actionId: 'create', value: plan.plan_id, style: 'primary' },
          { label: 'Reject', actionId: 'reject', value: plan.plan_id, style: 'danger' },
        ]),
      ],
    };
  };

  // FINAL MEASURE against Slack's serialized-blocks hard limit (see
  // MAX_BLOCKS_JSON). The per-section/per-count budgets above cannot prove
  // this one — JSON escaping inflates `"`/`\`/control-char-heavy content
  // 2–6× AFTER every char budget already held. Degrade deterministically:
  //   1. an over-budget RICH payload falls back to compact rendering first
  //      (compact carries strictly less text per item);
  //   2. then item sections are dropped whole from the END — header,
  //      context, and actions always survive — folding every dropped
  //      item into the honest "…and N more item(s)" context line and
  //      re-measuring after each drop.
  // The loop provably terminates: each iteration removes exactly one
  // section (sections.length strictly decreases, bounded by 47), and with
  // zero item sections the remaining payload is a small fixed skeleton.
  let msg = assemble();
  if (tier === 'rich' && JSON.stringify(msg.blocks).length > MAX_BLOCKS_JSON) {
    tier = 'compact';
    ({ sections, dropped } = packCompact());
    msg = assemble();
  }
  while (JSON.stringify(msg.blocks).length > MAX_BLOCKS_JSON && sections.length > 0) {
    dropped += sections.pop().itemCount;
    msg = assemble();
  }
  return msg;
}

// Order-insensitive set equality over dependency-id lists (duplicates
// collapse: {i1,i1} == {i1}) — used by renderPlanText to detect groom-vs-
// approved-shape drift on depends_on. Elements are String()-coerced so a
// type-confused id still compares by value, never throws.
function sameIdSet(a, b) {
  const setA = new Set(a.map((v) => String(v)));
  const setB = new Set(b.map((v) => String(v)));
  if (setA.size !== setB.size) return false;
  for (const v of setA) {
    if (!setB.has(v)) return false;
  }
  return true;
}

/**
 * The FULL, untruncated plan as one human-readable plain-text document —
 * uploaded in-thread at the create gate (slack.mjs) as the full-truth
 * vehicle when the message rendered compact, and the durable copy either
 * way. Pure and deterministic: plan order, no timestamps, no truncation
 * anywhere. Anything shortened in the Slack blocks is complete here.
 *
 * Deliberately NO mrkdwn escaping anywhere in this function: the output is
 * a raw .txt FILE, never blocks mrkdwn — entity-escaping here would corrupt
 * the one surface whose whole job is carrying the plan text verbatim.
 */
export function renderPlanText(plan) {
  const groomed = (plan && plan.plan) || {};
  // .filter(Boolean) on every array: a null/undefined element must be
  // dropped, never crash this builder or the skeleton/milestone Map builds.
  const items = Array.isArray(groomed.items) ? groomed.items.filter(Boolean) : [];
  const skeletonItems = (plan && plan.skeleton && Array.isArray(plan.skeleton.items)) ? plan.skeleton.items.filter(Boolean) : [];
  const skeletonByTempId = new Map(skeletonItems.map((i) => [i.temp_id, i]));
  const skeletonMilestones = (plan && plan.skeleton && Array.isArray(plan.skeleton.milestones)) ? plan.skeleton.milestones.filter(Boolean) : [];
  const milestoneNameById = new Map(skeletonMilestones.map((m) => [m.milestone_id, m.name]));
  const epic = groomed.epic || {};
  const sep = '='.repeat(78);
  const sub = '-'.repeat(78);

  const out = [];
  out.push('RADSVINN PLAN — FULL TICKET TEXT (read before Create)');
  out.push(`plan: ${(plan && plan.plan_id) || '(unknown)'}`);
  out.push('');
  // Attach mode rides the full-truth file too:
  // a set existing_key means NO epic is created — the tree parents under
  // that pre-existing board epic, and the reviewer must be able to check the
  // target key here as well as at the gates. Raw, unescaped: this is the
  // verbatim .txt surface (see the function doc).
  const attachKey = typeof epic.existing_key === 'string' && epic.existing_key.trim().length > 0
    ? epic.existing_key.trim()
    : null;
  out.push(`EPIC: ${orNone(epic.summary)}${attachKey ? ` (attaches to existing ${attachKey})` : ''}`);
  out.push(`Why: ${orNone(epic.why)}`);
  out.push('');

  items.forEach((item, idx) => {
    const view = groomedItemView(item, skeletonByTempId);
    const fields = item.fields || {};
    const relatedLinks = fields.related_links || {};
    // .filter(Boolean): a null element must not render as "  - null".
    const external = Array.isArray(relatedLinks.external) ? relatedLinks.external.filter(Boolean) : [];

    out.push(sep);
    out.push(`[${idx + 1}/${items.length}] ${view.type} ${item.temp_id || '?'} — ${view.summary}`);
    out.push(sub);
    // Structural link fields, so the approver can re-verify the tree's
    // SHAPE (what gate 1 approved) against the groomed content at the
    // create gate. depends_on renders from the GROOMED item — that is what
    // the create path actually WRITES (tools/create-tree.mjs selectScope
    // builds the Jira Blocks links from plan.items[].depends_on), so the
    // gate must show what will land on the board, not the skeleton's echo.
    // When the groomed deps drift from the approved shape's (order-
    // insensitive set inequality), a ⚠ divergence line names the shape's
    // version — that drift is exactly the signal this gate exists to show.
    // Milestone / repo lines render only when resolvable/present; parent
    // and depends_on always render (a missing link is exactly the kind of
    // absence the reviewer must see).
    const skeletonMatch = skeletonByTempId.get(item.temp_id);
    const dependsOn = Array.isArray(item.depends_on) ? item.depends_on : [];
    const shapeDependsOn = Array.isArray(skeletonMatch && skeletonMatch.depends_on) ? skeletonMatch.depends_on : [];
    out.push(`Parent: ${orNone(item.parent_temp_id)}`);
    out.push(`Depends on: ${dependsOn.length > 0 ? dependsOn.join(', ') : '(none)'}`);
    if (skeletonMatch && !sameIdSet(dependsOn, shapeDependsOn)) {
      out.push(`  ⚠ DIVERGES from approved shape (shape had: ${shapeDependsOn.length > 0 ? shapeDependsOn.join(', ') : '(none)'})`);
    }
    const milestoneName = skeletonMatch && milestoneNameById.get(skeletonMatch.milestone_id);
    if (milestoneName) out.push(`Milestone: ${milestoneName}`);
    if (item.repo) out.push(`Repo: ${item.repo}`);
    const technicalAnalysis = fields.technical_analysis || {};
    const affectedRepos = Array.isArray(technicalAnalysis.affected_repos) ? technicalAnalysis.affected_repos : [];
    if (affectedRepos.length > 0) out.push(`Affected repos: ${affectedRepos.join(', ')}`);
    out.push('');
    out.push('Why:');
    out.push(orNone(view.why));
    out.push('');
    out.push('Definition of done:');
    out.push(orNone(view.definitionOfDone));
    out.push('');
    out.push('Acceptance criteria:');
    if (view.acceptanceCriteria.length === 0) {
      out.push('  (none)');
    } else {
      view.acceptanceCriteria.forEach((ac, i) => out.push(`  ${i + 1}. ${ac}`));
    }
    out.push('');
    out.push('Technical analysis:');
    out.push(orNone(view.taProse));
    out.push('');
    out.push('Code anchors:');
    if (view.anchors.length === 0) {
      out.push('  (none)');
      // The full-truth file carries the same
      // zero-anchor flag as the gate message (see ZERO_ANCHOR_FLAG) — a
      // one-node plan stays exempt.
      if (items.length > 1) {
        out.push('  ⚠ 0 anchors — coupling-zone routing not machine-checkable; verify the touched code paths by hand');
      }
    } else {
      for (const anchor of view.anchors) out.push(`  - ${anchor}`);
    }
    out.push('');
    out.push('External links:');
    if (external.length === 0) {
      out.push('  (none)');
    } else {
      for (const link of external) out.push(`  - ${link}`);
    }
    out.push('');
    out.push(`Coupling zones: ${view.zones}`);
    out.push(`Effort: ${view.effort}`);
    out.push('');
  });

  out.push(sep);
  return out.join('\n');
}

/**
 * created — terminal success; one Jira browse link per created key, plus the
 * confirm-guarded Cancel tree undo — `created` is a real tree on the
 * live board, and this button is its only non-CLI recovery.
 */
export function createdMessage(plan) {
  const created = plan.created || {};
  const keys = Array.isArray(created.keys) ? created.keys : [];
  const keyLines = keys.map((key) => `<${JIRA_BROWSE_BASE}/${key}|${key}>`);
  const verifyIcon = created.verify_ok ? '✅' : '⚠️';
  // Attach mode at the terminal surface: the
  // created marker's attached_epic (lifted from the record by
  // runCreateWorker) names the pre-existing epic the tree was parented
  // under. It is deliberately NOT in keys/created[] (cleanup must never
  // sweep it), so without this line the attach target would be invisible
  // exactly where the human confirms what landed on the board — and a
  // hallucinated-but-valid key would pass both gates AND the confirmation
  // blind. Browse link so the target is one click away; escaped like every
  // plan-derived value (belt-and-braces — the create tool only accepts
  // jiraKeyRE-shaped keys, whose charset the escape leaves untouched).
  const attachedKey = created.attached_epic && typeof created.attached_epic.key === 'string' && created.attached_epic.key.trim().length > 0
    ? mrkdwnEscape(created.attached_epic.key.trim())
    : null;
  const attachedLine = attachedKey
    ? [`↷ attached under <${JIRA_BROWSE_BASE}/${attachedKey}|${attachedKey}> (pre-existing — cancel never touches it)`]
    : [];

  // Attribute the tree to whoever asked (plan.requester_id rides
  // toPublicView). Null for legacy plans → no block, spread away cleanly.
  const attribution = requesterAttributionLine(plan.requester_id);

  return {
    text: keys.length > 0 ? `Created: ${keys.join(', ')}` : 'Created',
    blocks: [
      {
        type: 'section',
        text: mrkdwn(['🎫 Created:', ...keyLines, ...attachedLine, `verify: ${verifyIcon}`].join('\n')),
      },
      ...(attribution ? [attribution] : []),
      actionsBlock([cancelTreeButton(plan.plan_id)]),
    ],
  };
}

/** failed / budget_blocked / rejected — terminal non-success. */
/**
 * The instant acknowledgement posted the moment a wizard submission starts a
 * plan — so the user never faces a blank channel while the agent works
 * (decomposition is a real ~1–2 min call). The poller later `chat.update`s
 * THIS message in place into the actual shape, so one message evolves:
 * "Preparing…" → the tree + Approve buttons.
 */
export function preparingMessage({ description, outputLanguage, requesterId }) {
  const langNote =
    outputLanguage === 'tr' ? ' · dil: Türkçe'
      : outputLanguage === 'both' ? ' · language: English + Türkçe'
        : '';
  // The description is the raw ask (untrusted) and lands in section mrkdwn
  // — escaped before the 140 cut, same discipline as the gate surfaces.
  const desc = truncate(mrkdwnEscape(String(description || '').trim()), 140);
  // Attribute the in-flight plan. This is a non-gate surface, so it gets
  // the attribution line now (the two gate builders use header mentions; see
  // requesterAttributionLine). Null → no block for a legacy/absent id.
  const attribution = requesterAttributionLine(requesterId);
  return {
    text: '🛠️ Preparing your plan…',
    blocks: [
      { type: 'section', text: mrkdwn(`🛠️ *Preparing your plan…*\n_${desc}_`) },
      { type: 'context', elements: [mrkdwn(`Reading the codebase to ground the breakdown — this takes a minute${langNote}.`)] },
      ...(attribution ? [attribution] : []),
    ],
  };
}

export function terminalMessage(plan) {
  const label = statusLabel(plan.status);
  const lines = [`⚠️ ${label}`];
  // plan.error IS mrkdwn-escaped: engine failure strings embed agent-
  // influenced stdout/stderr tails, so this surface carries untrusted text
  // just like the gate surfaces do — unescaped, a smuggled `<!channel>`
  // mass-pings and a `<http://evil|innocent>` forges a link at the FAILURE
  // surface. Escaping costs nothing here: the load-bearing verbatim parts
  // (the re-click guidance and the runnable `--cleanup` command) contain no
  // & < >, so they survive byte-identical, and escaping runs BEFORE the
  // 500-char truncation so the budget is measured on what is actually sent
  // (same escape-before-truncate discipline as every other surface).
  if (plan.error) lines.push(truncate(mrkdwnEscape(plan.error), 500));

  const blocks = [{ type: 'section', text: mrkdwn(lines.join('\n')) }];
  // A transient failure (API balance, network) is recoverable — offer a
  // one-click Retry that resumes from the last completed phase. Not offered
  // for `rejected` (a human decision, not a failure) or `created` (success).
  if (plan.status === 'failed' || plan.status === 'budget_blocked') {
    const buttons = [{ label: '🔄 Retry', actionId: 'retry', value: plan.plan_id, style: 'primary' }];
    // A failed plan WITH a created record means real Jira writes already
    // happened (a surfaced partial tree, a red post-create verify, or a
    // failed cancel) — offer Cancel tree next to Retry so the undo lives on
    // the product surface instead of dead-ending at the error text's CLI
    // command. `failed` only: budget_blocked is a pre-call block and never
    // carries a fresh created record.
    if (plan.status === 'failed' && plan.created && plan.created.record_path) {
      buttons.push(cancelTreeButton(plan.plan_id));
    }
    blocks.push(actionsBlock(buttons));
  }

  return {
    // The notification fallback `text` is mrkdwn-parsed too — same escape,
    // and the same 500 cut as the section body (an unbounded engine error
    // tail must not ride the fallback past the budgets the blocks hold).
    text: plan.error ? `${label}: ${truncate(mrkdwnEscape(plan.error), 500)}` : label,
    blocks,
  };
}

/**
 * cancelled — terminal success-of-cancel. One browse link per key the
 * cancel swept, and an honesty line claiming only what cleanup's exit 0
 * proves: the sweep ran with no hard failures, nothing was deleted, and a
 * ticket already in a terminal state is skipped — per-ticket results live
 * in the plan's agent_summary (GET /plan). No action buttons: cancelled is
 * final on the product surface.
 */
export function cancelledMessage(plan) {
  const created = plan.created || {};
  const keys = Array.isArray(created.keys) ? created.keys : [];
  const keyLines = keys.map((key) => `<${JIRA_BROWSE_BASE}/${key}|${key}>`);

  return {
    text: keys.length > 0 ? `Tree cancelled: ${keys.join(', ')}` : 'Tree cancelled',
    blocks: [
      { type: 'section', text: mrkdwn(['🚫 Tree cancelled:', ...keyLines].join('\n')) },
      {
        type: 'context',
        elements: [mrkdwn('cleanup sweep completed with no hard failures — nothing was deleted. A ticket already in a terminal state is skipped; per-ticket results are in the plan (GET /plan).')],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildPlanWizardView — the `/plan` modal (language + scope + description)
// ---------------------------------------------------------------------------

function radioOption(text, value) {
  return { text: { type: 'plain_text', text }, value };
}

/**
 * The Slack modal opened by `/plan`. `private_metadata` carries the slash
 * command's channel + requester through to the view_submission (a modal has
 * no channel of its own). `prefillText` seeds the description when the user
 * typed `/plan <text>` — the wizard still opens so the language and scope
 * choices are always explicit.
 *
 * `requesterId` is the stable Slack user id (payload.user_id), threaded
 * as `requester_id` PARALLEL to the display-name `requester`. Only the id
 * renders as a real @-mention downstream ("asked by <@id>" and gate
 * mentions); the display-name `requester` still feeds the planner prompt and
 * is left untouched. Absent → JSON.stringify simply drops the key, so a
 * legacy caller's metadata shape is unchanged.
 */
export function buildPlanWizardView({ channel, requester, requesterId, prefillText }) {
  const descElement = {
    type: 'plain_text_input',
    action_id: 'description',
    multiline: true,
    placeholder: { type: 'plain_text', text: 'Describe the work in plain language (English or Turkish)…' },
  };
  const pf = String(prefillText || '').trim();
  if (pf) descElement.initial_value = truncate(pf, 2900); // Slack input cap ~3000

  return {
    type: 'modal',
    callback_id: 'plan_wizard',
    title: { type: 'plain_text', text: 'Plan with Radsvinn' },
    submit: { type: 'plain_text', text: 'Plan it' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ channel, requester, requester_id: requesterId }),
    blocks: [
      {
        type: 'input',
        block_id: 'lang',
        label: { type: 'plain_text', text: 'Output language' },
        // radio_buttons, NOT static_select: radios keep the selection visible
        // (no closed dropdown hiding the state), and their documented
        // view-state shape is identical to static_select's
        // (`selected_option.value` — see handleViewSubmission in slack.mjs),
        // so the defensive extraction covers both shapes.
        // The "English + Türkçe" (`both`) option is deliberately absent from
        // the UI.
        // `both` stays VALID at the API layer (server.mjs
        // VALID_OUTPUT_LANGUAGE) so direct API callers don't break.
        element: {
          type: 'radio_buttons',
          action_id: 'output_language',
          initial_option: radioOption('English', 'en'),
          options: [radioOption('English', 'en'), radioOption('Türkçe', 'tr')],
        },
      },
      {
        type: 'input',
        block_id: 'scope',
        label: { type: 'plain_text', text: 'How big is this?' },
        // The scope control prevents the decomposer from inflating simple
        // asks into Epics, and the requester — not the agent
        // — owns the epic-ization decision. The chosen value rides POST
        // /plan as `scope_hint` and becomes a HARD `# SCOPE` directive in
        // the decomposer's phase-1 message (engine.mjs phase1Message);
        // `auto` injects nothing and leaves the prompt's own rules standing.
        element: {
          type: 'radio_buttons',
          action_id: 'scope_hint',
          initial_option: radioOption('Let Radsvinn judge (default)', 'auto'),
          options: [
            radioOption('Let Radsvinn judge (default)', 'auto'),
            radioOption('One ticket — no epic, no breakdown', 'single'),
            radioOption('A few tickets (2-5) — no epic', 'small'),
            radioOption('Large — full epic breakdown', 'epic'),
          ],
        },
      },
      {
        type: 'input',
        block_id: 'grounding',
        label: { type: 'plain_text', text: 'Code grounding' },
        // The grounding-depth control (2026-07-11 — the repo-reading-tax
        // fix): the requester's opt-in way to say "this task doesn't need
        // deep code grounding". Sits BELOW scope so the wizard reads
        // top-to-bottom simple→specific (language, size, depth, then the
        // ask). `full` is the initial option and MUST stay so:
        // under-grounding a task that needed it silently degrades ticket
        // quality — Light is opt-in, never the silent default. The value
        // rides POST /plan as `grounding_hint`; `light` adds `# GROUNDING`
        // directives plus a flat Phase-1 turn cap and a plan-size-scaled
        // Groom turn cap (engine.mjs); `full` changes nothing.
        element: {
          type: 'radio_buttons',
          action_id: 'grounding_hint',
          initial_option: radioOption('Full — read the code (default)', 'full'),
          options: [
            radioOption('Full — read the code (default)', 'full'),
            radioOption('Light — skip deep code reading (faster/cheaper; for simple asks)', 'light'),
          ],
        },
      },
      {
        type: 'input',
        block_id: 'desc',
        label: { type: 'plain_text', text: 'What should we build?' },
        element: descElement,
      },
    ],
  };
}

/**
 * The immediate 3-second-rule ack payload for a slash command
 * (`accepts_response_payload` envelopes only — see slack.mjs's dispatcher).
 * `text` defaults to the standard "planning" ack; callers pass an override
 * for the empty-input usage hint.
 */
export function ackPayload(text = DEFAULT_ACK_TEXT) {
  return { response_type: 'ephemeral', text };
}

/**
 * Pure block-list transform used once a button click resolves: drops any
 * `actions` block (the buttons that were just acted on) and appends a
 * `context` line recording the outcome, keeping every other block (the
 * skeleton tree / groomed items / gate line) exactly as posted.
 */
export function replaceActionsWithContext(blocks, contextText) {
  const kept = (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.type !== 'actions');
  kept.push({ type: 'context', elements: [mrkdwn(contextText)] });
  return { blocks: kept };
}
