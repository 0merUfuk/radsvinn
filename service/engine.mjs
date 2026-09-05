// engine.mjs — createEngine(mode) -> { phase1, groom, create, verify, cleanup, search }.
//
// fake mode: deterministic, zero subprocess, zero network — copies the
// bundled offline fixtures and returns canned accounting charges. Those
// values exercise breaker and persistence paths; they are not provider spend.
//
// real mode: the operator-configured deployment path shells the selected
// agent runtime headlessly. Automated tests cover prompt/argv construction,
// credential stripping, provider selection, and metering through pure seams
// and local fakes; they do not invoke an external agent CLI, provider,
// tracker, Slack socket, or remote-grounding network.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MERCURY_ROOT } from './state.mjs';
import { reposRoot } from './grounding.mjs';
import { resolveCouplingMapPath } from './coupling-map.mjs';
import { buildClaudeArgs as buildClaudeRuntimeArgs } from './runtimes/claude.mjs';
import { resolveRuntime } from './runtimes/registry.mjs';
import {
  CostTelemetryError,
  MeteredPhaseError,
  openRouterChildEnv,
  resolveLlmRuntime,
  startOpenRouterMeterProxy,
} from './openrouter-meter.mjs';

const FIXTURE_SKELETON = path.join(MERCURY_ROOT, 'fixtures', 'e2e-sample', 'skeleton.json');
const FIXTURE_PLAN = path.join(MERCURY_ROOT, 'fixtures', 'e2e-sample', 'plan.json');

// Single source of truth for the per-plan create record's filename — BOTH
// engines write <runDir>/created-record.json, and server.mjs's retry guard
// checks the exact same path. The fake engine used to write a differently-
// named `fake-created-record.json`, which would have silently exempted every
// fake-mode test from that guard's on-disk record check — the fake must be
// structurally identical to the real thing where the safety logic looks.
export const CREATED_RECORD_FILENAME = 'created-record.json';

// Control-plane create-tree spawns are API round-trips, not LLM calls.
const CREATE_TIMEOUT_MS = 5 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 2 * 60 * 1000;
// Cleanup does two Jira round-trips per recorded issue (GET transitions +
// POST transition, children before parents) — same control-plane ceiling as
// create, which does one POST per issue plus links/comments.
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

export function createEngine(mode, options = {}) {
  // Existing callers keep the live process.env object (including tests that
  // deliberately toggle a fault after construction). Isolated callers such
  // as the demo can inject a clean env without mutating process-global state.
  return mode === 'fake' ? createFakeEngine(options.env ?? process.env) : createRealEngine();
}

// Defense-in-depth for BOTH engines' create, run before any spawn/write:
// server.mjs's retry guard is the primary control against re-creating an
// already-written tree, but this is the last line before real Jira POSTs, so
// it must hold even if some future caller reaches engine.create another way.
// An existing record with ANY created issues means a previous attempt already
// wrote to Jira — re-running create would duplicate that tree AND overwrite
// the record, orphaning the first tree's only cleanup handle. Fail closed on
// a record we cannot parse (corruption hides an unknown number of writes).
// The one safe case: a record that parses clean with ZERO created issues
// proves the previous attempt died before its first acknowledged Jira write
// (the WAL-init record create-tree writes at the top of runLive's try,
// before the first POST /issue succeeded) — overwriting it is fine, and a
// genuinely-incomplete create must still be retryable.
function guardExistingRecord(recordPath) {
  if (!fs.existsSync(recordPath)) return;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (err) {
    throw new Error(`create: a created-record already exists at ${recordPath} (unparseable: ${err.message}) — refusing to re-create; verify or cleanup the existing tree first`);
  }
  const created = record && Array.isArray(record.created) ? record.created : null;
  if (created === null || created.length > 0) {
    const why = created === null ? 'no created[] array — treating as corrupt' : `${created.length} issue(s) already recorded`;
    throw new Error(`create: a created-record already exists at ${recordPath} (${why}) — refusing to re-create; verify or cleanup the existing tree first`);
  }
  // created: [] — zero Jira writes happened; safe to overwrite and proceed.
}

// ---------------------------------------------------------------------------
// FAKE ENGINE
// ---------------------------------------------------------------------------

