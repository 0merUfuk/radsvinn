// server.mjs — the POST /plan planner service HTTP API.
//
// Boot: `node service/server.mjs` (see service/README.md for the full env
// table and a curl walkthrough). `createServer()` is also importable
// directly for tests — it takes the same env-driven defaults but lets a
// caller override `engine`/`state`/`token` for isolation.
//
// State machine (single source of truth — every transition funnels through
// here):
//   breaking_down -> shape_ready -> grooming -> plan_ready -> creating -> created
//   shape_ready | plan_ready     -> rejected                 (POST .../reject)
//   any in-flight status        -> failed                    (async error)
//   any pre-call check          -> budget_blocked (terminal)  (breakers.mjs)
//   failed | budget_blocked -> breaking_down | grooming | creating   (POST .../retry)
//     — GUARDED twice: a plan that already holds a created record (fully or
//     partially written) re-enters `creating` for a VERIFY-ONLY recovery and
//     is never re-created (see handleRetry — the retry write guard); and
//     the resume ladder only advances past a phase whose deterministic gate
//     actually PASSED — a gate-failed artifact re-runs its phase (re-gating),
//     never rides into create (the gate-checked resume ladder).
//   created | failed(with created record) -> cancelling -> cancelled | failed
//     — the cancel flow Slack undo (POST .../cancel): control-plane --cleanup sweep,
//     cancel-only, never delete (see handleCancel / runCancelWorker).
// Any request that doesn't match a legal transition gets 409 {error, status}.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { State, resultsDir, agentRunDir, MERCURY_ROOT } from './state.mjs';
import { createEngine, CREATED_RECORD_FILENAME } from './engine.mjs';
import { gateSkeleton, gatePlan } from './gates.mjs';
import { fetchGroundingRepos } from './grounding.mjs';
import * as breakers from './breakers.mjs';
import { appendAudit, readAudit, AuditCursorError } from './audit.mjs';

const SERVICE_VERSION = '0.1.0';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLE_LENS = new Set(['business', 'tech']);
// `both` stays valid here even though the Slack wizard no longer offers it
// (rebuilt 2026-07-10 — the "English + Türkçe" option confused users):
// direct API callers may still send it and the prompts still honor it.
// Dropping it from the UI is a product decision; dropping it from the API
// would be a breaking one.
const VALID_OUTPUT_LANGUAGE = new Set(['en', 'tr', 'both']);
// scope_hint carries the requester's own sizing
// decision — the epic-overwork fix. `auto` (default) lets the decomposer
// judge; anything else becomes a HARD `# SCOPE` directive in the phase-1
// message (engine.mjs phase1Message) that OVERRIDES the agent's own size
// judgment. Persisted on the plan and surfaced via toPublicView so the
// Slack shape gate can show the approver what was requested.
const VALID_SCOPE_HINT = new Set(['auto', 'single', 'small', 'epic']);
// grounding_hint (2026-07-11): the requester's opt-in grounding-depth
// decision — the repo-reading-tax fix. `full` (default) changes nothing;
// `light` injects a `# GROUNDING` directive into the phase-1 message and
// caps the decompose call's agentic loop (engine.mjs). The default MUST
// stay `full`: under-grounding a task that needed it silently degrades
// ticket quality (the asymmetric failure mode), so Light is always opt-in.
// Persisted on the plan and surfaced via toPublicView so the Slack shape
// gate can show the approver the plan was shallow-grounded.
const VALID_GROUNDING_HINT = new Set(['full', 'light']);
const REJECTABLE_STATUSES = new Set(['shape_ready', 'plan_ready']);
// Surface persistence uses the FULL status vocabulary, used only
// to validate a client-reported `announced_status` delivery cursor. It
// deliberately includes the transient statuses and `cancelling`/`cancelled`:
// the cursor records the last status a surface client successfully announced
// to its humans, and a client may legitimately have announced any status the
// machine can hold (the Slack bridge, for one, plants a `breaking_down`
// cursor the moment its "Preparing…" placeholder posts).
const VALID_STATUSES = new Set([
  'breaking_down', 'shape_ready', 'grooming', 'plan_ready', 'creating',
  'created', 'rejected', 'failed', 'budget_blocked', 'cancelling', 'cancelled',
]);
// The opaque `surface` descriptor's serialized-size cap: it is a reply-to
// ADDRESS (a type tag + channel + message ts), never a payload channel — a
// kilobyte is generous for any address shape and starves abuse.
const MAX_SURFACE_BYTES = 1024;
// `budget_blocked` is retryable: the daily cap is a routine
// transient (resets at UTC midnight, or the cap is raised), and the Slack
// Retry button was already live on budget_blocked while the handler 409'd
// (a button that lied). Safe because every worker re-checks both breakers
// on entry: a still-capped retry re-blocks cleanly, and budget_blocked
// always trips BEFORE any Jira write, so it composes with the retry write guard.
const RETRYABLE_STATUSES = new Set(['failed', 'budget_blocked']);
// dashboard actor contract (§5.2): the BFF-asserted attribution object
// accepted as a body field on all six mutating routes. `source` is the
// one field the audit ledger's `client` is NEVER derived from (client
// comes from which bearer authenticated, §5.1) — `source` is BFF-asserted
// like the rest of the object, kept for readability/cross-checking.
const VALID_ACTOR_SOURCE = new Set(['slack', 'dashboard', 'api']);
// Generous enough for a display name + a handful of role strings, small
// enough that an actor object can never become a payload channel.
const MAX_ACTOR_BYTES = 1024;
// `actor.id` is scheme-prefixed
// (`gh:<login>`, later `slack:U…`) — enforced here as a general
// "<scheme>:<rest>" shape rather than a hardcoded enum of scheme names,
// since a `source:'api'` caller has no scheme spelled out anywhere in the
// design and guessing one would be presumptuous. This still catches the
// reported gap: a bare id with no scheme at all (e.g. `just-a-name`) is no
// longer accepted.
const ACTOR_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*:\S+$/;

// B1: the bounded-regeneration ceiling. A gate-failed planning artifact is
// re-generated against the DETERMINISTIC gate's own complaint (never an LLM
// judge) at most this many times before the plan surfaces as
// `failed` for a human. Bounds BOTH the internal auto-loop and a manual Retry:
// the count is persisted per phase (regen_counts.{phase1,groom}), so a Retry
// after exhaustion reads N and does exactly ONE more call, never a fresh 2×
// loop. Each regen is a real planning-call spend, so this is the cost ceiling
// too — it composes with the per-plan budget cap (checked inside the loop).
const MAX_REGEN_ATTEMPTS = 2;

function nowIso() {
  return new Date().toISOString();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

const NANODOLLARS_PER_USD = 1_000_000_000;

// `cost_usd` is kept as a backwards-compatible display field.  Every breaker
// decision uses this integer representation instead: a $0.000000001 charge
// is still one unit of spend and cannot disappear in a display-cent round.
function usdToNanosForServer(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('invalid planning cost telemetry');
  }
  const nanos = Math.round(value * NANODOLLARS_PER_USD);
  if (!Number.isSafeInteger(nanos) || nanos < 0) throw new Error('planning cost telemetry overflow');
  return nanos;
}

function planCostNanos(plan) {
  if (Object.hasOwn(plan, 'cost_nanos')) {
    if (!Number.isSafeInteger(plan.cost_nanos) || plan.cost_nanos < 0) throw new Error('invalid persisted planning cost telemetry');
    return plan.cost_nanos;
  }
  return usdToNanosForServer(plan.cost_usd === undefined ? 0 : plan.cost_usd);
}

function resultCostNanos(result) {
  if (Object.hasOwn(result, 'costNanos')) {
    if (!Number.isSafeInteger(result.costNanos) || result.costNanos < 0) throw new Error('invalid provider-authoritative cost telemetry');
    return result.costNanos;
  }
  // A runtime that cannot report cost (e.g. Codex) returns costUsd: undefined
  // with costTelemetryStatus: 'unavailable'. Treat undefined as 0 nanos —
  // the same guard planCostNanos uses. The plan still runs; the daily breaker
  // cannot count it (a known, documented degradation, not a silent zero).
  return usdToNanosForServer(result.costUsd === undefined ? 0 : result.costUsd);
}

function displayUsd(costNanos) {
  return round2(costNanos / NANODOLLARS_PER_USD);
}

function publicWorkerError(err) {
  if (err && err.code === 'COST_TELEMETRY_UNAVAILABLE') {
    return 'planning cost telemetry is unavailable; no further LLM work will run until an operator investigates';
  }
  if (err && err.code === 'METERED_PHASE_FAILED') return 'the planning phase failed after its provider-authoritative spend was recorded';
  return errMsg(err);
}

function errMsg(err) {
  const msg = err && err.message ? err.message : String(err);
  // Don't leak absolute server paths to API clients.
  return msg.split(MERCURY_ROOT).join('.');
}

// Phase-timing observability (2026-07-11): one structured stderr line per
// completed planning call, so the next speed/cost decision is evidence-based
// instead of guessed — before this, NOTHING recorded how long a phase took
// or how many agent turns it used. Loud to stderr = Railway captures it
// (this service's house logging channel; see the Slack bridge's log
// discipline). Fields: the phase, the plan's 8-char id prefix, the ACTUAL
// resolved model (the engine reports what it ran — never re-derived here),
// the plan's grounding depth, the agentic-loop turn count, wall duration,
// and cost. A field the engine didn't report prints `?` — never fabricated.
function logPhaseTiming(phase, plan, result) {
  const id8 = String(plan.plan_id || '').slice(0, 8);
  console.error(
    `[mercury] phase=${phase} plan=${id8} model=${result.model ?? '?'} grounding=${plan.grounding_hint || 'full'} turns=${result.numTurns ?? '?'} duration_ms=${result.durationMs ?? '?'} cost_usd=${typeof result.costUsd === 'number' ? result.costUsd : '?'}`,
  );
}

// Constant-time bearer comparison (timing side-channel hygiene).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// §5.1: per-client bearer classification. `token` absent/empty means auth
// is DISABLED ENTIRELY (today's dev-mode behavior, byte-identical to
// before the API extension) — every request is authorized and tagged `client: 'api'`,
// regardless of whether a dashboard token happens to be configured.
// Otherwise a request must match exactly one of the two tokens: the
// primary (legacy) token tags `client: 'slack'`, the dashboard token (only
// when configured — see the blank/whitespace handling in createServer)
// tags `client: 'dashboard'`. Anything else is unauthorized.
function classifyClient(header, token, dashboardToken) {
  if (!token) return { authorized: true, client: 'api' };
  const bearer = header || '';
  if (safeEqual(bearer, `Bearer ${token}`)) return { authorized: true, client: 'slack' };
  if (dashboardToken && safeEqual(bearer, `Bearer ${dashboardToken}`)) return { authorized: true, client: 'dashboard' };
  return { authorized: false, client: undefined };
}

// §5.2: validates the BFF-asserted `actor` object accepted on all six
// mutating routes. `required` is true only for dashboard-token mutations
// (a lazily-compromised BFF cannot mint anonymous mutations); bridge/api
// callers may omit it (recorded as `actor: null` in the audit ledger).
// Returns `{ error }` on any malformed shape, or `{ actor }` — `actor` is
// `null` when omitted-and-optional, otherwise a normalized copy carrying
// only the recognized fields (never a raw pass-through of caller JSON).
function validateActor(rawActor, { required }) {
  if (rawActor === undefined || rawActor === null) {
    if (required) return { error: 'actor is required for this client' };
    return { actor: null };
  }
  if (typeof rawActor !== 'object' || Array.isArray(rawActor)) {
    return { error: 'actor must be a JSON object' };
  }
  let serializedBytes;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(rawActor), 'utf8');
  } catch {
    return { error: 'actor must be JSON-serializable' };
  }
  if (serializedBytes > MAX_ACTOR_BYTES) {
    return { error: `actor must serialize to <= ${MAX_ACTOR_BYTES} bytes` };
  }
  if (typeof rawActor.source !== 'string' || !VALID_ACTOR_SOURCE.has(rawActor.source)) {
    return { error: "actor.source must be one of 'slack' | 'dashboard' | 'api'" };
  }
  if (typeof rawActor.id !== 'string' || rawActor.id.length === 0 || rawActor.id.length > 128 || !ACTOR_ID_RE.test(rawActor.id)) {
    return { error: 'actor.id must be a non-empty, scheme-prefixed string (e.g. "gh:<login>") <= 128 characters' };
  }
  if (rawActor.github_id !== undefined && rawActor.github_id !== null && !Number.isInteger(rawActor.github_id)) {
    return { error: 'actor.github_id must be an integer when provided' };
  }
  if (rawActor.display !== undefined && rawActor.display !== null
    && (typeof rawActor.display !== 'string' || rawActor.display.length > 256)) {
    return { error: 'actor.display must be a string <= 256 characters when provided' };
  }
  if (rawActor.roles !== undefined && rawActor.roles !== null
    && (!Array.isArray(rawActor.roles) || !rawActor.roles.every((r) => typeof r === 'string'))) {
    return { error: 'actor.roles must be an array of strings when provided' };
  }

  const actor = { source: rawActor.source, id: rawActor.id };
  if (rawActor.github_id !== undefined && rawActor.github_id !== null) actor.github_id = rawActor.github_id;
  if (rawActor.display !== undefined && rawActor.display !== null) actor.display = rawActor.display;
  if (rawActor.roles !== undefined && rawActor.roles !== null) actor.roles = rawActor.roles;
  return { actor };
}