function createFakeEngine(env) {
  return {
    async phase1({ runDir }) {
      fs.mkdirSync(runDir, { recursive: true });
      fs.copyFileSync(FIXTURE_SKELETON, path.join(runDir, 'skeleton.json'));
      // Phase-timing stubs (2026-07-11): plausible, DETERMINISTIC values so
      // the server's phase log line is assertable in tests — never real
      // clock reads (the fake must stay byte-reproducible).
      return { sessionId: `fake-${randomUUID()}`, costUsd: 0.8, resultText: '[fake] shape presented', durationMs: 0, numTurns: 1, model: 'fake' };
    },
    async groom({ runDir, sessionId }) {
      if (env.MERCURY_FAKE_GROOM_FAIL === '1') {
        // Simulate the pilot's real failure: groom dies mid-flight (API
        // balance ran out) — skeleton.json is on disk, plan.json is not.
        throw new Error('[fake] groom failed — API balance exhausted');
      }
      if (env.MERCURY_FAKE_GROOM_TRUNCATED === '1') {
        // B5 fail-closed knob: groom hit the light `--max-turns` cap mid-write.
        // Claude Code exits non-zero when the agentic loop is truncated, so the
        // real engine's runClaudeSpawn REJECTS — model that here as a throw
        // with a max-turns-shaped message. plan.json is deliberately NOT
        // written, so runGroomWorker's gate step fails closed → `failed`,
        // never a silently-truncated `plan_ready`. Mirrors GROOM_FAIL above;
        // nothing else in the fake changes.
        throw new Error('[fake] groom exceeded --max-turns before it finished writing plan.json');
      }
      fs.mkdirSync(runDir, { recursive: true });
      fs.copyFileSync(FIXTURE_PLAN, path.join(runDir, 'plan.json'));
      return { sessionId, costUsd: 0.9, resultText: '[fake] plan groomed', durationMs: 0, numTurns: 1, model: 'fake' };
    },
    async create({ runDir }) {
      fs.mkdirSync(runDir, { recursive: true });
      const recordPath = path.join(runDir, CREATED_RECORD_FILENAME);
      // Same last-line guard as the real engine — the fake must refuse to
      // "re-create" over an existing tree's record exactly like the real one.
      guardExistingRecord(recordPath);
      if (env.MERCURY_FAKE_CREATE_FAIL === '1') {
        // Models create-tree dying with NO record on disk — post-WAL that
        // means before runLive's try even starts (e.g. the pre-try GET
        // /project resolution, or a missing token) — contrast
        // MERCURY_FAKE_CREATE_PARTIAL below. The message must NOT direct an
        // operator at a record/--cleanup for a record that does not exist.
        throw new Error('[fake] live create failed before any record was written');
      }
      // Attach mode (2026-07-10, the duplicate-epic fix): mirror the real
      // create-tree's existing_key behavior in the RECORD SHAPE, so
      // service-level tests can prove the wire — a plan.json whose epic
      // carries existing_key produces a record with `attached_epic` set and
      // NO Epic entry in created[] (cleanup/cancel sweep created[] only and
      // must never transition an epic Mercury did not create). Deliberately
      // cheap: read + branch; the fake still fabricates keys as ever. The
      // pre-fix fake never read plan.json at all, so a missing/unreadable
      // one stays non-fatal here (unlike the real engine, which requires
      // plan.json before spawning create-tree).
      let attachedEpic = null;
      try {
        const plan = JSON.parse(fs.readFileSync(path.join(runDir, 'plan.json'), 'utf8'));
        const k = plan && plan.epic && plan.epic.existing_key;
        if (typeof k === 'string' && k.trim().length > 0) {
          attachedEpic = { temp_id: plan.epic.temp_id, key: k.trim(), summary: plan.epic.summary || '' };
        }
      } catch {
        // no plan.json (some unit setups call create directly) — old path.
      }
      const record = attachedEpic
        ? { created: [{ temp_id: 'i1', key: 'PROJ-1000', type: 'Task', summary: 'fake' }], links: [], attached_epic: attachedEpic }
        : { created: [{ temp_id: 'e1', key: 'PROJ-999', type: 'Epic', summary: 'fake' }], links: [] };
      if (env.MERCURY_FAKE_CREATE_PARTIAL === '1') {
        // Mirrors the real throw-path: create-tree's catch block persists the
        // PARTIAL record to --out before exit 1 (create-tree.mjs runLive), so
        // the fake writes the record FIRST and throws after — one real issue
        // is on the board with only this file as its cleanup handle.
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
        throw new Error('[fake] live create failed mid-tree — partial record persisted; inspect the record and run --cleanup');
      }
      fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
      return {
        recordPath,
        created: record.created,
        // Attach mode: surfaced on the return so runCreateWorker can lift it
        // into the plan's created marker and createdMessage can render the
        // attach target. Key absent entirely
        // when not attaching — mirrors the record shape and the real engine.
        ...(attachedEpic ? { attached_epic: attachedEpic } : {}),
        // MERCURY_FAKE_VERIFY_FAIL drives the "create COMPLETED but the
        // post-create --verify hiccuped" outcome through the normal worker
        // path — runCreateWorker lands that as `failed` WITH plan.created
        // set, which is exactly the retry guard's case-A precondition.
        verifyOk: env.MERCURY_FAKE_VERIFY_FAIL === '1' ? false : true,
        costUsd: 0,
        resultText: attachedEpic
          ? `[fake] CREATED Task PROJ-1000 under attached epic ${attachedEpic.key} — record: ${recordPath}`
          : `[fake] CREATED Epic PROJ-999 — record: ${recordPath}`,
      };
    },
    async verify({ recordPath }) {
      if (env.MERCURY_FAKE_VERIFY_REJECT === '1') {
        // Mirrors the REAL engine's only reject path: runToolSpawn REJECTS
        // on spawn failure/timeout (a non-zero exit merely resolves
        // ok:false). The retry guard's handler/worker catches must survive
        // this THROW without losing the partial marker — which is exactly
        // why handleRetry plants the marker before anything awaitable.
        throw new Error('[fake] verify spawn failed');
      }
      if (env.MERCURY_FAKE_VERIFY_FAIL === '1') return { ok: false, output: '[fake] verify failed' };
      if (!fs.existsSync(recordPath)) return { ok: false, output: '[fake] record not found' };
      // Mirrors the real --verify, which dies (exit 1) on readJSON over a
      // garbage record — a fake that verified garbage green would diverge
      // from reality exactly where the retry guard leans on it.
      try {
        JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      } catch {
        return { ok: false, output: '[fake] record unparseable' };
      }
      return { ok: true, output: '[fake] verify OK' };
    },
    async cleanup({ recordPath }) {
      if (env.MERCURY_FAKE_CLEANUP_FAIL === '1') {
        // Models a sweep with HARD failures (network down, token revoked,
        // board-wide 429): the real tool counts every transitions-read
        // error and transition-POST failure and exits 1 when any occurred,
        // which engine.cleanup reports as exactly this ok:false. The benign
        // no-matching-transition skip (an already-terminal issue) stays
        // exit 0 and is invisible at this level by design — see the real
        // cleanup's exit-semantics note.
        return { ok: false, output: '[fake] cleanup failed' };
      }
      if (!fs.existsSync(recordPath)) return { ok: false, output: '[fake] record not found' };
      let record;
      try {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      } catch {
        return { ok: false, output: '[fake] record unparseable' };
      }
      // Mirrors the real runCleanup's sweep summary: N comes from the
      // record's created[] (the real tool transitions exactly those issues,
      // children before parents). A record with no created[] sweeps zero
      // issues and still "succeeds" — same as the real tool over created:[].
      const n = record && Array.isArray(record.created) ? record.created.length : 0;
      return { ok: true, output: `[fake] cleanup OK — ${n} issue(s) transitioned` };
    },
    async search() {
      return { ok: true, output: 'no matches (fake)' };
    },
  };
}

// ---------------------------------------------------------------------------
// REAL ENGINE
// ---------------------------------------------------------------------------