// §5.1/§3.3 layer 4, planner-side re-verification: dashboard-token create
// and cancel additionally require the named, plan-scoped confirm string —
// so no single BFF forwarding bug (as opposed to a fully scripted
// compromise, R1) can turn into a Jira write. Only ever called when
// `client === 'dashboard'`; bridge-token behavior is untouched by design.
function confirmError(body, action, planId) {
  const id8 = String(planId).slice(0, 8);
  const expected = `${action}-jira-tree ${id8}`;
  const provided = typeof body.confirm === 'string' ? body.confirm : '';
  return provided === expected ? undefined : `confirm must equal '${expected}'`;
}

// §6.2 GET /plans keyset cursor: opaque base64url of "<updated_at>
// <plan_id>" — the plan_id tiebreaker gives the (updated_at desc, plan_id
// desc) sort a total order, which today's single-key sort lacks. Node's
// base64url decode is lenient (never throws on garbage), so strictness
// comes from the shape check below, not the decode step.
function encodePlansCursor(updatedAt, planId) {
  return Buffer.from(`${updatedAt} ${planId}`, 'utf8').toString('base64url');
}

function decodePlansCursor(raw) {
  const decoded = Buffer.from(String(raw), 'base64url').toString('utf8');
  const idx = decoded.indexOf(' ');
  if (idx <= 0) return undefined;
  const updatedAt = decoded.slice(0, idx);
  const planId = decoded.slice(idx + 1);
  if (!updatedAt || !UUID_RE.test(planId)) return undefined;
  return { updatedAt, planId };
}

// Sort key for GET /plans: (updated_at desc, plan_id desc) — the
// plan_id tiebreak is new in this PR (§6.2); today's single-key sort had
// no total order for colliding updated_at values.
function comparePlansDesc(a, b) {
  const byUpdated = String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  if (byUpdated !== 0) return byUpdated;
  return String(b.plan_id || '').localeCompare(String(a.plan_id || ''));
}

// True when `plan` sorts strictly AFTER `cursor` in the (updated_at desc,
// plan_id desc) order — i.e. belongs on the NEXT page.
function isAfterPlansCursor(plan, cursor) {
  const updatedAt = String(plan.updated_at || '');
  const planId = String(plan.plan_id || '');
  const byUpdated = updatedAt.localeCompare(cursor.updatedAt);
  if (byUpdated !== 0) return byUpdated < 0;
  return planId.localeCompare(cursor.planId) < 0;
}

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function gateSummary(gate) {
  if (gate.skipped) {
    return 'skipped (fake-mode MERCURY_SKIP_PLAN_ANCHORS=1; entire plan gate not run)';
  }
  try {
    return JSON.stringify(gate.raw).slice(0, 500);
  } catch {
    return String(gate.raw).slice(0, 500);
  }
}

// B1: derives the checker/contract COMPLAINT text from a FAILED gate, branching
// on treecheck's two Verdict shapes (cmd/treecheck/main.go):
//   - plan mode emits {items:{<temp_id>:Verdict}, ok} — join every NON-ok
//     item's regen_complaint;
//   - skeleton mode (and the collapsed contract-block for EITHER mode, which
//     ContractFailVerdict renders as a single bare Verdict) emits a lone
//     Verdict — take its regen_complaint.
// Returns undefined when there is nothing actionable to fix — a spawn error
// ({spawnError}), an unparsed stdout, or an empty complaint set — so the worker
// short-circuits instead of burning a regen call on an EMPTY complaint block
// (branching on the shape is load-bearing: a plan-mode gate read as a bare
// Verdict would silently yield undefined and waste the whole regen budget).
export function buildCheckerComplaintsBlock(gate) {
  const raw = gate && gate.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
    const parts = [];
    for (const id of Object.keys(raw.items)) {
      const v = raw.items[id];
      if (v && v.ok === false && typeof v.regen_complaint === 'string' && v.regen_complaint.trim().length > 0) {
        parts.push(v.regen_complaint.trim());
      }
    }
    const joined = parts.join('\n');
    return joined.length > 0 ? joined : undefined;
  }
  const complaint = typeof raw.regen_complaint === 'string' ? raw.regen_complaint.trim() : '';
  return complaint.length > 0 ? complaint : undefined;
}

// The FIRST genuinely-failing check's first complaint, across both Verdict
// shapes. Deliberately skips PASSING checks that carry a non-blocking WARN
// complaint (CheckResult allows "a passing check may still carry a complaint"):
// the actionable-first display must surface a real BLOCKER, not a warning that
// happens to sort first. Go marshals the `checks` map with alphabetically
// sorted keys, so `anchor_consistency`'s WARN sorts ahead of a real hard fail
// in the raw dump — this is exactly the diagnostic that must not push the real
// complaint out of Slack's 500-char window (gate-correctness review). It ALSO
// skips WARN complaints WITHIN a failing check: a failing check can carry a
// leading advisory warning ahead of its actual structural blocker. Surfacing
// that WARN would read as "failed a required check: WARN: … (advisory)", so
// the first NON-WARN complaint is the one to lead with.
function firstFailingComplaintFromChecks(checks) {
  if (!checks || typeof checks !== 'object') return undefined;
  for (const name of Object.keys(checks)) {
    const c = checks[name];
    if (c && c.pass === false && Array.isArray(c.complaints)) {
      const hard = c.complaints.find((x) => typeof x === 'string' && !x.startsWith('WARN:'));
      if (hard) return hard;
    }
  }
  return undefined;
}

export function firstFailingComplaint(gate) {
  try {
    const raw = gate && gate.raw;
    if (!raw || typeof raw !== 'object') return undefined;
    if (raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)) {
      for (const id of Object.keys(raw.items)) {
        const v = raw.items[id];
        if (v && v.ok === false) {
          const c = firstFailingComplaintFromChecks(v.checks);
          if (c) return c;
        }
      }
      return undefined;
    }
    return firstFailingComplaintFromChecks(raw.checks);
  } catch {
    return undefined;
  }
}

// Keeps an embedded complaint short enough that the human sentence it leads
// still fits inside Slack's 500-char error truncation ahead of the demoted raw.
function clampReason(reason) {
  const s = String(reason || '').trim();
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

// Translates a skeleton-gate failure into an ACTIONABLE human sentence — the
// user-facing surface, and ONLY the sentence (2026-07-13 clean-errors: the raw
// gate JSON is for operators/logs, never Slack). The full gate is already
// persisted on plan.skeleton_gate (surfaced by toPublicView / GET /plan) AND
// console.error'd here at the failure site, so operators keep it without the
// user ever seeing a JSON blob. Covers EVERY failure class (2026-07-13: a live
// `haiku` decompose emitted `id` instead of `temp_id`, a contract hard-fail,
// and the owner saw only a raw JSON blob). The sizing×scope branch that once
// lived here is GONE: with the leaf-cost cap demoted to an advisory WARN
// (never a hard fail), a sizing_sane:false verdict can now ONLY mean a
// safety violation (depth/unknown repo), which falls
// through to the generic firstFailingComplaint path — surfacing the ACTUAL
// complaint instead of the old, now-wrong "oversized ticket" copy.
export function describeSkeletonGateFailure(gate, plan) { // eslint-disable-line no-unused-vars -- plan kept for call-site/signature symmetry with the old sizing×scope branch
  // Operators/logs only — never returned to the user surface.
  console.error(`[mercury] skeleton gate failed (server-side re-verification): ${gateSummary(gate)}`);
  try {
    // Contract hard-fail (malformed JSON, wrong/unknown keys, missing required
    // fields) — the class the owner hit. treecheck collapses it to a single
    // contract_valid:false check on a bare Verdict.
    const contractFailed = gate && gate.raw && gate.raw.checks
      && gate.raw.checks.contract_valid && gate.raw.checks.contract_valid.pass === false;
    if (contractFailed) {
      const reason = firstFailingComplaint(gate) || 'the draft did not match the required ticket skeleton';
      return `Mercury's draft didn't match the required ticket shape (a contract error: ${clampReason(reason)}). Retry re-plans from scratch.`;
    }

    // Any other structural hard fail (acyclic, hierarchy, ordering, a sizing
    // safety violation, …): lead with the FIRST failing check's complaint.
    const first = firstFailingComplaint(gate);
    if (first) {
      return `Mercury's draft failed a required structural check: ${clampReason(first)}. Retry re-plans from scratch.`;
    }
    return 'Mercury\'s draft failed server-side re-verification. Retry re-plans from scratch.';
  } catch {
    return 'Mercury\'s draft failed server-side re-verification. Retry re-plans from scratch.';
  }
}

// The plan-gate analogue (server.mjs plan-gate failure path). Same clean-errors
// discipline: return ONLY the human sentence (the raw gate is persisted on
// plan.plan_gate and console.error'd here, never shown to the user).
// firstFailingComplaint surfaces a genuine hard-fail complaint, skipping any
// co-occurring non-blocking WARN (the anchor_consistency alphabetical-ordering
// diagnostic). Shares the helper with describeSkeletonGateFailure — one
// surfacing rule, both gates.
export function describePlanGateFailure(gate) {
  // Operators/logs only — never returned to the user surface.
  console.error(`[mercury] plan gate failed (server-side re-verification): ${gateSummary(gate)}`);
  try {
    const first = firstFailingComplaint(gate);
    if (!first) return 'A ticket failed server-side re-verification. Retry re-plans from scratch.';
    return `A ticket failed a required check: ${clampReason(first)}. Retry re-plans from scratch.`;
  } catch {
    return 'A ticket failed server-side re-verification. Retry re-plans from scratch.';
  }
}

// First ~6 significant words of the dup-search seed — Unicode-letter aware
// The old `[^A-Za-z0-9 ]` strip
// mangled every non-ASCII language — a live Turkish ask's JQL rendered
// `summary ~ "taski zel bir teri istedi task"` ("özel"→"zel", "müşteri"→
// "teri") and the search missed a near-identical epic already on the board.
// \p{L}\p{N} keeps letters/digits in every script; the ~6-significant-words
// shape is unchanged. Consumer: runGroomWorker → create-tree.mjs --search,
// whose own escaping is Unicode-clean (strips control chars, escapes
// backslash/quote — letters pass through; see its runSearch note).
// Module-scope + exported as the unit-test seam (search-terms.test.mjs).
export function searchTerms(description) {
  return String(description || '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 6)
    .join(' ')
    .trim() || 'plan';
}

// Validates a client-supplied `surface` descriptor. The value
// is OPAQUE to this service — stored verbatim, never interpreted (the service
// stays surface-agnostic per API surface contract: only the writing client knows what
// `{type:'slack', channel, message_ts}` — or a future dashboard shape —
// means). Validation is therefore purely structural: a plain JSON object,
// small enough to be an address rather than a payload. Returns an error
// string, or undefined when valid.
function surfaceError(surface) {
  if (typeof surface !== 'object' || surface === null || Array.isArray(surface)) {
    return 'surface must be a plain JSON object';
  }
  if (Buffer.byteLength(JSON.stringify(surface), 'utf8') > MAX_SURFACE_BYTES) {
    return `surface must serialize to <= ${MAX_SURFACE_BYTES} bytes`;
  }
  return undefined;
}

function toPublicView(plan) {
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    // dashboard read-model (§6.1): the full ask text and the human who
    // asked — both persisted since v1 create, never surfaced by this view
    // until now. `description` is intentionally the FULL (<= 8000 char)
    // text, unlike GET /plans's 80-char list truncation.
    description: plan.description,
    requester: plan.requester,
    // C0 (UX foundation): the stable Slack user id for @-mention attribution
    // (drives C4's "asked by <@id>" and, later, C6's gate mentions / the
    // dashboard). Absent on legacy plans (JSON drops undefined).
    requester_id: plan.requester_id,
    // §6.1: business/tech, persisted at create — the dashboard's detail
    // header renders it.
    role_lens: plan.role_lens,
    cost_usd: plan.cost_usd || 0,
    skeleton: plan.skeleton,
    skeleton_gate: plan.skeleton_gate,
    output_language: plan.output_language,
    scope_hint: plan.scope_hint,
    grounding_hint: plan.grounding_hint,
    plan: plan.plan,
    plan_gate: plan.plan_gate,
    // B1: the per-phase bounded-regeneration counts ({phase1?, groom?}) — how
    // many times a gate-failed artifact was re-generated against the
    // deterministic gate's complaint. Absent on legacy plans / plans that
    // never regenerated (JSON drops undefined).
    regen_counts: plan.regen_counts,
    duplicate_search: plan.duplicate_search,
    agent_summary: plan.agent_summary,
    created: plan.created,
    error: plan.error,
    // §6.1: nullable/absent unless the plan was rejected — the inline
    // reason (and which stage rejected it) must be readable at the detail
    // view, not decorative-only inside the audit ledger.
    reject_reason: plan.reject_reason,
    reject_stage: plan.reject_stage,
    // Client-owned surface persistence — the opaque reply-to
    // descriptor plus the delivery cursor (last status the surface client
    // successfully announced). Absent on legacy plans (JSON drops undefined).
    surface: plan.surface,
    announced_status: plan.announced_status,
    // fetch-before-plan: the fetch-before-plan result ({ok, detail?}) — absent when
    // MERCURY_FETCH_BEFORE_PLAN is off or on legacy plans. Surfaces the
    // stale-anchors degradation at every client.
    grounding: plan.grounding,
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!rejected) {
          rejected = true;
          // Stop consuming (backpressure halts the sender) instead of
          // draining a potentially never-ending body; the handler sends the
          // 413 and THEN tears the connection down (see readJsonBody) so
          // the client can still read the status.
          req.pause();
          reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (rejected) return;
      rejected = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Route matching (pure function — no IO, easy to reason about in isolation)
// ---------------------------------------------------------------------------

const PLAN_ACTIONS = new Set(['approve-shape', 'create', 'reject', 'retry', 'cancel', 'surface']);

function matchRoute(method, segments) {
  if (segments.length === 1 && segments[0] === 'healthz') {
    return method === 'GET' ? { kind: 'healthz' } : { kind: '__method_not_allowed' };
  }
  if (segments.length === 1 && segments[0] === 'plans') {
    return method === 'GET' ? { kind: 'list_plans' } : { kind: '__method_not_allowed' };
  }
  // §6.3 — a separate endpoint (not a /plans query param): whole-store
  // aggregates should not ride every paginated fetch.
  if (segments.length === 2 && segments[0] === 'plans' && segments[1] === 'summary') {
    return method === 'GET' ? { kind: 'plans_summary' } : { kind: '__method_not_allowed' };
  }
  // §5.4 — the audit read endpoint.
  if (segments.length === 1 && segments[0] === 'audit') {
    return method === 'GET' ? { kind: 'get_audit' } : { kind: '__method_not_allowed' };
  }
  if (segments[0] !== 'plan') return { kind: '__not_found' };

  if (segments.length === 1) {
    return method === 'POST' ? { kind: 'create_plan' } : { kind: '__method_not_allowed' };
  }

  const planId = segments[1];
  if (!UUID_RE.test(planId)) return { kind: '__not_found' };

  if (segments.length === 2) {
    return method === 'GET' ? { kind: 'get_plan', planId } : { kind: '__method_not_allowed' };
  }

  if (segments.length === 3 && PLAN_ACTIONS.has(segments[2])) {
    return method === 'POST' ? { kind: segments[2], planId } : { kind: '__method_not_allowed' };
  }

  return { kind: '__not_found' };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(options = {}) {
  // Snapshot the results root ONCE, synchronously, before anything async can
  // touch process.env — every worker below closes over this same value
  // instead of re-reading MERCURY_RESULTS_DIR later (see state.mjs's file
  // header for why: a fire-and-forget worker outliving its HTTP response
  // must not be redirectable by some *other* concurrent test/request
  // resetting that env var out from under it).
  const resultsRoot = options.resultsDir || resultsDir();
  const state = options.state || new State(resultsRoot);
  const engineMode = options.engineMode || (process.env.MERCURY_ENGINE === 'fake' ? 'fake' : 'real');
  // This legacy knob is misleadingly named: it skips the ENTIRE plan gate,
  // not only anchor checks. It exists solely for fake-engine tests that do not
  // seed grounding repositories. A live engine must never turn deterministic
  // validation into `{ok:true,skipped:true}`, even when a custom gate is
  // injected, so reject the configuration before the server is constructed.
  const skipPlanGate = process.env.MERCURY_SKIP_PLAN_ANCHORS === '1';
  if (skipPlanGate && engineMode !== 'fake') {
    throw new Error(
      'MERCURY_SKIP_PLAN_ANCHORS=1 skips the entire plan gate and is allowed only with MERCURY_ENGINE=fake; refusing to construct a real planner service',
    );
  }
  const engine = options.engine || createEngine(engineMode);
  // Existing servers retain live process.env threshold reads. An explicitly
  // injected breakerEnv is snapshotted once so later caller mutation cannot
  // redirect an in-flight plan's budget policy.
  const breakerEnv = options.breakerEnv === undefined
    ? process.env
    : { ...options.breakerEnv };
  // Test/demo seam only: production callers keep the real fetch-before-plan
  // implementation. The fake demo injects a no-op so an inherited
  // MERCURY_FETCH_BEFORE_PLAN=1 cannot trigger a remote-grounding fetch.
  const fetchGrounding = options.fetchGroundingRepos || fetchGroundingRepos;
  // Test seams only; production callers supply no overrides and retain the
  // deterministic Go gates imported above.
  const skeletonGate = options.gateSkeleton || gateSkeleton;
  const planGate = options.gatePlan
    || ((runDir) => gatePlan(runDir, { skipPlanGate }));
  const token = options.token !== undefined ? options.token : process.env.MERCURY_SERVICE_TOKEN;
  if (token !== undefined && token === '') {
    console.error('WARN: MERCURY_SERVICE_TOKEN is set but EMPTY — bearer auth is DISABLED. Unset it or provide a real token.');
  }
  // §5.1: the dashboard's own per-client bearer. TRIMMED; empty/whitespace
  // is treated as NOT CONFIGURED — that arm of the two-token compare is
  // disabled entirely (mirrors the boot gate's treatment of the primary
  // token: a blank second token must never make `Authorization: Bearer `
  // a valid mesh credential). Absent this var entirely, behavior is
  // byte-identical to before the API extension (back-compat).
  const dashboardTokenRaw = options.dashboardToken !== undefined
    ? options.dashboardToken
    : process.env.MERCURY_SERVICE_TOKEN_DASHBOARD;
  const dashboardToken = typeof dashboardTokenRaw === 'string' && dashboardTokenRaw.trim().length > 0
    ? dashboardTokenRaw.trim()
    : undefined;
  // If an operator sets the dashboard token equal to
  // the primary bearer, classifyClient's primary-first check means
  // EVERY request presenting that shared value resolves to `client:
  // 'slack'` — the dashboard-only requirements (required actor, confirm
  // string) would then be silently unenforced for what is actually
  // dashboard traffic. Refuse to construct the service: warning and
  // continuing would disable a safety boundary.
  if (token && dashboardToken && safeEqual(token, dashboardToken)) {
    throw new Error(
      'MERCURY_SERVICE_TOKEN_DASHBOARD must be distinct from MERCURY_SERVICE_TOKEN — identical bearer tokens disable dashboard actor/confirm enforcement',
    );
  }

  state.load();

  // -- async workers -----------------------------------------------------
  // Each worker is entirely self-contained: every exit path (success,
  // breaker trip, thrown error) ends in exactly one state.update call, so a
  // plan is never left dangling in a transient status once its worker has
  // actually started running (crash-resume in state.mjs covers the case
  // where the PROCESS itself dies mid-flight).

  async function accountKnownFailedPhaseSpend(planId, err) {
    // Metered failures may carry receipts already reconciled by the proxy.
    // Persist that known spend BEFORE turning an uncertain receipt into the
    // global telemetry lock; otherwise a paid failed child would be erased.
    const known = err && err.costNanos;
    if (!Number.isSafeInteger(known) || known < 0) {
      if (err && err.code === 'COST_TELEMETRY_UNAVAILABLE') {
        breakers.lockCostTelemetry(resultsRoot, 'provider receipt reconciliation failed');
      }
      return;
    }
    if (known > 0) {
      await breakers.recordSpendNanos(resultsRoot, known);
      const current = state.get(planId);
      if (current) {
        const nextNanos = planCostNanos(current) + known;
        persistPhaseCost(planId, nextNanos);
      }
    }
    if (err && err.code === 'COST_TELEMETRY_UNAVAILABLE') {
      breakers.lockCostTelemetry(resultsRoot, 'provider receipt reconciliation failed');
    }
  }

  function persistPhaseCost(planId, costNanos) {
    try {
      state.update(planId, { cost_nanos: costNanos, cost_usd: displayUsd(costNanos), updated_at: nowIso() });
    } catch (err) {
      // Daily spend is already durable at this point.  If the correlated plan
      // write fails, a restart would undercount the plan breaker; lock first.
      breakers.lockCostTelemetry(resultsRoot, 'plan cost state persistence failed');
      throw err;
    }
  }

  async function runPhase1Worker(planId) {
    const plan = state.get(planId);
    if (!plan) return;
    try {
      // Refresh origin/main in every grounding repo BEFORE the
      // engine plans against them — control-plane, no LLM, gated on
      // MERCURY_FETCH_BEFORE_PLAN=1 (undefined when off; legacy plan shape
      // unchanged). The result is persisted on the plan and rides
      // toPublicView, so a failed fetch degrades VISIBLY at the Slack shape
      // gate ("anchors may validate against stale code") instead of
      // silently planning on stale refs. Never throws; never blocks the
      // plan — the human gate stays the control. Runs ONCE, above the regen
      // loop — a regen re-decomposes against the same fetched grounding.
      const grounding = await fetchGrounding();
      if (grounding) state.update(planId, { grounding });

      const runDir = agentRunDir(planId, resultsRoot);
      fs.mkdirSync(runDir, { recursive: true });

      // B1: derive the regen context from the PERSISTED plan, not the caller —
      // self-contained per worker. A FRESH plan (no failed skeleton_gate) →
      // regenCtx undefined → the first call is byte-identical to pre-B1. A plan
      // RE-ENTERING after a gate fail (an internal `continue`, a crash-resume,
      // OR a human Retry — all land here identically) picks up its own
      // persisted complaint block + FAILED session, so a manual Retry is
      // complaint-aware and resume-correct for free.
      let regenAttempt = (plan.regen_counts && plan.regen_counts.phase1) || 0;
      // Re-entry regen context — ONLY when a USABLE complaint exists to feed
      // back. Compute the complaint FIRST: a prior gate that gave up with NO
      // complaint (a spawn error / disk hiccup / unparsed stdout — the loop's
      // own `!complaintsBlock` give-up below) must NOT build a truthy regenCtx.
      // A truthy {complaintsBlock: undefined} would force a blind `--resume` of
      // the failed session with nothing injected AND, because such give-ups
      // never advance regen_counts, would repeat UNCAPPED on every human Retry.
      // No usable complaint → regenCtx undefined → a FRESH session (pre-B1
      // behavior), matching the loop's give-up intent.
      const priorComplaint = (plan.skeleton_gate && plan.skeleton_gate.ok === false)
        ? buildCheckerComplaintsBlock(plan.skeleton_gate)
        : undefined;
      let regenCtx = (priorComplaint && plan.session_id)
        ? { complaintsBlock: priorComplaint, sessionId: plan.session_id }
        : undefined;
      // The running total drives the per-plan budget check across iterations;
      // seeded from the persisted cost so a Retry accounts for prior spend.
      let costNanos = planCostNanos(plan);
      let costUsd = displayUsd(costNanos);

      for (;;) {
        const daily = breakers.checkDaily(resultsRoot, breakerEnv);
        if (daily.blocked) {
          state.update(planId, { status: 'budget_blocked', error: daily.reason, updated_at: nowIso() });
          return;
        }
        // B2: the per-plan cost cap, checked BEFORE every call INSIDE the loop
        // so N regens can never bypass it (a runaway regen loop is exactly how
        // an unbounded per-call cost would blow the plan budget). The
        // first-ever call (cost 0) is unaffected — the cap only bites once real
        // spend has accumulated. Trips BEFORE any spend, so a blocked plan is
        // retryable and never double-charged.
        if (costNanos > 0) {
          const planBudget = breakers.checkPlanBudget({ ...plan, cost_nanos: costNanos, cost_usd: costUsd }, breakerEnv);
          if (planBudget.blocked) {
            state.update(planId, { status: 'budget_blocked', error: planBudget.reason, updated_at: nowIso() });
            return;
          }
        }

        const result = await engine.phase1({
          runDir,
          ask: plan.description,
          requester: plan.requester,
          roleLens: plan.role_lens,
          outputLanguage: plan.output_language,
          scopeHint: plan.scope_hint,
          groundingHint: plan.grounding_hint,
          // B1 composes ALONGSIDE B5's groundingHint — not in place of it.
          regen: regenCtx,
        });
        logPhaseTiming('decompose', plan, result);
        // spend serialization: awaited — recordSpend is serialized through breakers' in-process
        // queue, and the increment must be durable before this worker's own
        // next step (and any concurrent worker's checkDaily) can observe it.
        const phaseCostNanos = resultCostNanos(result);
        await breakers.recordSpendNanos(resultsRoot, phaseCostNanos);
        costNanos += phaseCostNanos;
        if (!Number.isSafeInteger(costNanos)) throw new Error('planning cost telemetry overflow');
        costUsd = displayUsd(costNanos);
        // Commit the plan-side fixed-point total BEFORE opening/gating any
        // artifact.  A gate process crash must not leave the daily ledger
        // charged while a Retry sees a zero per-plan total.
        persistPhaseCost(planId, costNanos);

        const gate = await skeletonGate(runDir);
        const skeleton = readJsonIfExists(path.join(runDir, 'skeleton.json'));

        if (gate.ok) {
          state.update(planId, {
            status: 'shape_ready',
            session_id: result.sessionId,
            cost_usd: costUsd,
            cost_nanos: costNanos,
            run_dir: runDir,
            skeleton,
            skeleton_gate: gate,
            agent_summary: result.resultText,
            regen_counts: { ...plan.regen_counts, phase1: regenAttempt },
            updated_at: nowIso(),
          });
          return;
        }

        // Gate failed. Give up (surface `failed`) when re-decomposing is
        // provably futile or spent: NO actionable complaint to feed back (a
        // spawn error / empty block — nothing to fix), or the regen ceiling
        // reached. Otherwise regenerate. (The old UNSATISFIABLE sizing×scope
        // short-circuit is gone: the leaf-cost cap is an advisory WARN now, so
        // there is no sizing hard fail that a re-decompose provably can't fix.)
        const complaintsBlock = buildCheckerComplaintsBlock(gate);
        const exhausted = regenAttempt >= MAX_REGEN_ATTEMPTS;
        if (!complaintsBlock || exhausted) {
          state.update(planId, {
            status: 'failed',
            session_id: result.sessionId,
            cost_usd: costUsd,
            cost_nanos: costNanos,
            run_dir: runDir,
            skeleton,
            skeleton_gate: gate,
            agent_summary: result.resultText,
            regen_counts: { ...plan.regen_counts, phase1: regenAttempt },
            error: describeSkeletonGateFailure(gate, plan),
            updated_at: nowIso(),
          });
          return;
        }

        // Regenerate: bump and PERSIST the count + failed session BEFORE the
        // next call (crash-safe — a restart reloads the count and resumes at N,
        // never a fresh 2× loop), then resume the FAILED session carrying its
        // complaint so the model sees its own rejected skeleton.
        regenAttempt += 1;
        state.update(planId, {
          session_id: result.sessionId,
          cost_usd: costUsd,
          cost_nanos: costNanos,
          run_dir: runDir,
          skeleton,
          skeleton_gate: gate,
          agent_summary: result.resultText,
          regen_counts: { ...plan.regen_counts, phase1: regenAttempt },
          updated_at: nowIso(),
        });
        regenCtx = { complaintsBlock, sessionId: result.sessionId };
      }
    } catch (err) {
      try {
        await accountKnownFailedPhaseSpend(planId, err);
      } catch {
        breakers.lockCostTelemetry(resultsRoot, 'provider cost ledger write failed');
      }
      state.update(planId, { status: 'failed', error: publicWorkerError(err), updated_at: nowIso() });
    }
  }

  async function runGroomWorker(planId, edited) {
    const plan = state.get(planId);
    if (!plan) return;
    try {
      const runDir = plan.run_dir || agentRunDir(planId, resultsRoot);
      // Light grounding extends to groom (B5): a light plan's grounding was
      // already done in decompose, but the decompose-only cap left groom
      // re-crawling the repos per item (94% of a real Light plan's bill). Pass
      // the plan's grounding depth (the engine injects the groom `# GROUNDING`
      // directive + a plan-size-scaled --max-turns cap when it is `light`) and
      // the item count that sizes that cap. plan.skeleton already reflects any
      // human skeleton_edits applied at approve-shape, so this is the correct
      // POST-edit count.
      const itemCount = plan.skeleton && Array.isArray(plan.skeleton.items) ? plan.skeleton.items.length : undefined;

      // B1 groom mirror — simpler than phase1: groom ALREADY resumes
      // plan.session_id (no session branching, no fresh-UUID bug) and there is
      // NO scope short-circuit (v1). The ONLY groom-side regen wire is threading
      // the plan-gate's complaint back into groomMessage's `CONTRACT FEEDBACK`
      // block, bounded by the same N=2 via regen_counts.groom.
      let regenAttempt = (plan.regen_counts && plan.regen_counts.groom) || 0;
      let regenComplaints = (plan.plan_gate && plan.plan_gate.ok === false)
        ? buildCheckerComplaintsBlock(plan.plan_gate)
        : undefined;
      let costNanos = planCostNanos(plan);
      let costUsd = displayUsd(costNanos);

      for (;;) {
        const daily = breakers.checkDaily(resultsRoot, breakerEnv);
        if (daily.blocked) {
          state.update(planId, { status: 'budget_blocked', error: daily.reason, updated_at: nowIso() });
          return;
        }
        // Per-plan cap — checked before EVERY groom call (the pre-B1 check ran
        // once; the loop keeps it honest across regens) on the running total.
        const planBudget = breakers.checkPlanBudget({ ...plan, cost_nanos: costNanos, cost_usd: costUsd }, breakerEnv);
        if (planBudget.blocked) {
          state.update(planId, { status: 'budget_blocked', error: planBudget.reason, updated_at: nowIso() });
          return;
        }

        const result = await engine.groom({
          runDir,
          sessionId: plan.session_id,
          // The human-edit note is meaningful only on the FIRST groom call; a
          // regen resumes the same session where the edit was already applied,
          // so it must not re-announce the edit (regenAttempt > 0 → false).
          edited: Boolean(edited) && regenAttempt === 0,
          outputLanguage: plan.output_language,
          groundingHint: plan.grounding_hint,
          itemCount,
          regenComplaints,
        });
        logPhaseTiming('groom', plan, result);
        const phaseCostNanos = resultCostNanos(result);
        await breakers.recordSpendNanos(resultsRoot, phaseCostNanos); // spend serialization — see runPhase1Worker
        costNanos += phaseCostNanos;
        if (!Number.isSafeInteger(costNanos)) throw new Error('planning cost telemetry overflow');
        costUsd = displayUsd(costNanos);
        persistPhaseCost(planId, costNanos);

        const gate = await planGate(runDir);
        const groomedPlan = readJsonIfExists(path.join(runDir, 'plan.json'));

        if (gate.ok) {
          // Advisory duplicate check surfaced to the human approver alongside
          // the groomed plan — never blocks plan_ready (a missing token or
          // network failure degrades to ok:false; the human gate is the
          // control). Seed preference (2026-07-10): the SKELETON's epic summary
          // over the raw ask prefix — the summary is the concise,
          // on-board-comparable TITLE, while an ask prefix is prose (the live
          // Ask-prefix search can miss a near-identical epic
          // already on the board). One-node skeletons (epic: null) fall back to
          // the ask.
          const epicSummary = plan.skeleton && plan.skeleton.epic && typeof plan.skeleton.epic.summary === 'string'
            ? plan.skeleton.epic.summary.trim()
            : '';
          const duplicateSearch = await engine.search({ terms: searchTerms(epicSummary || plan.description) });

          state.update(planId, {
            status: 'plan_ready',
            session_id: result.sessionId,
            cost_usd: costUsd,
            cost_nanos: costNanos,
            plan: groomedPlan,
            plan_gate: gate,
            duplicate_search: duplicateSearch,
            agent_summary: result.resultText,
            regen_counts: { ...plan.regen_counts, groom: regenAttempt },
            updated_at: nowIso(),
          });
          return;
        }

        // Gate failed: give up when there is no actionable complaint to feed
        // back or the regen ceiling is reached; otherwise regenerate.
        const complaintsBlock = buildCheckerComplaintsBlock(gate);
        const exhausted = regenAttempt >= MAX_REGEN_ATTEMPTS;
        if (!complaintsBlock || exhausted) {
          state.update(planId, {
            status: 'failed',
            session_id: result.sessionId,
            cost_usd: costUsd,
            cost_nanos: costNanos,
            plan: groomedPlan,
            plan_gate: gate,
            agent_summary: result.resultText,
            regen_counts: { ...plan.regen_counts, groom: regenAttempt },
            error: describePlanGateFailure(gate),
            updated_at: nowIso(),
          });
          return;
        }

        // Persist the bumped count + failed session BEFORE the next call
        // (crash-safe — a Retry resumes at N via regen_counts.groom), then
        // regenerate with the fresh complaint.
        regenAttempt += 1;
        state.update(planId, {
          session_id: result.sessionId,
          cost_usd: costUsd,
          cost_nanos: costNanos,
          plan: groomedPlan,
          plan_gate: gate,
          agent_summary: result.resultText,
          regen_counts: { ...plan.regen_counts, groom: regenAttempt },
          updated_at: nowIso(),
        });
        regenComplaints = complaintsBlock;
      }
    } catch (err) {
      try {
        await accountKnownFailedPhaseSpend(planId, err);
      } catch {
        breakers.lockCostTelemetry(resultsRoot, 'provider cost ledger write failed');
      }
      state.update(planId, { status: 'failed', error: publicWorkerError(err), updated_at: nowIso() });
    }
  }

  async function runCreateWorker(planId) {
    const plan = state.get(planId);
    if (!plan) return;
    try {
      const runDir = plan.run_dir || agentRunDir(planId, resultsRoot);
      // Control-plane create: no agent, no LLM — engine.create spawns
      // create-tree.mjs (--live, then --verify) deterministically. It has no
      // model spend, so plan/daily LLM breakers must not strand a human-
      // approved Jira write. Its immutable planning cost is preserved below;
      // the create path neither records nor re-checks LLM spend.
      const result = await engine.create({ runDir });
      const costUsd = plan.cost_usd || 0;

      const created = {
        keys: (result.created || []).map((c) => c.key),
        items: result.created || [],
        record_path: result.recordPath,
        verify_ok: result.verifyOk,
        // Attach mode: the pre-existing epic the tree was parented under
        // (engine.create lifts it from the record's attached_epic —
        // deliberately OUTSIDE keys/items, which drive the cancel sweep).
        // Riding the marker makes the attach target visible at the terminal
        // Slack surface (createdMessage) via toPublicView. Absent entirely
        // when not attaching.
        ...(result.attached_epic ? { attached_epic: result.attached_epic } : {}),
      };

      if (!result.verifyOk) {
        state.update(planId, {
          status: 'failed',
          cost_usd: costUsd,
          created,
          agent_summary: result.resultText,
          error: `created but verify failed — inspect record ${result.recordPath}`,
          updated_at: nowIso(),
        });
        return;
      }

      state.update(planId, {
        status: 'created',
        cost_usd: costUsd,
        created,
        agent_summary: result.resultText,
        updated_at: nowIso(),
      });
    } catch (err) {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    }
  }

  // Verify-only recovery for a failed plan whose create ALREADY wrote to
  // Jira — fully (case A, `partial:false`) or partially (case B,
  // `partial:true`). Runs under the existing `creating` transient status:
  // crash-resume (state.mjs) and the Slack poller already handle `creating`,
  // and a new status would ripple through slack.mjs/slack-blocks.mjs for
  // zero safety gain. Deliberately NO breaker checks — verify is a zero-LLM-
  // spend control-plane Jira READ, and blocking a recovery read on a spend
  // budget could strand an already-paid-for tree unverified.
  async function runVerifyRecoverWorker(planId, { partial }) {
    const plan = state.get(planId);
    if (!plan) return;
    try {
      const runDir = plan.run_dir || agentRunDir(planId, resultsRoot);
      // Case A carries the authoritative path on the plan itself; case B has
      // no marker yet — the record is wherever create-tree's catch persisted
      // it (--out always targets <runDir>/created-record.json).
      const recordPath = partial
        ? path.join(runDir, CREATED_RECORD_FILENAME)
        : plan.created.record_path;
      const verify = await engine.verify({ recordPath });

      if (!partial) {
        // Case A: create COMPLETED (full record, every issue written) but
        // the post-create --verify hiccuped. A green re-read is the only
        // thing that was ever missing — heal the plan to `created`.
        if (verify.ok) {
          state.update(planId, {
            status: 'created',
            created: { ...plan.created, verify_ok: true },
            error: undefined,
            updated_at: nowIso(),
          });
          return;
        }
        state.update(planId, {
          status: 'failed',
          // errMsg on a composed string (it stringifies plain strings fine):
          // record paths under MERCURY_ROOT render as ./results/... — still
          // a runnable --cleanup argument from the repo root, shorter for
          // the Slack budget, and no absolute server paths leak to clients.
          error: errMsg(`created but verify failed again — record ${recordPath}; inspect or cancel the tree: node tools/create-tree.mjs --cleanup ${recordPath} --live\nverify output tail:\n${verify.output.slice(-500)}`),
          updated_at: nowIso(),
        });
        return;
      }

      // Case B: partial record — ALWAYS end `failed`, never promote.
      // --verify only re-reads the issues listed IN the record and fails
      // only when a read fails: it proves the fragments are READABLE, not
      // that the tree is complete vs the plan — a partial record verifies
      // green. Its value here is confirming the recorded keys are real
      // before a human cleans them up.
      const record = readJsonIfExists(recordPath);
      const items = record && Array.isArray(record.created) ? record.created : undefined;
      if (!items) {
        // Untrustworthy record: keep whatever `created` marker the plan
        // already has — never fabricate one from a record we can't trust.
        // MISSING (e.g. deleted after a manual --cleanup) and EXISTS-BUT-
        // GARBAGE (torn write, or JSON with no created[] list) both fail
        // closed, but the operator guidance differs — "could not be parsed"
        // over a file that isn't there sends a human hunting for corruption
        // that doesn't exist.
        state.update(planId, {
          status: 'failed',
          agent_summary: undefined, // create-era summary is stale on a blocked plan
          // errMsg strips MERCURY_ROOT from the embedded record path (see
          // the case-A wrap above for why).
          error: errMsg(fs.existsSync(recordPath)
            ? `retry blocked — a previous create attempt left a record at ${recordPath} that could not be parsed (or has no created[] list); inspect it manually before cleaning up or retrying (re-creating could duplicate already-written issues). Verify said: ${verify.output.slice(-300)}`
            : `retry blocked — this plan's created marker records real Jira writes but the record file at ${recordPath} is missing (deleted after a manual cleanup?); cannot prove zero writes, so re-creating is blocked. If the tree was fully cancelled, abandon this plan and start a new one.`),
          updated_at: nowIso(),
        });
        return;
      }
      state.update(planId, {
        status: 'failed',
        // `partial: true` + record_path is the durable handle for what comes
        // next: the retry guard reads `partial` to keep routing here instead
        // of re-creating, and cancel flow's Slack cancel button reads `record_path`
        // for the --cleanup call.
        created: {
          keys: items.map((c) => c.key),
          items,
          record_path: recordPath,
          verify_ok: false,
          partial: true,
        },
        agent_summary: undefined, // create-era summary is stale on a blocked plan
        // Segment order is deliberate: slack-blocks.mjs terminalMessage
        // truncates this at 500 chars, and the --cleanup command is the
        // user's ONLY undo handle — it must come before the verify tail so
        // it survives the truncation. The abandon sentence follows it,
        // still inside the 500-char window (reason ~110 + command ~180 at
        // a realistic 104-char path + abandon ~71 ≈ 365): without it, a
        // human who already ran --cleanup gets re-verified green fragments
        // (cleanup cancels, never deletes) and the same cleanup instruction
        // forever — a circular dead-end with no exit. errMsg strips
        // MERCURY_ROOT from the record path (shorter, still runnable).
        error: errMsg([
          `retry blocked — a previous create attempt already wrote ${items.length} issue(s) to Jira; re-creating would duplicate them.`,
          `Clean up the partial tree with: node tools/create-tree.mjs --cleanup ${recordPath} --live`,
          'If you have already cleaned up, abandon this plan and start a new one.',
          verify.ok
            ? 'Verify read every recorded issue back OK (readable ≠ complete — the tree is still partial vs the plan).'
            : `Verify failed: ${verify.output.slice(-300)}`,
        ].join('\n')),
        updated_at: nowIso(),
      });
    } catch (err) {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    }
  }

  // Cancel a created tree (cancel flow) — the Slack undo for a tree that already
  // lives on the real board. Control-plane only: engine.cleanup spawns
  // create-tree.mjs --cleanup <record> --live, which transitions every
  // recorded issue to a terminal state (cancelled/closed where available;
  // children before parents, locale-aware) and NEVER deletes. Deliberately NO breaker checks —
  // cleanup is zero-LLM-spend control-plane Jira work, and blocking an undo
  // on a spend budget would strand a wrong tree live on the board (same
  // reasoning as runVerifyRecoverWorker).
  //
  // retry write guard interplay, deliberate non-goal: a plan that lands `failed` here still
  // offers Retry, and retry write guard's case-A verify-only recovery can heal a READABLE
  // tree back to `created` even when its issues are all cancelled (--verify
  // reads cancelled issues fine — cleanup cancels, never deletes). That is
  // safe (verify never writes) but confusing; the README documents that
  // Cancel-again is the right button on a failed cancel. Blocking Retry from
  // here would be scope creep — not attempted.
  async function runCancelWorker(planId) {
    const plan = state.get(planId);
    if (!plan) return;
    // Hoisted above the try so the catch below can compose the same
    // re-click guidance as the ok:false branch (handleCancel already
    // verified the marker before transitioning, so this cannot be reached
    // recordless through any legal flow).
    const recordPath = plan.created.record_path;
    try {
      const res = await engine.cleanup({ recordPath });

      if (res.ok) {
        // Keep keys/items/record_path — the record is the audit handle for
        // what was cancelled; `cancelled: true` is the durable fact. Exit 0
        // means the sweep ran with ZERO hard failures (see engine.cleanup's
        // exit-semantics note) — already-terminal issues may still have
        // been benignly skipped, so the output tail lands in agent_summary
        // and GET /plan carries the per-issue results.
        state.update(planId, {
          status: 'cancelled',
          created: { ...plan.created, cancelled: true },
          agent_summary: res.output,
          error: undefined,
          updated_at: nowIso(),
        });
        return;
      }

      // Segment order is deliberate (same Slack discipline as retry write guard's case B):
      // slack-blocks.mjs terminalMessage truncates `error` at 500 chars, so
      // the re-click guidance and the runnable --cleanup command must land
      // before the output tail. The `created` marker is deliberately NOT
      // touched — it keeps the Cancel button on the failed message. The
      // re-click is safe over already-cancelled issues because Jira offers
      // no transition into a state an issue is already in: on those,
      // findCancelTransition finds no match and create-tree's benign
      // ⚠-skip leaves them alone (still the exit-0 path under the
      // hard-failure exit-1 semantics).
      state.update(planId, {
        status: 'failed',
        agent_summary: undefined, // create-era summary is stale on a failed cancel
        error: errMsg([
          'cancel failed — the tree may be only partially cancelled.',
          `Click "Cancel tree" again or run: node tools/create-tree.mjs --cleanup ${recordPath} --live`,
          `Cleanup output tail:\n${String(res.output || '').slice(-300)}`,
        ].join('\n')),
        updated_at: nowIso(),
      });
    } catch (err) {
      // Spawn failure / timeout (engine.cleanup's only reject path): same
      // Slack discipline as the ok:false branch — guidance + runnable
      // --cleanup command first (inside terminalMessage's 500-char window),
      // the raw error last. The marker stays untouched here too, so the
      // failed message re-offers the Cancel button.
      state.update(planId, {
        status: 'failed',
        agent_summary: undefined, // create-era summary is stale on a failed cancel
        error: errMsg([
          'cancel failed — the tree may be only partially cancelled.',
          `Click "Cancel tree" again or run: node tools/create-tree.mjs --cleanup ${recordPath} --live`,
          errMsg(err),
        ].join('\n')),
        updated_at: nowIso(),
      });
    }
  }

  // -- body/JSON helper (also handles the 413/400 responses) -------------

  async function readJsonBody(req, res) {
    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err.code === 'TOO_LARGE') {
        sendJson(res, 413, { error: 'payload too large', limit_bytes: MAX_BODY_BYTES });
        // The body stream is paused mid-flight (readBody) — once the 413 is
        // flushed, tear the connection down; never drain the remainder.
        res.once('finish', () => req.destroy());
      } else {
        sendJson(res, 400, { error: 'failed to read request body' });
      }
      return undefined; // sentinel: "already responded, caller must return"
    }
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return undefined;
    }
  }

  // -- audit ledger (§5.3) --------------------------------------------------
  //
  // Write placement, everywhere below: validation -> CAS transition ->
  // audit append -> HTTP response -> fire-and-forget worker dispatch.
  // `recordAudit` builds the record (planner-verified `ts`/`request_id`/
  // `client`/`action`/`plan_id`/`prior_status`/`result`, BFF-asserted
  // `actor`) and appends it; `appendAudit` never throws and never blocks
  // the mutation on a disk failure (loud stderr only). The request_id is
  // always returned so the caller can echo it additively on the mutation's
  // JSON response — the join key back to this same ledger line.
  //
  // 400/404 responses are NEVER audited (validation/lookup noise); a
  // denied 409 (an illegal-transition attempt, or a cancel with nothing to
  // cancel) IS audited every time — a double-fired Create or a cancel
  // raced against a reject is exactly what the ledger must show.
  // `POST /plan/{id}/surface` never calls this at all (deliberately not
  // audited — client-owned delivery metadata, no state consequence).
  function recordAudit({
    client, actor, action, planId, priorStatus, result,
  }) {
    const record = {
      ts: nowIso(),
      request_id: crypto.randomUUID(),
      client,
      actor: actor ?? null,
      action,
      plan_id: planId,
      prior_status: priorStatus,
      result,
    };
    appendAudit(resultsRoot, record);
    return record.request_id;
  }

  // Shared shape for the "illegal transition" 409 denial that five of the
  // six mutating routes hit (retry's three internal CAS sites included).
  // `priorStatus` is the plan's ACTUAL status that caused the denial —
  // `plan.status` (captured before any CAS attempt) for an early
  // pre-check, or `cas.status` (state.mjs's own conflict-status echo) for
  // a CAS-transition race.
  function auditIllegalTransition(client, actor, action, planId, priorStatus, error = 'illegal transition') {
    return recordAudit({
      client, actor, action, planId, priorStatus, result: { http: 409, error },
    });
  }

  // -- handlers ------------------------------------------------------------

  async function handleCreatePlan(req, res, client) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const errors = [];
    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) errors.push(actorResult.error);
    const description = typeof body.description === 'string' ? body.description : '';
    const requester = typeof body.requester === 'string' ? body.requester : '';
    // C0 (UX foundation): the stable Slack @-mention id, parallel to the
    // human-readable `requester`. FAIL-OPEN — optional and NON-validated:
    // unlike the required `requester` above, a plan missing (or with a junk)
    // requester_id must NOT be rejected. Reason: requester_id is a VISIBILITY
    // field (drives "asked by @name" and future @-mentions), never a security
    // control — ownership-gating (D1) was dropped — and legacy plans predate
    // it. A non-string value degrades to '' rather than erroring.
    const requesterId = typeof body.requester_id === 'string' ? body.requester_id : '';
    let roleLens = body.role_lens;
    let mode = body.mode;
    let outputLanguage = body.output_language;
    let scopeHint = body.scope_hint;
    let groundingHint = body.grounding_hint;

    if (description.trim().length === 0) errors.push('description must be a non-empty string');
    if (description.length > MAX_DESCRIPTION_CHARS) errors.push(`description must be <= ${MAX_DESCRIPTION_CHARS} characters`);
    if (requester.trim().length === 0) errors.push('requester must be a non-empty string');

    if (roleLens === undefined || roleLens === null) {
      roleLens = 'business';
    } else if (typeof roleLens !== 'string' || !VALID_ROLE_LENS.has(roleLens)) {
      errors.push("role_lens must be one of 'business' | 'tech'");
    }

    if (mode === undefined || mode === null) {
      mode = 'front_door';
    } else if (typeof mode !== 'string' || mode.trim().length === 0) {
      errors.push('mode must be a non-empty string when provided');
    }

    if (outputLanguage === undefined || outputLanguage === null) {
      outputLanguage = 'en';
    } else if (typeof outputLanguage !== 'string' || !VALID_OUTPUT_LANGUAGE.has(outputLanguage)) {
      errors.push("output_language must be one of 'en' | 'tr' | 'both'");
    }

    if (scopeHint === undefined || scopeHint === null) {
      scopeHint = 'auto';
    } else if (typeof scopeHint !== 'string' || !VALID_SCOPE_HINT.has(scopeHint)) {
      errors.push("scope_hint must be one of 'auto' | 'single' | 'small' | 'epic'");
    }

    if (groundingHint === undefined || groundingHint === null) {
      groundingHint = 'full';
    } else if (typeof groundingHint !== 'string' || !VALID_GROUNDING_HINT.has(groundingHint)) {
      errors.push("grounding_hint must be one of 'full' | 'light'");
    }

    // Optional reply-to surface descriptor, stored verbatim —
    // opaque to this service (see surfaceError). Lets the creating client
    // survive its own restart: the descriptor is read back via GET /plans.
    const surface = body.surface;
    if (surface !== undefined && surface !== null) {
      const surfaceErr = surfaceError(surface);
      if (surfaceErr) errors.push(surfaceErr);
    }

    if (errors.length > 0) {
      return sendJson(res, 400, { error: 'validation failed', details: errors });
    }
    const actor = actorResult.actor;

    const planId = crypto.randomUUID();
    const timestamp = nowIso();
    state.create({
      plan_id: planId,
      description,
      requester,
      requester_id: requesterId,
      role_lens: roleLens,
      mode,
      output_language: outputLanguage,
      scope_hint: scopeHint,
      grounding_hint: groundingHint,
      ...(surface !== undefined && surface !== null ? { surface } : {}),
      status: 'breaking_down',
      cost_usd: 0,
      created_at: timestamp,
      updated_at: timestamp,
    });

    const requestId = recordAudit({
      client, actor, action: 'plan.submit', planId, priorStatus: null, result: { http: 202, to_status: 'breaking_down' },
    });
    sendJson(res, 202, { plan_id: planId, status: 'breaking_down', request_id: requestId });

    // Fire-and-forget: the worker itself always ends in a state.update, and
    // this .catch is a second safety net so a bug in the worker's own
    // try/catch can never become an unhandled rejection.
    runPhase1Worker(planId).catch((err) => {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    });
  }

  function handleGetPlan(req, res, planId) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, toPublicView(plan));
  }

  // Boot-resume feed for thin clients (service/slack.mjs re-watches every
  // non-terminal plan on startup) AND the dashboard registry's backing
  // list (§6.2). Deliberately thin: a bare call returns TODAY's fields
  // byte-identical (plan_id, status, 80-char-truncated description,
  // updated_at, surface, announced_status) plus exactly six additive
  // per-item fields, and an additive top-level `next_cursor` when more
  // pages exist — nothing existing changes shape or value.
  //
  // Query params (all optional): `limit` (1-200, default 50 — today's
  // hardcoded cap becomes the page size), `status` (comma list validated
  // against the eleven-status vocabulary), `cursor` (opaque keyset over
  // (updated_at desc, plan_id desc) — the plan_id tiebreak is new here;
  // today's sort had no total order for colliding updated_at values).
  // Accepted, documented caveat: a plan mutated mid-pagination can be seen
  // twice or jump pages — cosmetic for a 3-5s-polling registry.
  function handleListPlans(req, res, query) {
    const errors = [];

    let limit = 50;
    if (query.has('limit')) {
      const raw = query.get('limit');
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        errors.push('limit must be an integer between 1 and 200');
      } else {
        limit = n;
      }
    }

    let statusFilter;
    if (query.has('status')) {
      const parts = query.get('status').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const unknown = parts.filter((s) => !VALID_STATUSES.has(s));
      if (parts.length === 0 || unknown.length > 0) {
        errors.push(`status must be a comma-separated list from: ${[...VALID_STATUSES].join(' | ')}`);
      } else {
        statusFilter = new Set(parts);
      }
    }

    // an explicit-but-empty `cursor=` is treated as
    // "no cursor" — the same convention audit.mjs's readAudit already uses
    // for its own cursor param. Before this fix the two new paginated
    // endpoints disagreed on this exact edge case (this one 400'd, GET
    // /audit didn't); this one now matches.
    let cursor;
    if (query.has('cursor') && query.get('cursor') !== '') {
      cursor = decodePlansCursor(query.get('cursor'));
      if (!cursor) errors.push('malformed cursor');
    }

    if (errors.length > 0) {
      return sendJson(res, 400, { error: 'validation failed', details: errors });
    }

    let candidates = [...state.plans.values()];
    if (statusFilter) candidates = candidates.filter((plan) => statusFilter.has(plan.status));
    candidates.sort(comparePlansDesc);
    if (cursor) candidates = candidates.filter((plan) => isAfterPlansCursor(plan, cursor));

    const page = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;

    const plans = page.map((plan) => ({
      plan_id: plan.plan_id,
      status: plan.status,
      description: String(plan.description || '').slice(0, 80),
      updated_at: plan.updated_at,
      // Exactly what a restarted client needs to re-attach —
      // its own reply-to descriptor and its delivery cursor. Absent on
      // legacy plans (JSON drops undefined), keeping their shape unchanged.
      surface: plan.surface,
      announced_status: plan.announced_status,
      // §6.2 additive item fields (dashboard registry read-model).
      requester: plan.requester,
      // the stable key the dashboard's "Mine" chip matches on — display
      // names collide across surfaces and renames.
      requester_id: plan.requester_id,
      cost_usd: plan.cost_usd || 0,
      created_at: plan.created_at,
      grounding_hint: plan.grounding_hint,
      // nullable — the `↷ attach` row marker; null both pre-shape_ready
      // and for a plan whose epic is NOT attaching to an existing key.
      attach_key: (plan.skeleton && plan.skeleton.epic && typeof plan.skeleton.epic.existing_key === 'string')
        ? plan.skeleton.epic.existing_key
        : null,
    }));

    const body = { plans };
    if (hasMore) {
      const last = page[page.length - 1];
      body.next_cursor = encodePlansCursor(String(last.updated_at || ''), String(last.plan_id || ''));
    }
    return sendJson(res, 200, body);
  }

  // §6.3 — status counts, a separate endpoint from GET /plans (whole-store
  // aggregates should not ride every paginated fetch). All eleven statuses
  // are always present, zero-filled; one pass over the in-memory map.
  function handlePlansSummary(req, res) {
    const counts = {};
    for (const status of VALID_STATUSES) counts[status] = 0;
    for (const plan of state.plans.values()) {
      if (Object.prototype.hasOwnProperty.call(counts, plan.status)) {
        counts[plan.status] += 1;
      }
    }
    return sendJson(res, 200, { total: state.plans.size, counts });
  }

  // §5.4 — GET /audit. `plan_id` optional (UUID-validated), `limit` 1-500
  // (default 100), `cursor` opaque (see audit.mjs). Records newest-first.
  function handleAudit(req, res, query) {
    const errors = [];

    let planId;
    if (query.has('plan_id')) {
      const raw = query.get('plan_id');
      if (!UUID_RE.test(raw)) {
        errors.push('plan_id must be a valid UUID');
      } else {
        planId = raw;
      }
    }

    let limit = 100;
    if (query.has('limit')) {
      const n = Number(query.get('limit'));
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        errors.push('limit must be an integer between 1 and 500');
      } else {
        limit = n;
      }
    }

    if (errors.length > 0) {
      return sendJson(res, 400, { error: 'validation failed', details: errors });
    }

    const cursor = query.has('cursor') ? query.get('cursor') : undefined;
    let result;
    try {
      result = readAudit(resultsRoot, { planId, cursor, limit });
    } catch (err) {
      if (err instanceof AuditCursorError) {
        return sendJson(res, 400, { error: 'malformed cursor' });
      }
      throw err;
    }
    return sendJson(res, 200, result);
  }

  // POST /plan/{id}/surface — the surface-persistence write. A
  // thin client (service/slack.mjs) stores/refreshes its opaque reply-to
  // descriptor and/or advances its `announced_status` delivery cursor on the
  // durable plan record, so a client restart recovers BOTH from GET /plans
  // instead of its own RAM (the orphan-bug fix: Window A needs the address,
  // Window B needs the cursor).
  //
  // Deliberately a plain `state.update`, NOT a `state.transition` CAS: this
  // endpoint never touches `status`, and `surface`/`announced_status` are
  // client-owned metadata the state machine never reads — there is no
  // transition to race with, and last-writer-wins is exactly right for the
  // single bridge that owns these fields (its own submit/click/poll writes
  // are already serialized by Node's event loop; a second bridge writing the
  // same plan would be a deployment error this build does not defend).
  async function handleSurface(req, res, planId) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });

    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const errors = [];
    const surface = body.surface;
    const announcedStatus = body.announced_status;
    const hasSurface = surface !== undefined && surface !== null;
    const hasCursor = announcedStatus !== undefined && announcedStatus !== null;

    if (hasSurface) {
      const surfaceErr = surfaceError(surface);
      if (surfaceErr) errors.push(surfaceErr);
    }
    if (hasCursor && (typeof announcedStatus !== 'string' || !VALID_STATUSES.has(announcedStatus))) {
      errors.push(`announced_status must be one of ${[...VALID_STATUSES].join(' | ')}`);
    }
    if (!hasSurface && !hasCursor) {
      // An empty write is a client bug, not a no-op worth 200ing — say so.
      errors.push('at least one of surface | announced_status is required');
    }
    if (errors.length > 0) {
      return sendJson(res, 400, { error: 'validation failed', details: errors });
    }

    // updated_at IS bumped: GET /plans sorts by it and caps at 50, and a plan
    // a client is actively announcing must never age out of its own
    // boot-resume feed while it still matters.
    state.update(planId, {
      ...(hasSurface ? { surface } : {}),
      ...(hasCursor ? { announced_status: announcedStatus } : {}),
      updated_at: nowIso(),
    });
    return sendJson(res, 200, { ok: true });
  }

  async function handleApproveShape(req, res, planId, client) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });
    if (plan.status !== 'shape_ready') {
      // The body is not read on this early path (unchanged precedence vs.
      // before the API extension: a malformed-JSON body on an already-illegal-transition
      // plan still 409s here, never 400) — so there is no actor to
      // attribute; audited as `actor: null`, same as any bridge/api call
      // that simply omitted one.
      const requestId = auditIllegalTransition(client, null, 'plan.approve_shape', planId, plan.status);
      return sendJson(res, 409, { error: 'illegal transition', status: plan.status, request_id: requestId });
    }

    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) return sendJson(res, 400, { error: actorResult.error });
    const actor = actorResult.actor;

    const skeletonEdits = body.skeleton_edits;
    let edited = false;

    if (skeletonEdits !== undefined && skeletonEdits !== null) {
      if (typeof skeletonEdits !== 'object' || Array.isArray(skeletonEdits)) {
        return sendJson(res, 400, { error: 'skeleton_edits must be a JSON object' });
      }
      const runDir = plan.run_dir || agentRunDir(planId, resultsRoot);
      fs.mkdirSync(runDir, { recursive: true });
      // Gate the edit in a TEMP directory first; only replace the real
      // skeleton.json on a green gate. (A failed edit must never linger on
      // disk where a later plain approve would groom over it un-gated.)
      const stageDir = path.join(runDir, `.edit-stage-${Date.now()}`);
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(path.join(stageDir, 'skeleton.json'), JSON.stringify(skeletonEdits, null, 2));
      const gate = await skeletonGate(stageDir);
      if (!gate.ok) {
        fs.rmSync(stageDir, { recursive: true, force: true });
        return sendJson(res, 422, { error: 'skeleton gate failed on edited skeleton', gate });
      }
      fs.renameSync(path.join(stageDir, 'skeleton.json'), path.join(runDir, 'skeleton.json'));
      fs.rmSync(stageDir, { recursive: true, force: true });
      state.update(planId, { skeleton: skeletonEdits, skeleton_gate: gate, run_dir: runDir, updated_at: nowIso() });
      edited = true;
    }

    // CAS: only one approve wins; a concurrent approve/reject 409s here.
    const cas = state.transition(planId, ['shape_ready'], { status: 'grooming', updated_at: nowIso() });
    if (!cas.ok) {
      if (cas.reason === 'not_found') {
        return sendJson(res, 404, { error: 'illegal transition', status: cas.status });
      }
      const requestId = auditIllegalTransition(client, actor, 'plan.approve_shape', planId, cas.status);
      return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
    }
    const requestId = recordAudit({
      client, actor, action: 'plan.approve_shape', planId, priorStatus: 'shape_ready', result: { http: 202, to_status: 'grooming', edited },
    });
    sendJson(res, 202, { status: 'grooming', request_id: requestId });
    runGroomWorker(planId, edited).catch((err) => {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    });
  }

  async function handleCreate(req, res, planId, client) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });
    if (plan.status !== 'plan_ready') {
      // Body not read on this early path — see handleApproveShape's note;
      // same precedence-preserving reasoning applies here.
      const requestId = auditIllegalTransition(client, null, 'plan.create_tree', planId, plan.status);
      return sendJson(res, 409, { error: 'illegal transition', status: plan.status, request_id: requestId });
    }

    // §5.1/§5.2: actor required on the dashboard token; the typed confirm
    // string ('create-jira-tree <id8>') additionally required on the
    // dashboard token only — bridge-token behavior is unchanged.
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) return sendJson(res, 400, { error: actorResult.error });
    const actor = actorResult.actor;

    if (client === 'dashboard') {
      const confirmErr = confirmError(body, 'create', planId);
      if (confirmErr) return sendJson(res, 400, { error: confirmErr });
    }

    // CAS: a plan rejected (or otherwise moved) while this request's body
    // was streaming can NEVER be pulled back into creating.
    const cas = state.transition(planId, ['plan_ready'], { status: 'creating', updated_at: nowIso() });
    if (!cas.ok) {
      if (cas.reason === 'not_found') {
        return sendJson(res, 404, { error: 'illegal transition', status: cas.status });
      }
      const requestId = auditIllegalTransition(client, actor, 'plan.create_tree', planId, cas.status);
      return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
    }
    const requestId = recordAudit({
      client, actor, action: 'plan.create_tree', planId, priorStatus: 'plan_ready', result: { http: 202, to_status: 'creating' },
    });
    sendJson(res, 202, { status: 'creating', request_id: requestId });
    runCreateWorker(planId).catch((err) => {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    });
  }

  async function handleReject(req, res, planId, client) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });
    if (!REJECTABLE_STATUSES.has(plan.status)) {
      // Body not read on this early path — see handleApproveShape's note.
      const requestId = auditIllegalTransition(client, null, 'plan.reject', planId, plan.status);
      return sendJson(res, 409, { error: 'illegal transition', status: plan.status, request_id: requestId });
    }

    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) return sendJson(res, 400, { error: actorResult.error });
    const actor = actorResult.actor;

    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const stage = typeof body.stage === 'string' ? body.stage : plan.status;
    const priorStatus = plan.status;
    const cas = state.transition(planId, [...REJECTABLE_STATUSES], {
      status: 'rejected',
      reject_reason: reason,
      reject_stage: stage,
      updated_at: nowIso(),
    });
    if (!cas.ok) {
      if (cas.reason === 'not_found') {
        return sendJson(res, 404, { error: 'illegal transition', status: cas.status });
      }
      const requestId = auditIllegalTransition(client, actor, 'plan.reject', planId, cas.status);
      return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
    }
    // §5.3: the trail must show WHY, not just THAT — the submitted reason
    // (nullable — the field is optional on the wire) and the stage.
    const requestId = recordAudit({
      client, actor, action: 'plan.reject', planId, priorStatus, result: { http: 200, reason: reason ?? null, stage },
    });
    return sendJson(res, 200, { status: cas.plan.status, request_id: requestId });
  }

  // Retry a FAILED or BUDGET_BLOCKED plan (transient failure — API balance,
  // network, the daily spend cap). GUARDED (retry write guard): a plan whose create already
  // wrote a real tree to Jira is VERIFIED, never re-created — re-running
  // create-tree --live would write a duplicate tree AND overwrite the record
  // that is the first tree's only cleanup handle. Otherwise resumes
  // deterministically at the phase that failed — judged by artifact presence
  // AND by whether that artifact's deterministic gate actually PASSED (see
  // the ladder below). Reuses the persisted output_language/session/
  // skeleton. This recovers when provider balance runs out mid-groom;
  // budget_blocked is also retryable
  // (the Slack Retry button was already live on it while the handler returned 409).
  async function handleRetry(req, res, planId, client) {
    let plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });
    if (!RETRYABLE_STATUSES.has(plan.status)) {
      // Body not read on this early path (see handleApproveShape's note) —
      // audited as `actor: null`.
      const requestId = auditIllegalTransition(
        client, null, 'plan.retry', planId, plan.status,
        'illegal transition — retry is only valid from failed or budget_blocked',
      );
      return sendJson(res, 409, { error: 'illegal transition — retry is only valid from failed or budget_blocked', status: plan.status, request_id: requestId });
    }

    // §5.2: the one handler-shape change — a tolerant body read. The
    // bridge POSTs retry with NO body at all; readJsonBody already treats
    // a zero-length body as `{}`, so this is additive (actor + audit)
    // without disturbing the bridge's no-body call.
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    // `readJsonBody`'s await is a yield point, and
    // everything below (the created-record guard, the artifact/gate resume
    // ladder) must judge the plan's CURRENT persisted state, not this
    // handler's pre-await snapshot — otherwise a gate/artifact that lands
    // DURING the read (e.g. this same plan's own worker finishing, or a
    // crash-resume) could pick a stale branch. Every branch's own
    // `state.transition` CAS below remains the actual concurrency control
    // on `status` (a status that moved away from RETRYABLE_STATUSES still
    // loses the CAS regardless of which branch this picks); re-fetching
    // here only keeps the ladder's OWN classification fresh — the same
    // class of bug (stale artifact/gate state surviving a retry) this
    // codebase has already hardened against twice (retry write guard, budget-retry behavior).
    plan = state.get(planId) || plan;

    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) return sendJson(res, 400, { error: actorResult.error });
    const actor = actorResult.actor;
    const priorStatus = plan.status;

    const runDir = plan.run_dir || agentRunDir(planId, resultsRoot);

    // The created-tree guard runs BEFORE the artifact-presence ladder below:
    // a created Jira tree exists on the real board regardless of which local
    // artifacts happen to be in runDir, so artifact presence alone must never
    // be allowed to route a marked/recorded plan back into runCreateWorker.
    // Both guard branches reuse the `creating` transient status for the
    // verify-only pass (see runVerifyRecoverWorker's header for why no new
    // status) and end in that worker, whose every exit is a state.update.

    // Case A — create COMPLETED but the post-create --verify hiccuped:
    // runCreateWorker left the plan `failed` WITH plan.created set (full
    // record, verify_ok:false). Re-verify only; a green read-back heals to
    // `created`. A `partial:true` marker means the record is NOT a full
    // tree — that must never take this promote-capable branch (case B owns
    // it: readable ≠ complete).
    if (plan.created && plan.created.record_path && plan.created.partial !== true) {
      const cas = state.transition(planId, [...RETRYABLE_STATUSES], { status: 'creating', error: undefined, updated_at: nowIso() });
      if (!cas.ok) {
        const requestId = auditIllegalTransition(client, actor, 'plan.retry', planId, cas.status);
        return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
      }
      const requestId = recordAudit({
        client, actor, action: 'plan.retry', planId, priorStatus, result: { http: 202, to_status: 'creating' },
      });
      sendJson(res, 202, { status: 'creating', request_id: requestId });
      runVerifyRecoverWorker(planId, { partial: false }).catch((err) => {
        state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
      });
      return;
    }

    // Case B — create-tree died mid-tree: engine.create threw, so the plan
    // has NO created marker, but create-tree's own catch persisted the
    // PARTIAL record to <runDir>/created-record.json before exit 1 —
    // possibly with created:[] when it died before the first Jira POST.
    // Synchronous local read (no await): parse the record; unparseable or
    // any created issues (or a partial marker from a previous pass through
    // this guard) → verify-only, always ends `failed`.
    const recordPath = path.join(runDir, CREATED_RECORD_FILENAME);
    // "The file exists" must be its own fact, never inferred from the parse
    // result: a record file containing the JSON literal `null` parses to
    // `null` — the same value as "no file" — and conflating the two would
    // route a present record through the promote-capable create ladder
    // below (the engine guard would still catch it, but the plan would
    // transiently enter a create pass and surface the engine's wording
    // instead of this guard's). Any PRESENT file that is not a provably
    // clean-empty record routes to case B — the primary guard.
    const recordExists = fs.existsSync(recordPath);
    const record = recordExists ? readJsonIfExists(recordPath) : null; // undefined = unparseable
    const cleanEmptyRecord = record != null && Array.isArray(record.created) && record.created.length === 0;
    const partialMarker = Boolean(plan.created && plan.created.partial === true);
    if (partialMarker || (recordExists && !cleanEmptyRecord)) {
      const cas = state.transition(planId, [...RETRYABLE_STATUSES], { status: 'creating', error: undefined, updated_at: nowIso() });
      if (!cas.ok) {
        const requestId = auditIllegalTransition(client, actor, 'plan.retry', planId, cas.status);
        return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
      }
      // Plant the durable partial marker NOW — synchronously, before
      // anything awaitable. The worker's final state.update re-plants it
      // (idempotent), but if engine.verify REJECTS (spawn failure/timeout
      // on the real engine), every catch on the way down lands a plain
      // `failed` without touching `created` — without this plant, a later
      // record deletion + retry would find neither marker nor record and
      // fall through the ladder into a re-create. Only plantable when the
      // record parsed with real created[] items; a missing/garbage record
      // plants nothing (never fabricate a marker from a record we cannot
      // trust — the partialMarker route already carries its own).
      if (record != null && Array.isArray(record.created) && record.created.length > 0) {
        state.update(planId, {
          created: {
            keys: record.created.map((c) => c.key),
            items: record.created,
            record_path: recordPath,
            verify_ok: false,
            partial: true,
          },
        });
      }
      const requestId = recordAudit({
        client, actor, action: 'plan.retry', planId, priorStatus, result: { http: 202, to_status: 'creating' },
      });
      sendJson(res, 202, { status: 'creating', request_id: requestId });
      runVerifyRecoverWorker(planId, { partial: true }).catch((err) => {
        state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
      });
      return;
    }
    // A record that parses clean with ZERO created issues must NOT block
    // the retry: it proves zero ACKNOWLEDGED Jira writes — the previous
    // attempt died before its first POST /issue response arrived (e.g. the
    // WAL-init record create-tree writes at the top of runLive's try). Not
    // a hard guarantee of zero rows in Jira: a POST that committed
    // server-side with a lost response is invisible to the journal — the
    // documented irreducible residue. Within that limit, a genuinely-
    // incomplete create still retries through the ladder below —
    // engine.create's own guard deliberately allows overwriting an empty
    // record for the same reason. No record at all → ladder unchanged.

    const hasSkeleton = fs.existsSync(path.join(runDir, 'skeleton.json'));
    const hasPlan = fs.existsSync(path.join(runDir, 'plan.json'));

    // Resume at the phase that actually failed — judged by which artifact is
    // missing AND by whether that artifact's deterministic gate PASSED.
    // Artifact presence alone is NOT proof of a completed phase: a plan
    // whose gate FAILED still has the artifact on disk (the workers write it
    // before gating), and without these checks one Retry click routed a
    // gate-FAILED plan straight into runCreateWorker — a real Jira tree from
    // a plan that failed the deterministic gate and was never rendered at
    // ANY human gate (plan_ready was never reached). A missing gate result
    // is treated exactly like a failed one: the phase never provably
    // completed, so re-run it — each worker re-gates its own output.
    // `ok === true` is the whole test: a skipped gate ({ok:true,
    // skipped:true}) stays resumable — the skip knob is an explicit operator
    // override, honored here as everywhere else.
    const skeletonGateOk = Boolean(plan.skeleton_gate && plan.skeleton_gate.ok === true);
    const planGateOk = Boolean(plan.plan_gate && plan.plan_gate.ok === true);

    let target;
    let worker;
    if (!hasSkeleton || !skeletonGateOk) {
      target = 'breaking_down';
      worker = () => runPhase1Worker(planId);
    } else if (!hasPlan || !planGateOk) {
      target = 'grooming';
      worker = () => runGroomWorker(planId, false);
    } else {
      target = 'creating';
      worker = () => runCreateWorker(planId);
    }

    const cas = state.transition(planId, [...RETRYABLE_STATUSES], { status: target, error: undefined, updated_at: nowIso() });
    if (!cas.ok) {
      const requestId = auditIllegalTransition(client, actor, 'plan.retry', planId, cas.status);
      return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
    }
    const requestId = recordAudit({
      client, actor, action: 'plan.retry', planId, priorStatus, result: { http: 202, to_status: target },
    });
    sendJson(res, 202, { status: target, request_id: requestId });
    worker().catch((err) => {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    });
  }

  // Cancel a CREATED tree (cancel flow) — legal from `created` (the normal undo) or
  // `failed` WITH a created record (exactly retry write guard's surfaced partial tree,
  // whose error text otherwise dead-ends at a CLI command; this is the
  // escape hatch on the product surface). The record marker — not the
  // status — is the real precondition: no record means there is nothing on
  // the board to cancel, whatever the status says.
  async function handleCancel(req, res, planId, client) {
    const plan = state.get(planId);
    if (!plan) return sendJson(res, 404, { error: 'not found' });

    // No documented body fields for this build — still validated/drained
    // for a consistent contract (same as handleCreate). Read FIRST (unlike
    // approve-shape/create/reject/retry) — every 409 below already has a
    // real actor to attribute, no `actor: null` carve-out needed here.
    const body = await readJsonBody(req, res);
    if (body === undefined) return;

    const actorResult = validateActor(body.actor, { required: client === 'dashboard' });
    if (actorResult.error) return sendJson(res, 400, { error: actorResult.error });
    const actor = actorResult.actor;

    if (client === 'dashboard') {
      const confirmErr = confirmError(body, 'cancel', planId);
      if (confirmErr) return sendJson(res, 400, { error: confirmErr });
    }

    const recordPath = plan.created && plan.created.record_path;
    if (!recordPath) {
      const requestId = auditIllegalTransition(client, actor, 'plan.cancel', planId, plan.status, 'no created record to cancel');
      return sendJson(res, 409, { error: 'no created record to cancel', status: plan.status, request_id: requestId });
    }
    // Pre-check for a clean 409 message; the CAS below is the actual race
    // control (a plan moved while this request's body was streaming can
    // never be pulled into cancelling — house pattern).
    if (plan.status !== 'created' && plan.status !== 'failed') {
      const requestId = auditIllegalTransition(
        client, actor, 'plan.cancel', planId, plan.status,
        'illegal transition — cancel is only valid from created or failed',
      );
      return sendJson(res, 409, { error: 'illegal transition — cancel is only valid from created or failed', status: plan.status, request_id: requestId });
    }
    const priorStatus = plan.status;
    const cas = state.transition(planId, ['created', 'failed'], { status: 'cancelling', error: undefined, updated_at: nowIso() });
    if (!cas.ok) {
      if (cas.reason === 'not_found') {
        return sendJson(res, 404, { error: 'illegal transition', status: cas.status });
      }
      const requestId = auditIllegalTransition(client, actor, 'plan.cancel', planId, cas.status);
      return sendJson(res, 409, { error: 'illegal transition', status: cas.status, request_id: requestId });
    }
    const requestId = recordAudit({
      client, actor, action: 'plan.cancel', planId, priorStatus, result: { http: 202, to_status: 'cancelling' },
    });
    sendJson(res, 202, { status: 'cancelling', request_id: requestId });
    runCancelWorker(planId).catch((err) => {
      state.update(planId, { status: 'failed', error: errMsg(err), updated_at: nowIso() });
    });
  }

  // -- top-level dispatch ---------------------------------------------------

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://internal.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    const route = matchRoute(req.method, segments);

    if (route.kind === '__not_found') return sendJson(res, 404, { error: 'not found' });
    if (route.kind === '__method_not_allowed') return sendJson(res, 405, { error: 'method not allowed' });

    // §5.1: classifies WHICH bearer authenticated this request (or, absent
    // a primary token, that auth is disabled entirely — today's dev-mode
    // behavior, byte-identical to before the API extension). `client` feeds the audit
    // ledger's unforgeable `client` field and the actor-required rule.
    let client = 'api';
    if (route.kind !== 'healthz') {
      const header = req.headers['authorization'] || '';
      const auth = classifyClient(header, token, dashboardToken);
      if (!auth.authorized) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      client = auth.client;
    }

    switch (route.kind) {
      case 'healthz':
        {
          const telemetryLock = breakers.getCostTelemetryLock(resultsRoot);
        return sendJson(res, 200, {
          ok: true,
          version: SERVICE_VERSION,
          engine: engineMode,
          daily_spend_usd: telemetryLock ? null : breakers.getDailySpend(resultsRoot),
          cost_telemetry_locked: Boolean(telemetryLock),
          ...(telemetryLock ? { cost_telemetry_status: 'locked' } : {}),
        });
        }
      case 'list_plans':
        return handleListPlans(req, res, url.searchParams);
      case 'plans_summary':
        return handlePlansSummary(req, res);
      case 'get_audit':
        return handleAudit(req, res, url.searchParams);
      case 'create_plan':
        return handleCreatePlan(req, res, client);
      case 'get_plan':
        return handleGetPlan(req, res, route.planId);
      case 'approve-shape':
        return handleApproveShape(req, res, route.planId, client);
      case 'create':
        return handleCreate(req, res, route.planId, client);
      case 'reject':
        return handleReject(req, res, route.planId, client);
      case 'retry':
        return handleRetry(req, res, route.planId, client);
      case 'cancel':
        return handleCancel(req, res, route.planId, client);
      case 'surface':
        return handleSurface(req, res, route.planId);
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // Last-resort guard: a handler bug must never crash the process or
      // hang the socket.
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error', detail: errMsg(err) });
      } else {
        res.end();
      }
    });
  });

  return {
    server,
    listen(port, bind) {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        try {
          server.listen(port, bind, () => {
            server.off('error', onError);
            resolve(server.address());
          });
        } catch (err) {
          server.off('error', onError);
          reject(err);
        }
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    // exposed for tests that want direct state/engine access
    _state: state,
    _engine: engine,
  };
}