function createRealEngine() {
  // Resolve at construction, before the HTTP server begins accepting work.
  // This validates both independent axes without sending provider traffic;
  // the first external request remains the first planning phase.
  const agentRuntime = resolveRuntime();
  // Codex owns its OpenAI OAuth/provider path, so MERCURY_LLM_PROVIDER is
  // intentionally irrelevant outside provider-configurable runtimes.
  const providerRuntime = agentRuntime.id === 'claude'
    ? resolveLlmRuntime()
    : { provider: 'runtime-managed' };
  return {
    async phase1({ runDir, ask, requester, roleLens, outputLanguage, scopeHint, groundingHint, regen }) {
      const userMessage = phase1Message({ ask, requester, roleLens, runDir, outputLanguage, scopeHint, groundingHint, regen });
      // groundingHint rides into runPhase too: `light` adds a flat Phase-1
      // --max-turns cap; Groom gets a plan-size-scaled cap (see buildClaudeArgs).
      // B1: `regen` (present
      // only on a bounded-regen re-entry) makes runPhase --resume the FAILED
      // session so the model sees its own rejected skeleton — composed ALONGSIDE
      // groundingHint, not in place of it.
      return runPhase({ kind: 'phase1', runDir, userMessage, groundingHint, regen, agentRuntime, providerRuntime });
    },
    async groom({ runDir, sessionId, edited, outputLanguage, groundingHint, itemCount, regenComplaints }) {
      const userMessage = groomMessage({ edited, runDir, outputLanguage, groundingHint, regenComplaints });
      // groundingHint rides into runPhase too: `light` adds the groom
      // `# GROUNDING` directive (via groomMessage above) AND the
      // plan-size-scaled --max-turns cap to the argv (see buildClaudeArgs —
      // B5, the groom half of Light). itemCount sizes that cap
      // (base + perItem × n).
      // When complaints are present this is a bounded groom regeneration. The
      // prompt already carries the complaints; this signal selects the rejected
      // plan.json as cold-resume context if the runtime session cannot resume.
      const groomRegen = regenComplaints ? { sessionId } : undefined;
      return runPhase({
        kind: 'groom',
        runDir,
        sessionId,
        userMessage,
        groundingHint,
        itemCount,
        regen: groomRegen,
        agentRuntime,
        providerRuntime,
      });
    },
    // Phase 3 is a CONTROL-PLANE operation — no agent, no LLM (adjudicated
    // 2026-07-08, superseding this file's earlier "open decision" note). By
    // create time the service holds gate-verified plan.json + skeleton.json
    // in runDir; creation is deterministic:
    //   node tools/create-tree.mjs --plan <runDir>/plan.json --scope full --live
    //   node tools/create-tree.mjs --verify <recordPath>
    // The tool loads the Jira token itself (env or ~/.config/mercury/
    // jira-token); the service never touches a credential, and no untrusted
    // text goes anywhere near an LLM in the only step that writes to Jira.
    // This keeps the tracker credential inside the deterministic control
    // plane rather than the planning agent.
    async create({ runDir }) {
      const planPath = path.join(runDir, 'plan.json');
      if (!fs.existsSync(planPath)) throw new Error(`create: plan.json missing in ${runDir}`);

      // Plan-scoped record path via --out: two concurrent plans can never
      // misattribute each other's created-Jira records; a newest-file fallback
      // would be racy by construction.
      const recordPath = path.join(runDir, CREATED_RECORD_FILENAME);
      // Last line before real Jira writes: never re-create over an existing
      // tree's record (see guardExistingRecord — the retry write guard).
      guardExistingRecord(recordPath);
      const live = await runToolSpawn(
        ['node', 'tools/create-tree.mjs', '--plan', planPath, '--scope', 'full', '--live', '--out', recordPath],
        CREATE_TIMEOUT_MS,
      );
      if (live.code !== 0) {
        // create-tree persists a partial record and prints the --cleanup
        // command on half-failures — surface that text to the human.
        throw new Error(`live create failed (exit ${live.code}). Output tail:\n${(live.stdout + '\n' + live.stderr).slice(-2000)}`);
      }
      if (!fs.existsSync(recordPath)) {
        throw new Error(`live create exited 0 but the record is missing at ${recordPath}. stdout tail:\n${live.stdout.slice(-2000)}`);
      }
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));

      const verify = await runToolSpawn(
        ['node', 'tools/create-tree.mjs', '--verify', recordPath],
        VERIFY_TIMEOUT_MS,
      );

      return {
        recordPath,
        created: record.created || [],
        // Attach mode: create-tree journals the pre-existing epic OUTSIDE
        // created[] as attached_epic (cleanup must never sweep it) — lift it
        // onto the return so the worker's created marker and createdMessage
        // can surface the attach target.
        ...(record.attached_epic ? { attached_epic: record.attached_epic } : {}),
        verifyOk: verify.code === 0,
        costUsd: 0, // deterministic control-plane step — no LLM spend
        resultText: live.stdout.slice(-2000),
      };
    },
    // Standalone verify readback over an existing record — the retry guard's
    // recovery path (server.mjs runVerifyRecoverWorker) re-checks an already-
    // created tree WITHOUT touching create. A non-zero exit is an answer
    // (`ok:false`), never a throw; only a spawn failure/timeout rejects, and
    // the worker's catch handles that like any other async error.
    async verify({ recordPath }) {
      const res = await runToolSpawn(
        ['node', 'tools/create-tree.mjs', '--verify', recordPath],
        VERIFY_TIMEOUT_MS,
      );
      return { ok: res.code === 0, output: (res.stdout + '\n' + res.stderr).slice(-2000).trim() };
    },
    // Cancel-the-tree over an existing record — cancel flow's Slack cancel path
    // (server.mjs runCancelWorker). CONTROL-PLANE like create/verify: no
    // agent, no LLM; create-tree.mjs --cleanup owns the Jira transitions
    // (cancel-only, children before parents, locale-aware — NEVER delete).
    // Same shape as engine.verify: a non-zero exit is an answer (`ok:false`),
    // never a throw; only a spawn failure/timeout rejects, and the worker's
    // catch handles that like any other async error.
    //
    // EXIT SEMANTICS — exit 0 means "the sweep ran with ZERO hard
    // failures": create-tree.mjs runCleanup counts a transitions-read
    // error (⚠) or a transition-POST failure (✗) per issue, keeps
    // sweeping, and exits 1 when any occurred — so ok:false genuinely
    // fires on network-down / revoked-token sweeps. The benign "no
    // matching transition" skip (an issue already in a terminal state)
    // stays exit 0, which is what keeps the Slack re-click idempotent.
    // Per-issue results are in the output tail; do NOT parse them here.
    async cleanup({ recordPath }) {
      const res = await runToolSpawn(
        ['node', 'tools/create-tree.mjs', '--cleanup', recordPath, '--live'],
        CLEANUP_TIMEOUT_MS,
      );
      return { ok: res.code === 0, output: (res.stdout + '\n' + res.stderr).slice(-2000).trim() };
    },
    // Advisory duplicate search at plan_ready time. Never throws — a missing
    // token or network failure degrades to { ok:false } and the human gate
    // remains the control.
    async search({ terms }) {
      try {
        const res = await runToolSpawn(
          ['node', 'tools/create-tree.mjs', '--search', terms],
          SEARCH_TIMEOUT_MS,
        );
        return { ok: res.code === 0, output: (res.stdout + (res.code === 0 ? '' : '\n' + res.stderr)).slice(-2000).trim() };
      } catch (err) {
        return { ok: false, output: `search unavailable: ${err.message}`.slice(0, 500) };
      }
    },
  };
}