// -- auto-start when run directly: `node service/server.mjs` ----------------

// Fail-closed boot gate. Binds where only this machine
// can reach the socket; anything else must carry real bearer auth.
const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.MERCURY_PORT || 8090);
  const bind = process.env.MERCURY_BIND || '127.0.0.1';
  const bootToken = process.env.MERCURY_SERVICE_TOKEN;
  // TRIMMED before the absent check: a whitespace-only token (a quoting
  // accident in a deploy config) is not a credential any client could
  // meaningfully present — fail closed on it exactly like the empty string.
  const tokenAbsent = bootToken === undefined || bootToken.trim() === '';

  // Fail-closed boot: an unset MERCURY_SERVICE_TOKEN used to
  // silently DISABLE auth and an empty one only warned — fine on loopback
  // (only this machine can connect; today's behavior is kept, including
  // createServer's empty-token WARN), fatal on any other bind: a
  // non-loopback listen with no real token is an unauthenticated planner
  // API that can write to the real Jira board. Refuse to boot BEFORE
  // listening. MERCURY_REQUIRE_AUTH=1 is the belt-and-suspenders override
  // (the container sets it): a real token is required regardless of bind,
  // so even a loopback-bound container process cannot run authless.
  if (tokenAbsent && process.env.MERCURY_REQUIRE_AUTH === '1') {
    // eslint-disable-next-line no-console
    console.error('[mercury] FATAL: MERCURY_REQUIRE_AUTH=1 but MERCURY_SERVICE_TOKEN is missing or empty — a real token is required regardless of bind. Refusing to boot.');
    process.exit(1);
  }
  if (tokenAbsent && !LOOPBACK_BINDS.has(bind)) {
    // eslint-disable-next-line no-console
    console.error(`[mercury] FATAL: MERCURY_BIND=${bind} is not loopback and MERCURY_SERVICE_TOKEN is missing or empty — refusing to expose an unauthenticated planner API. Set a real token, or bind to 127.0.0.1.`);
    process.exit(1);
  }

  // env-only Jira credential invariant / child-env isolation: on a server the Jira credential must be env-only.
  // The ~/.config/mercury/jira-token file fallback (which every
  // create-tree.mjs control-plane spawn would happily read) is a laptop
  // convenience — a token FILE sitting on a server/volume outlives env
  // rotation and widens the at-rest credential surface. The container sets
  // MERCURY_REQUIRE_ENV_ONLY_TOKEN=1; under it, a present fallback file is
  // a boot-time fatal, not a warning someone scrolls past.
  if (process.env.MERCURY_REQUIRE_ENV_ONLY_TOKEN === '1') {
    const jiraTokenFile = path.join(os.homedir(), '.config', 'mercury', 'jira-token');
    if (fs.existsSync(jiraTokenFile)) {
      // eslint-disable-next-line no-console
      console.error(`[mercury] FATAL: MERCURY_REQUIRE_ENV_ONLY_TOKEN=1 but the file-fallback Jira token exists at ${jiraTokenFile} — on a server the token must be env-only (MERCURY_JIRA_TOKEN). Delete the file. Refusing to boot.`);
      process.exit(1);
    }
  }

  const app = createServer();
  app.listen(port, bind).then((addr) => {
    const engineMode = process.env.MERCURY_ENGINE === 'fake' ? 'fake' : 'real';
    // eslint-disable-next-line no-console
    console.log(`[mercury] planner service listening on http://${bind}:${addr.port} (engine=${engineMode})`);
  });
}