// Generic argv-array tool spawn (never a shell — `terms` can embed untrusted
// ask-derived text). Resolves { code, stdout, stderr }; rejects only on
// spawn failure or timeout.
function runToolSpawn(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: MERCURY_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${args.join(' ').slice(0, 120)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn ${args[0]}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The HARD scope directives prevent over-expansion: the decomposer prompt's
// own "never inflate a small ask into ceremony"
// rule proved to be vibes, not a constraint — the agent kept inflating simple
// asks into Epics. scope_hint is the REQUESTER's sizing decision; when it is
// not `auto` it is injected as a `# SCOPE` block that overrides the agent's
// own size judgment (documented in prompts/decomposer.md §Scope directive).
// One-node skeletons are already legal at the deterministic gate
// (internal/checks/skeleton.go: a standalone L0 item with `epic: null`,
// `milestones: []` passes every check), so `single` needs no gate change.
// Null-prototype: the lookup below is `SCOPE_DIRECTIVES[scopeHint]`, and a
// plain object literal inherits Object.prototype — a scopeHint of
// 'constructor'/'toString' would resolve to a truthy inherited member and
// inject its stringification into the model prompt. Server-side enum
// validation blocks that through the service, but the exported phase1Message
// seam reaches this lookup with arbitrary strings; a prototype-less map makes
// every non-directive key miss cleanly (→ inject nothing).
const SCOPE_DIRECTIVES = Object.assign(Object.create(null), {
  single: 'single — produce a ONE-NODE skeleton: epic null, milestones [], exactly one item — do NOT decompose further.',
  small: 'small — produce 2-5 items, epic null — no epic ceremony.',
  epic: 'epic — a large ask: a full epic breakdown is expected.',
});

// `auto`, absent, or (defensively) unknown → inject nothing: the prompt's
// own decomposition rules stand. Server-side validation means an unknown
// value cannot reach here through the service, but this seam is exported.
function scopeDirective(scopeHint) {
  const directive = SCOPE_DIRECTIVES[scopeHint];
  if (!directive) return [];
  return [
    '# SCOPE',
    directive,
    "This is the requester's own sizing decision and it OVERRIDES your size judgment.",
    '',
  ];
}

// The grounding-depth directive (2026-07-11 — the repo-reading-tax fix):
// every decompose pays for the agent's Grep/Read exploration across the
// grounding repos in tool-loop TURNS, which drives both cost and latency —
// a trivial ask ("rotate an API key") paid nearly the same as a deep one.
// grounding_hint is the REQUESTER's opt-in depth decision; `light` injects
// this `# GROUNDING` block into the phase-1 message. `full` (the default)
// and absent inject NOTHING, so today's behavior stays byte-identical —
// under-grounding a task that needed it silently degrades ticket quality
// (the asymmetric failure mode), so Light is always opt-in, never a silent
// default. Null-prototype for the same reason as SCOPE_DIRECTIVES above:
// the exported phase1Message seam reaches this lookup with arbitrary
// strings, and 'constructor'/'toString' must miss cleanly.
const GROUNDING_DIRECTIVES = Object.assign(Object.create(null), {
  light: [
    'light — MINIMIZE code exploration for this plan. Lean on the coupling map and the ask itself',
    'for structure. Read at most a FEW files, and only to confirm the one or two most important',
    'code anchors; do NOT exhaustively grep or crawl the repos. It is acceptable for this plan to',
    'carry fewer code_anchors than a fully grounded plan would.',
  ].join('\n'),
});

// `full`, absent, or (defensively) unknown → inject nothing — see the
// map's header note: the default MUST stay full-depth.
function groundingDirective(groundingHint) {
  const directive = GROUNDING_DIRECTIVES[groundingHint];
  if (!directive) return [];
  return [
    '# GROUNDING',
    directive,
    "This is the requester's own depth decision and it OVERRIDES your default grounding thoroughness.",
    '',
  ];
}

// The groom-phase grounding directive (B5, 2026-07-13 — the groom half of the
// Light control). Groom RESUMES the phase-1 session (buildClaudeArgs: resume →
// `--resume <sessionId>`), so a light plan's grounding was already done in
// decompose — yet groom, left uncapped by the original decompose-only cap,
// re-crawled the repos PER ITEM (49 turns / $1.61, 94% of a real Light 4-item
// plan's bill). This directive tells the resumed session to reuse that
// grounding instead of re-exploring, while keeping every anchor real — the
// cap reduces exploration, not verification rigor (the deterministic gate
// still checks every anchor). Distinct from GROUNDING_DIRECTIVES because the
// wording is about RESUMING a session, not doing a first pass. Same
// null-prototype guard: the exported groomMessage seam reaches this lookup
// with arbitrary strings, and 'constructor'/'toString' must miss cleanly.
const GROOM_GROUNDING_DIRECTIVES = Object.assign(Object.create(null), {
  light: [
    'light — this plan RESUMES the grounding already done in Phase 1 — reuse the coupling map and',
    'the anchors/context already in this session; do NOT re-crawl or re-grep the repos per item;',
    'read at most 1-2 files TOTAL for the entire plan, and only when not already confident an',
    'anchor is correct; every code_anchor must still be real — this reduces exploration, not',
    'verification rigor.',
  ].join('\n'),
});

// `full`, absent, or (defensively) unknown → inject nothing — groom's default
// stays full thoroughness, the same asymmetric-default rule as
// groundingDirective (under-grooming silently degrades the fields the create
// gate approves).
function groomGroundingDirective(groundingHint) {
  const directive = GROOM_GROUNDING_DIRECTIVES[groundingHint];
  if (!directive) return [];
  return [
    '# GROUNDING',
    directive,
    "This is the requester's own depth decision and it OVERRIDES your default grooming thoroughness.",
    '',
  ];
}

// ---------------------------------------------------------------------------
// Service-mode tool posture (2026-07-11 — the wasted-turns fix)
// ---------------------------------------------------------------------------
// EVIDENCE (a live plan's stored agent_summary): the shared agent workflow
// (`.claude/agents/jira-planner.md`) is written for the INTERACTIVE path —
// a human-supervised session that really holds Bash/Write — and orders the
// agent to `git fetch origin main`, Write the artifact JSON to disk, and
// run `go run ./cmd/treecheck`. Under this service's safe default allowlist
// (Read,Grep,Glob — buildClaudeArgs) every one of those is DENIED, and each
// denied attempt is a full model round-trip on a growing context (~6-12
// wasted turns per phase, observed live). The service already owns all
// three jobs control-plane:
//   - freshness: fetchGroundingRepos() runs at the top of runPhase1Worker
//     (server.mjs) and the container entrypoint fetch+resets every
//     grounding repo — the agent's own git-fetch is fully redundant;
//   - persistence: runPhase extracts the artifact from the fenced ```json
//     block when the agent's Write didn't land (extractJsonArtifact);
//   - the gate: gates.mjs runs treecheck server-side, and service mode has
//     NO in-session regen loop — an agent-side gate run buys nothing.
// So the per-call service messages tell the agent its real posture up
// front. Service-message-only BY DESIGN: the shared prompt files and the
// agent definition stay untouched — the interactive path legitimately
// fetches, writes, and gates.
//
// The directive is derived from — and conditional on — the SAME allowlist
// resolution buildClaudeArgs uses: if an operator deliberately loosens the
// posture (Bash or Write present), the directive would be false, so inject
// nothing and let the workflow's own steps run. An EMPTY allowlist passes
// no --allowedTools flag at all (CLI defaults apply) — also inject nothing
// rather than claim "no tools".
function resolvedAllowedTools() {
  return (process.env.MERCURY_AGENT_ALLOWED_TOOLS ?? 'Read,Grep,Glob')
    .split(',').map((t) => t.trim()).filter(Boolean);
}

function serviceToolsDirective() {
  const tools = resolvedAllowedTools();
  if (tools.length === 0 || tools.includes('Bash') || tools.includes('Write')) return [];
  return [
    '# TOOLS',
    `Your tools in this run are ${tools.join(', ')} ONLY. Do NOT attempt`,
    '`git fetch`, the Write tool, or Bash/shell commands (including',
    '`treecheck`) — they are disabled here, and every denied attempt wastes a turn.',
    'The service has already fetched fresh grounding repos, will extract your',
    'JSON artifact from the fenced block described below, and runs the',
    `deterministic gate itself. Ground your analysis with ${tools.join('/')};`,
    'emit the complete JSON verbatim in a fenced ```json block; run your',
    "prompt's self-check as PROSE reasoning, not by invoking a tool.",
    '',
  ];
}

// ---------------------------------------------------------------------------
// Coupling-map injection (2026-07-11 — the broken-promise fix)
// ---------------------------------------------------------------------------
// prompts/decomposer.md §Inputs promises the agent an injected coupling-map
// slice ("the no-go zones (always) + entries relevant to this ask") —
// but nothing ever injected it, so every decompose burned a tool-loop turn
// Reading the whole file itself, and the no-go-zone (MONEY-SAFETY)
// stanzas — e.g. Account.balance's multi-writer columns with no single
// owner — were in front of the agent only IF it chose to do
// that read. Injecting the map here delivers the same data without the
// turn AND makes the money-safety stanzas UNCONDITIONALLY present in every
// phase-1 prompt. The FULL map, not a computed slice: it is ~3-4K tokens —
// cheaper than the turn it replaces — and ask-relevance slicing would add
// logic for negligible savings.
//
// Read ONCE per resolved path and cached at module scope (the map ships
// with the deploy image; it cannot change mid-run). Missing, unreadable, or
// implausibly oversized → a graceful fallback note, NEVER a throw (a laptop
// or test checkout without the file must still plan); the miss is cached
// too — re-probing a missing file once per plan buys nothing.
// MERCURY_COUPLING_MAP overrides the path (absolute, or resolved against
// the mercury repo root) — an operational knob and the unit-test seam.
const COUPLING_MAP_MAX_BYTES = 128 * 1024; // ~10x today's map — a runaway file must never multiply every plan's prompt spend
const couplingMapCache = new Map(); // resolved path -> file text | null (null = degrade to the fallback note)

function loadCouplingMap() {
  const mapPath = resolveCouplingMapPath();
  if (!couplingMapCache.has(mapPath)) {
    let text = null;
    try {
      const raw = fs.readFileSync(mapPath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') <= COUPLING_MAP_MAX_BYTES) text = raw.trimEnd();
    } catch {
      // missing/unreadable — the fallback note in couplingMapBlock covers it
    }
    couplingMapCache.set(mapPath, text);
  }
  return couplingMapCache.get(mapPath);
}

function couplingMapBlock() {
  const map = loadCouplingMap();
  if (map === null) {
    // Graceful degradation: the agent still holds the Read tool — fall back
    // to the pre-fix behavior (self-read) instead of planning blind.
    return [
      '# COUPLING MAP',
      'Not injected this run (the map file was missing or unreadable). If',
      'coupling-map.yaml exists in your working directory, Read it before',
      'decomposing; otherwise derive seams from the ask and the repos alone.',
      '',
    ];
  }
  return [
    '# COUPLING MAP',
    'This is the full coupling map (no-go zones + module edges) — use it for',
    'structural seams and coupling-zone routing; you do NOT need to Read',
    'coupling-map.yaml yourself.',
    '',
    map,
    '',
  ];
}

// Load and cache the prompt body. Read once per resolved path (the prompts
// ship with the deploy image; they cannot change mid-run). Missing/unreadable
// → a graceful fallback note, NEVER a throw (a laptop without the file should
// not crash; the gate validates output regardless). Same discipline as
// couplingMapBlock().
const promptBodyCache = new Map();
export function loadPromptBody(promptPath) {
  if (promptBodyCache.has(promptPath)) return promptBodyCache.get(promptPath);
  try {
    const body = fs.readFileSync(promptPath, 'utf8').trim();
    promptBodyCache.set(promptPath, body);
    return body;
  } catch {
    const note = `[prompt body unavailable at ${promptPath} — emit valid JSON per the contract schema]`;
    promptBodyCache.set(promptPath, note);
    return note;
  }
}

// ---------------------------------------------------------------------------
// Bounded-regeneration complaint block (B1, 2026-07-13)
// ---------------------------------------------------------------------------
// The SERVICE composes the DETERMINISTIC gate's complaint text into the
// per-call message as the exact block the shared prompt already recognizes:
// decomposer.md §Regeneration mode keys off a `CHECKER COMPLAINTS` block,
// groomer.md §Regeneration mode off a `CONTRACT FEEDBACK` block. This is the
// service-message-only seam (same discipline as serviceToolsDirective): the
// prompts/*.md and .claude/agents files stay byte-identical — they define the
// interactive regen path; the service composes the complaint here for the
// headless path. An empty/absent complaint injects NOTHING, so a fresh plan's
// first call stays byte-identical to pre-B1 (the asymmetric-default rule).
function regenComplaintsSection(complaintsBlock, heading) {
  if (typeof complaintsBlock !== 'string' || complaintsBlock.trim().length === 0) return [];
  return [
    `# ${heading}`,
    'Your previous attempt FAILED the deterministic gate. Each line below is an',
    'exact, non-negotiable complaint. Fix EXACTLY these, change nothing else that',
    'was valid, and re-emit the FULL corrected JSON:',
    '',
    complaintsBlock.trim(),
    '',
  ];
}

// Exported as the unit seam for the prompt wires (service/test/
// scope-hint.test.mjs, grounding-hint.test.mjs, service-mode-prompt.test.mjs,
// regen-loop.test.mjs) — fake-mode tests can assert the exact prompt
// construction without ever spawning an external agent CLI.
export function phase1Message({ ask, requester, roleLens, runDir, outputLanguage, scopeHint, groundingHint, regen }) {
  // One source of truth for the posture: the tail's Write/gate imperatives
  // soften exactly when the tools directive is injected (see below).
  const toolsDirective = serviceToolsDirective();
  const safePosture = toolsDirective.length > 0;
  return [
    loadPromptBody(path.join(MERCURY_ROOT, 'prompts', 'decomposer.md')),
    '',
    // The prompts honor `# OUTPUT LANGUAGE` (en|tr|both, default en). Injected
    // immediately after the role body so it governs all prose the agent emits;
    // jargon stays English.
    '# OUTPUT LANGUAGE',
    outputLanguage || 'en',
    '',
    // `# TOOLS` (safe posture only) comes FIRST among the directives: the
    // agent must know its real toolset before any instruction that could
    // tempt a denied tool call — see serviceToolsDirective's header note.
    ...toolsDirective,
    // `# SCOPE` (when constrained) precedes the ask so the directive governs
    // the decomposition rather than reading as part of the request text.
    ...scopeDirective(scopeHint),
    // `# GROUNDING` (when light) sits AFTER `# SCOPE`, deliberately: both are
    // planning directives that must precede the ask, and SCOPE governs WHAT
    // to produce (the shape) while GROUNDING governs HOW to verify it (the
    // exploration process) — shape first, process second, then the request
    // the two directives constrain.
    ...groundingDirective(groundingHint),
    ask,
    '',
    `Requester: ${requester}`,
    `Role lens: ${roleLens}`,
    '',
    // `# COUPLING MAP` — trusted reference DATA, not a directive, so it sits
    // with the other service-injected material after the ask (see
    // couplingMapBlock's header note for why it is injected at all).
    ...couplingMapBlock(),
    // `# CHECKER COMPLAINTS` (B1) — on a bounded-regen re-entry ONLY. Sits last
    // among the injected material, right before the write/gate imperatives, so
    // its recency governs the correction the model must apply. Absent on a
    // fresh call (byte-identical to pre-B1). The block name matches
    // decomposer.md §Regeneration mode verbatim.
    ...regenComplaintsSection(regen && regen.complaintsBlock, 'CHECKER COMPLAINTS'),
    // Under the safe posture, "Write the artifacts" and "run the gate" are
    // exactly the denied attempts the `# TOOLS` directive suppresses — the
    // service writes the artifact (from the fenced JSON) and runs the gate
    // itself, so the imperatives soften to match. A deliberately loosened
    // posture keeps today's wording byte-identical.
    ...(safePosture
      ? [
          `The run directory for this plan is: ${runDir} — the service writes`,
          'skeleton.json there itself from your fenced JSON reply.',
          'Present the shape, then STOP; do not proceed to Phase 2.',
        ]
      : [
          `Write all Phase 1 artifacts under this exact directory (it already exists`,
          `— do not create a sibling or timestamped directory): ${runDir}`,
          'Run the skeleton gate, present the shape, then STOP; do not proceed to Phase 2.',
        ]),
    'Do not attempt any Jira network calls in this phase.',
    '',
    'Additionally: whether or not your own Write tool call to',
    `${path.join(runDir, 'skeleton.json')} succeeds, ALWAYS include the complete,`,
    'valid skeleton JSON verbatim in a fenced ```json code block in your final',
    'message — the service reads it from there as the source of truth.',
  ].join('\n');
}

// Exported as the unit seam for the posture wire (service/test/
// service-mode-prompt.test.mjs) — same rationale as phase1Message above.
// The coupling map is deliberately NOT re-injected here: groom RESUMES the
// phase-1 CLI session (buildClaudeArgs: resume → `--resume <sessionId>`, and
// server.mjs passes the persisted plan.session_id), so the map injected into
// the phase-1 message is already in the session's context — re-sending its
// ~3-4K tokens would pay for them twice for zero information gain.
export function groomMessage({ edited, runDir, outputLanguage, groundingHint, regenComplaints }) {
  const toolsDirective = serviceToolsDirective(); // same one-source-of-truth pattern as phase1Message
  const safePosture = toolsDirective.length > 0;
  const editNote = edited ? ' (service applied human edits to skeleton.json — re-read it)' : '';
  return [
    loadPromptBody(path.join(MERCURY_ROOT, 'prompts', 'groomer.md')),
    '',
    '# OUTPUT LANGUAGE',
    outputLanguage || 'en',
    '',
    ...toolsDirective,
    // `# GROUNDING` (when light) sits AFTER `# TOOLS` and BEFORE the operative
    // `Shape APPROVED` body — mirroring phase1Message, where the directives
    // precede the request they constrain. B5, the groom half of Light: tell
    // the resumed session to reuse its Phase-1 grounding instead of re-crawling
    // per item. full/absent inject nothing (byte-identical to pre-B5).
    ...groomGroundingDirective(groundingHint),
    `Shape APPROVED${editNote}.`,
    // `# CONTRACT FEEDBACK` (B1) — on a bounded-regen re-entry ONLY. Groom
    // always RESUMES plan.session_id (no session branching, unlike phase1), so
    // this is the only groom-side regen wire: the deterministic plan-gate's
    // complaint text, composed into the block groomer.md §Regeneration mode
    // recognizes verbatim. Absent on a fresh groom (byte-identical to pre-B1).
    ...regenComplaintsSection(regenComplaints, 'CONTRACT FEEDBACK'),
    // Same posture softening as phase1Message's tail: under the safe
    // posture the write-plan.json/run-the-gate imperatives are the denied
    // attempts the `# TOOLS` directive suppresses.
    ...(safePosture
      ? [
          'Proceed to Phase 2 per your instructions: produce the complete plan',
          'JSON, present the summary, STOP.',
        ]
      : [
          'Proceed to Phase 2 per your instructions: write plan.json next to',
          'skeleton.json, run the plan gate, present the summary, STOP.',
        ]),
    '',
    'Additionally: whether or not your own Write tool call to',
    `${path.join(runDir, 'plan.json')} succeeds, ALWAYS include the complete,`,
    'valid plan JSON verbatim in a fenced ```json code block in your final',
    'message — the service reads it from there as the source of truth.',
  ].join('\n');
}

// (The former Phase-3 createMessage() resume template was removed with the
// control-plane pivot — creation no longer involves the agent at all.)

/**
 * Builds the `claude -p` argv array for one call.
 *
 * The headless planner accepts untrusted Slack, dashboard, and API input, so
 * it defaults to `--permission-mode default` with the `Read,Grep,Glob`
 * allowlist documented in docs/ARCHITECTURE.md and docs/OPERATIONS.md.
 * The service extracts the returned artifact and runs treecheck itself;
 * tracker creation remains a separate deterministic control-plane spawn.
 * The explicit overrides below are load-bearing deployment controls, not an
 * invitation to grant Bash or bypass permissions to untrusted requests.
 */
// Per-seat model/effort resolution: the
// two planning phases have different quality/cost profiles — DECOMPOSE
// produces the shape (cheap to be wrong: the human shape gate rejects it for
// ~the phase-1 cost alone) while GROOM writes the 5 fields, the code anchors,
// and the coupling-zone routing (expensive to be wrong: it is what the create
// gate approves). So the decompose seat may run a cheaper/faster model while
// groom keeps the strongest one. Resolution order per seat:
//   MERCURY_AGENT_MODEL_DECOMPOSE / _GROOM   (seat-specific override)
//   MERCURY_AGENT_MODEL                       (shared override — unchanged
//                                              behavior for existing deploys)
//   'opus'                                    (the built-in model/effort default)
// Same ladder for effort (_EFFORT_DECOMPOSE / _EFFORT_GROOM / _EFFORT /
// 'xhigh'). Any NON-Claude model still enters only through the provider adapter contract
// calibration gate — these knobs select among Claude CLI models, where the
// tool loop and sandbox are identical by construction.
function seatConfig(kind) {
  const env = process.env;
  const seat = kind === 'phase1' ? 'DECOMPOSE' : 'GROOM';
  return {
    model: env[`MERCURY_AGENT_MODEL_${seat}`] || env.MERCURY_AGENT_MODEL || 'opus',
    effort: env[`MERCURY_AGENT_EFFORT_${seat}`] || env.MERCURY_AGENT_EFFORT || 'xhigh',
  };
}

// The light-mode turn cap's default and env override. Claude Code's
// `--max-turns <n>` bounds the agentic tool loop in -p mode — VERIFIED real
// on the installed CLI (2.1.207, 2026-07-11): the flag is hidden from
// `--help` but empirically accepted at argument parse (a made-up flag is
// rejected with `error: unknown option`, `--max-turns 2` proceeds into the
// query pipeline). Sanitized: any non-positive/non-integer override falls
// back to the default rather than passing garbage to the CLI.
function lightMaxTurns() {
  const raw = Number(process.env.MERCURY_LIGHT_MAX_TURNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 12;
}

// The light-mode GROOM turn cap (B5, 2026-07-13). Decompose gets a FLAT cap
// (one shape to produce); groom writes the 5 fields + verified anchors PER
// ITEM, so its cap scales with plan size: base + perItem × n. Groom was
// originally left uncapped on the theory that it "only writes content", but a
// real Light plan proved it re-crawls the grounding repos per item (49 turns /
// $1.61, 94% of the bill) even though it RESUMES decompose's already-grounded
// session. Same sanitize-or-fallback discipline as lightMaxTurns — a
// junk/negative/non-integer env override falls back to the default rather than
// passing garbage to the CLI. NO upper clamp: a genuinely large plan needs its
// turns, and the deterministic gate — not the cap — is what fails a truncated
// artifact closed.
function lightGroomBaseTurns() {
  const raw = Number(process.env.MERCURY_LIGHT_GROOM_BASE_TURNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 6;
}

function lightGroomPerItemTurns() {
  const raw = Number(process.env.MERCURY_LIGHT_GROOM_PER_ITEM_TURNS);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
}

// base + perItem × n, where n is the plan's item count when it is a positive
// integer, else the fallback 4 (missing/0/negative/non-integer all → 4, a
// plausible mid-size plan — never a tiny cap that would truncate a real groom).
function lightGroomMaxTurns(itemCount) {
  const n = Number.isInteger(itemCount) && itemCount > 0 ? itemCount : 4;
  return lightGroomBaseTurns() + lightGroomPerItemTurns() * n;
}

export function buildClaudeArgs({ userMessage, sessionId, resume, kind = 'groom', groundingHint, itemCount, regen, modelOverride }) {
  const maxTurns = groundingHint === 'light'
    ? (kind === 'phase1' ? lightMaxTurns() : lightGroomMaxTurns(itemCount))
    : undefined;
  return buildClaudeRuntimeArgs({
    userMessage,
    sessionId,
    resume,
    kind,
    regen,
    seat: seatConfig(kind),
    modelOverride,
    maxTurns,
    groundingRoot: reposRoot(),
  });
}

// child-env isolation: the LLM subprocess's environment, minus every credential the
// planning agent does not need — it needs ONLY the Anthropic credential.
// The threat: a prompt-injected ask has no Bash under today's allowlist,
// but any FUTURE loosening of the tool posture (or a tool that echoes env)
// would hand it whatever sits in the environment — the Slack tokens, the
// service bearer tokens, the GitHub fetch credential, Railway's injected
// platform metadata. Stripping them here is cheap insurance that holds
// even if the sandbox posture drifts. create-tree.mjs children
// (control-plane spawns) inherit the full service env separately and
// resolve the Jira token themselves. Exported as the unit-test seam.
const SANDBOX_STRIP_KEYS = [
  'MERCURY_JIRA_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'MERCURY_SERVICE_TOKEN',
  'MERCURY_SERVICE_TOKEN_DASHBOARD',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  // A staged OpenRouter credential is never useful to the Claude child — the
  // per-phase proxy is the only permitted egress path.  Strip these even
  // while the default Anthropic provider is active, so an operator cannot
  // accidentally leak a future migration secret through a direct child.
  'MERCURY_OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY',
];

export function sandboxedEnv(env) {
  const out = { ...env };
  for (const key of SANDBOX_STRIP_KEYS) delete out[key];
  for (const key of Object.keys(out)) {
    // Whole families go by PREFIX so a future addition (SLACK_SIGNING_SECRET,
    // SLACK_WEBHOOK_URL, a new RAILWAY_* metadata key) can never leak by
    // omission; the explicit SLACK_* entries in SANDBOX_STRIP_KEYS stay as
    // documentation + belt-and-suspenders.
    if (key.startsWith('RAILWAY_') || key.startsWith('SLACK_')) delete out[key];
  }
  return out;
}

async function runMeteredOpenRouterSpawn({ runSpawn }, runtime) {
  const proxy = await startOpenRouterMeterProxy({ sourceKey: runtime.apiKey });
  const childEnv = openRouterChildEnv(sandboxedEnv(process.env), {
    baseUrl: proxy.baseUrl,
    capability: proxy.capability,
  });
  let parsed;
  let childError;
  try {
    parsed = await runSpawn(childEnv);
  } catch (err) {
    childError = err;
  }

  let accounting;
  try {
    // Reconcile even when Claude exited non-zero.  A tool-loop failure can
    // happen after one or more billable Messages requests; dropping them
    // would make the next breaker decision false.
    accounting = await proxy.finalize();
  } catch (err) {
    if (err instanceof CostTelemetryError) throw err;
    // The underlying transport/provider error may include request metadata.
    // Retain it as a local Error cause but never promote it to a plan-visible
    // message (server.mjs deliberately maps this code to a fixed sentence).
    throw new CostTelemetryError('OpenRouter accounting failed', { cause: err });
  }
  if (childError) {
    // Child stderr/result can contain model-generated text.  Keep it out of
    // plan state and human surfaces; the phase has a separate operational log
    // for an operator who deliberately enables it.
    throw new MeteredPhaseError('Claude phase failed after provider-authoritative spend was recorded', {
      cause: childError,
      costNanos: accounting.costNanos,
    });
  }
  return { parsed, ...accounting };
}

async function runPhase({
  kind,
  runDir,
  sessionId,
  userMessage,
  groundingHint,
  itemCount,
  regen,
  agentRuntime,
  providerRuntime = { provider: 'anthropic' },
}) {
  // B1: a phase1 or groom bounded regeneration resumes the failed session;
  // otherwise phase1 starts fresh and groom resumes its approved skeleton's
  // session. Each adapter owns the runtime-specific argv for that decision.
  const effectiveSessionId = regen
    ? regen.sessionId
    : (kind === 'phase1' ? randomUUID() : sessionId);
  const resume = kind !== 'phase1' || Boolean(regen);
  const seat = seatConfig(kind);
  const maxTurns = groundingHint === 'light'
    ? (kind === 'phase1' ? lightMaxTurns() : lightGroomMaxTurns(itemCount))
    : undefined;
  // OpenRouter's Anthropic-Messages proxy wraps only Claude's spawn. Codex
  // owns its OpenAI OAuth/provider path and must never be sent through it.
  const useOpenRouter = agentRuntime.id === 'claude' && providerRuntime.provider === 'openrouter';

  const artifactName = kind === 'phase1' ? 'skeleton.json' : 'plan.json';
  const artifactPath = path.join(runDir, artifactName);

  // Cold-resume context: read the PRIOR artifact before fail-closed deletion.
  let priorArtifactText;
  const priorArtifactName = regen
    ? artifactName
    : (kind === 'groom' ? 'skeleton.json' : null);
  if (priorArtifactName) {
    const priorPath = path.join(runDir, priorArtifactName);
    try {
      if (fs.existsSync(priorPath)) {
        priorArtifactText = fs.readFileSync(priorPath, 'utf8');
      }
    } catch {
      // Non-fatal: cold resume degrades to no prior context; the gate still
      // validates the resulting artifact.
    }
  }

  // A failed/uncertain prior phase must never donate an artifact to a retry.
  // Delete before each invocation and additionally on metering failure below;
  // the deterministic gate only ever sees a response that was fully metered.
  fs.rmSync(artifactPath, { force: true });

  let phaseResult;
  try {
    phaseResult = await agentRuntime.runPhase({
      kind,
      runDir,
      userMessage,
      sessionId: effectiveSessionId,
      resume,
      groundingHint,
      itemCount,
      regen,
      priorArtifactText,
      seat,
      maxTurns,
      groundingRoot: reposRoot(),
      repoRoot: MERCURY_ROOT,
      childEnv: sandboxedEnv(process.env),
      // OpenRouter's child environment maps Claude's stable seat aliases to
      // one exact provider slug. Ignore inherited model overrides on this path.
      modelOverride: useOpenRouter ? 'opus' : undefined,
      reportedModel: useOpenRouter ? providerRuntime.model : undefined,
      execute: useOpenRouter
        ? ({ args, runSpawn }) => runMeteredOpenRouterSpawn({ args, runSpawn }, providerRuntime)
        : undefined,
    });
  } catch (err) {
    fs.rmSync(artifactPath, { force: true });
    throw err;
  }
  const resultText = phaseResult.text;

  if (kind === 'phase1' || kind === 'groom') {
    if (!fs.existsSync(artifactPath)) {
      // Under the safe default tool allowlist (no Bash/Write), the agent's
      // own Write-tool call is expected to be denied — so the service
      // extracts the artifact from the response text itself rather than
      // depending on it. If extraction also fails, the artifact stays
      // absent and the caller's gate step fails closed on the missing file
      // — never silently treated as success.
      const extracted = extractJsonArtifact(resultText);
      if (extracted) {
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(artifactPath, JSON.stringify(extracted, null, 2));
      }
    }
  }

  return {
    sessionId: phaseResult.sessionId || effectiveSessionId,
    costUsd: phaseResult.costUsd,
    ...(Object.hasOwn(phaseResult, 'costNanos') ? { costNanos: phaseResult.costNanos } : {}),
    resultText,
    durationMs: phaseResult.durationMs,
    numTurns: phaseResult.numTurns,
    model: phaseResult.model,
    costTelemetryStatus: phaseResult.costTelemetryStatus,
  };
}

/**
 * Best-effort extraction of a JSON object out of a Claude text response:
 * the whole response, then fenced code blocks (last to first), then the
 * largest top-level balanced-brace region. Unit tests cover complete and
 * truncated response shapes without invoking an external provider.
 */
export function extractJsonArtifact(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();

  const whole = tryParseObject(trimmed);
  if (whole) return whole;

  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fenced.length - 1; i >= 0; i -= 1) {
    const parsed = tryParseObject(fenced[i].trim());
    if (parsed) return parsed;
  }

  const region = largestBalancedBraceRegion(trimmed);
  if (region) {
    const parsed = tryParseObject(region);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseObject(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function largestBalancedBraceRegion(text) {
  const stack = [];
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      stack.push(i);
    } else if (ch === '}' && stack.length > 0) {
      const start = stack.pop();
      if (stack.length === 0) {
        const len = i - start + 1;
        if (len > bestLen) {
          bestLen = len;
          bestStart = start;
          bestEnd = i + 1;
        }
      }
    }
  }
  return bestStart >= 0 ? text.slice(bestStart, bestEnd) : null;
}
