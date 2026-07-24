// Mercury calibration harness — shared library.
//
// Deliberately disposable glue: correctness + observability over elegance.
// This module is the ONLY place that shells out to the `claude` CLI and the
// treecheck Go binary, so the pipeline scripts stay thin and testable.
//
// Verified `claude` CLI envelope shape (v2.1.198, probed 2026-07-02 with
// `claude -p "say hi" --model claude-haiku-4-5 --output-format json`):
//   { type:"result", subtype:"success", is_error:false,
//     result:"<assistant text>",          <- the model output text
//     total_cost_usd:<number>,            <- cost of the call
//     session_id:"<uuid>",                <- the session
//     duration_ms:<number>, usage:{...} }
// lib.mjs extracts exactly those fields in extractEnvelope().

import { spawnSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';


export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MERCURY_ROOT = path.resolve(HARNESS_DIR, '..');

// ───────────────────────────── loaders / io ──────────────────────────────

export function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

export function loadYaml(p) {
  return yaml.load(readText(p));
}

export function loadJson(p) {
  return JSON.parse(readText(p));
}

export function dumpYaml(obj) {
  return yaml.dump(obj, { lineWidth: 100, noRefs: true });
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function writeText(p, s) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, s);
}

export function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + '\n');
}

export function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function uuid() {
  return randomUUID();
}

// ─────────────────────────────── config ──────────────────────────────────

// loadConfig reads harness/config.yaml and resolves every declared path to an
// absolute path under MERCURY_ROOT (as documented in config.yaml). thresholds
// values (weights, cutoffs, regen N) are read from the resolved thresholds.yaml.
export function loadConfig() {
  const cfg = loadYaml(path.join(HARNESS_DIR, 'config.yaml'));
  const p = cfg.paths;
  const abs = {
    prompts: path.resolve(MERCURY_ROOT, p.prompts),
    thresholds: path.resolve(MERCURY_ROOT, p.thresholds),
    coupling_map: path.resolve(MERCURY_ROOT, p.coupling_map),
    repos_root: path.resolve(MERCURY_ROOT, p.repos_root),
    contracts: path.resolve(MERCURY_ROOT, p.contracts),
  };
  const thresholds = loadYaml(abs.thresholds);
  return { ...cfg, absPaths: abs, thresholds };
}

// ─────────────────────────── JSON extraction ─────────────────────────────

// stripToJson parses the model's text output into an object. It tolerates a
// ```json fenced block, leading/trailing prose, AND stray small JSON values
// before the real object (observed live: Opus emitted `{}` ahead of the actual
// plan — the naive first-{-to-last-} slice cannot recover that). Strategy:
// direct parse → fence parse → balanced-brace scan collecting every complete
// top-level {...} candidate (string-aware), returning the largest that parses.
// Throws on unrecoverable failure (the caller may then bounded-re-ask).
export function stripToJson(text) {
  if (text == null) throw new Error('model returned empty text');
  let t = String(text).trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch (e1) {
    const candidates = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '{') continue;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let j = i; j < t.length; j++) {
        const c = t[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            candidates.push(t.slice(i, j + 1));
            i = j; // resume the outer scan after this candidate
            break;
          }
        }
      }
    }
    // Largest first — the real payload dwarfs stray artifacts like `{}`.
    candidates.sort((a, b) => b.length - a.length);
    for (const cand of candidates) {
      try {
        const parsed = JSON.parse(cand);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed;
      } catch {
        /* try the next candidate */
      }
    }
    throw e1;
  }
}

// ───────────────────────── claude CLI envelope ───────────────────────────

// extractEnvelope maps a raw --output-format json envelope to the fields the
// harness records. Throws on an error envelope so failures surface loudly.
function extractEnvelope(raw) {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('claude envelope is not a JSON object');
  }
  if (raw.is_error === true || (raw.subtype && raw.subtype !== 'success')) {
    throw new Error(`claude returned an error envelope (subtype=${raw.subtype}): ${raw.result ?? ''}`);
  }
  return {
    text: raw.result,
    costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : 0,
    sessionId: raw.session_id ?? null,
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
    raw,
  };
}

// buildClaudeArgs assembles the execFile arg vector (never a shell string, so
// user content is never interpolated by a shell). Uses EXACTLY the verified
// v2.1.198 flags.
export function buildClaudeArgs({
  model, effort, systemPromptText, userMessage, sessionId,
  allowedTools, permissionMode, jsonSchemaInline,
}) {
  const args = [
    '-p', userMessage,
    '--model', model,
    '--output-format', 'json',
    '--session-id', sessionId,
    '--system-prompt', systemPromptText,
  ];
  if (effort) args.push('--effort', effort);
  // Generators get read-only tools via --allowedTools. Judges get NO
  // --allowedTools flag at all: in -p non-interactive default permission mode
  // every tool not explicitly allowed is denied, so omitting the flag IS the
  // no-tools restriction (an empty-string flag value is undefined CLI behavior).
  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (jsonSchemaInline) args.push('--json-schema', jsonSchemaInline);
  return args;
}

// FIX D — transient-retry policy. TRANSIENT_RETRY_BACKOFFS_MS[i] is the pause
// before the (i+1)-th retry of a NON-timeout `claude` spawn failure; its length
// is the max retry count (2). Hardcoded on purpose: config.yaml is hash-frozen
// by the provenance stamp (score-agreement --verify enforces the freeze), so
// this policy must NOT be added there.
const TRANSIENT_RETRY_BACKOFFS_MS = [10_000, 20_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// invokeClaude runs one model call and returns
//   { text, parsedJson, costUsd, sessionId, durationMs, raw, transientRetries }.
//
// runClaudeSpawn spawns the CLI with stdin = /dev/null (stdio 'ignore') so the
// child NEVER blocks waiting for stdin. The -p prompt rides in argv; but `claude`
// still probes stdin for piped context and, given a dangling inherited stdin
// (e.g. under `nohup … &` detachment — no TTY, no EOF), warns "no stdin data
// received in 3s" and exits 1. Foreground tool-invoked runs only worked because
// the caller happened to hand the child a closed stdin. 'ignore' = /dev/null =
// immediate EOF, which is exactly what the CLI's own error advises. Enforces the
// timeout with SIGKILL + a maxBuffer cap; resolves { stdout } or rejects with a
// rich error (code / signal / stderr tail) the caller persists as evidence.
// (promisified execFile accepts neither `input` nor `stdio`, hence raw spawn.)
function runClaudeSpawn(args, { cwd, timeoutMs, maxBuffer = 32 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let outLen = 0;
    let killedForBuffer = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen > maxBuffer) { killedForBuffer = true; child.kill('SIGKILL'); return; }
      out += d;
    });
    child.stderr.on('data', (d) => { err += d; if (err.length > 65536) err = err.slice(-65536); });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`claude spawn failed: ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('timed out'), { timedOut: true }));
      if (killedForBuffer) return reject(new Error(`claude stdout exceeded ${maxBuffer} bytes`));
      if (code !== 0) return reject(Object.assign(new Error(`claude exit ${code}`), { code, signal, stderr: err }));
      resolve({ stdout: out });
    });
  });
}

// In dry-run mode it loads fixtures/dryrun/<dryRunKey>.json (a canned envelope)
// instead of shelling out — nothing hits the network. In live mode it spawns
// the CLI via runClaudeSpawn with a fresh --session-id (never --resume). On a JSON
// parse failure it performs ONE bounded re-ask (config limits.json_reask_attempts)
// appending the correction instruction to the SAME user message.
//
// Every live call carries a hard timeout (timeoutMs; config limits.call_timeout_minutes,
// default 20) enforced by a SIGKILL timer in runClaudeSpawn: a hung CLI call becomes a
// normal call FAILURE (thrown Error -> the caller's ERROR/escalation path),
// never a run that hangs forever.
export async function invokeClaude({
  model, effort, systemPromptFile, systemPromptText, userMessage,
  allowedTools = [], permissionMode, cwd,
  dryRun = false, dryRunDir, dryRunKey,
  jsonReaskAttempts = 1, jsonSchemaInline = null,
  timeoutMs = 20 * 60_000,
}) {
  const sysText = systemPromptText ?? (systemPromptFile ? readText(systemPromptFile) : '');

  let attempt = 0;
  let msg = userMessage;
  let env;
  let lastParseErr = null;
  let transientRetries = 0; // FIX D — accumulated across the whole call

  // The re-ask loop tries (1 + jsonReaskAttempts) times total to obtain valid JSON.
  for (; attempt <= jsonReaskAttempts; attempt++) {
    const sessionId = uuid();
    if (dryRun) {
      const key = attempt === 0 ? dryRunKey : `${dryRunKey}__reask${attempt}`;
      const file = path.join(dryRunDir, `${key}.json`);
      if (!fs.existsSync(file)) {
        // A re-ask fixture is optional; the base fixture is mandatory.
        if (attempt === 0) throw new Error(`dry-run fixture not found: ${file}`);
        throw new Error(`dry-run re-ask fixture not found: ${file} (parse failure: ${lastParseErr})`);
      }
      env = extractEnvelope(loadJson(file));
    } else {
      let stdout;
      const startedAt = Date.now();
      // FIX D — transient-retry. A NON-timeout child failure (the dod-17/18/19
      // blips: code=1, ~5min, no stderr, no output) is retried up to
      // TRANSIENT_RETRY_BACKOFFS_MS.length times with a short backoff before
      // giving up — these previously cost a manual --resume. Timeouts are NEVER
      // retried (a 45-min SIGKILL retried is expensive); a JSON parse failure is
      // not a spawn failure and has its own bounded re-ask below.
      for (let spawnAttempt = 0; ; spawnAttempt++) {
        // A fresh --session-id per spawn (never --resume): a retried call is a
        // brand-new session, not a resume of the failed one.
        const args = buildClaudeArgs({
          model, effort, systemPromptText: sysText, userMessage: msg,
          sessionId: spawnAttempt === 0 ? sessionId : uuid(),
          allowedTools, permissionMode, jsonSchemaInline,
        });
        try {
          ({ stdout } = await runClaudeSpawn(args, { cwd, timeoutMs }));
          break;
        } catch (err) {
          if (err && err.timedOut) {
            throw new Error(`claude CLI call timed out after ${Math.round(timeoutMs / 60000)}min (SIGKILL) — treated as a call failure, not a hang`);
          }
          // Non-timeout child failure: preserve the evidence (exit code/signal +
          // stderr tail) on the thrown error — a bare ChildProcess stack is
          // undiagnosable once the console scrolls away (lesson: the first live
          // Opus tree-judge failure left zero persisted evidence).
          const stderrTail = err && err.stderr ? String(err.stderr).slice(-2000) : '(no stderr)';
          if (spawnAttempt < TRANSIENT_RETRY_BACKOFFS_MS.length) {
            transientRetries++;
            await sleep(TRANSIENT_RETRY_BACKOFFS_MS[spawnAttempt]);
            continue; // fresh spawn
          }
          const elapsed = Date.now() - startedAt;
          throw new Error(
            `claude CLI failed after ${spawnAttempt + 1} attempt(s) (code=${err?.code ?? '?'}, signal=${err?.signal ?? 'none'}, ${Math.round(elapsed / 1000)}s elapsed): ${stderrTail}`,
          );
        }
      }
      env = extractEnvelope(JSON.parse(stdout));
    }

    try {
      const parsedJson = stripToJson(env.text);
      return { ...env, parsedJson, transientRetries };
    } catch (err) {
      lastParseErr = err.message;
      if (attempt >= jsonReaskAttempts) {
        return { ...env, parsedJson: null, parseError: lastParseErr, transientRetries };
      }
      // Bounded re-ask: append the correction instruction and loop (fresh session).
      msg = `${userMessage}\n\nYour previous output was not valid JSON per the contract: ${lastParseErr}. Re-emit the full corrected JSON only.`;
    }
  }
  return { ...env, parsedJson: null, parseError: lastParseErr, transientRetries };
}

// ─────────────────────────────── treecheck ───────────────────────────────

// buildTreecheck compiles cmd/treecheck to binOut (go build -o, one build per
// run rather than go-run-per-call). It does not modify any mercury source.
export function buildTreecheck(binOut) {
  ensureDir(path.dirname(binOut));
  const r = spawnSync('go', ['build', '-o', binOut, './cmd/treecheck'], {
    cwd: MERCURY_ROOT, encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`go build treecheck failed (status ${r.status}): ${r.stderr || r.stdout}`);
  }
  return binOut;
}

// runTreecheck feeds a JSON string on stdin and returns { status, verdict }.
// It uses spawnSync (which does not throw on exit 1) so a hard-fail verdict is
// captured, not lost. mode = "skeleton" | "plan".
export function runTreecheck(binPath, mode, inputJson, { thresholds, couplingMap, reposRoot }) {
  const args = [`-mode=${mode}`, `-thresholds=${thresholds}`];
  if (mode === 'plan') {
    args.push(`-coupling-map=${couplingMap}`, `-repos-root=${reposRoot}`);
  }
  const r = spawnSync(binPath, args, { input: inputJson, encoding: 'utf8' });
  if (r.error) throw new Error(`treecheck spawn failed: ${r.error.message}`);
  if (r.status === 2) throw new Error(`treecheck usage error: ${r.stderr}`);
  let verdict;
  try {
    verdict = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`treecheck emitted non-JSON (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  return { status: r.status, verdict };
}

// ─────────────────────────── scoring (CODE) ──────────────────────────────

// weightedScore computes the /100 total from per-dimension 0..10 scores and the
// thresholds weights (which sum to 10). Never trust the LLM's arithmetic — this
// is the DoD instrument. Fails loudly if the weights do not sum to 10.
//   scores  : { dimKey: number(0..10) }
//   weights : { dimKey: number }        (Σ == 10)
// returns { total, totalRaw, byKey }:
//   totalRaw — the UNROUNDED total. Verdicts MUST be computed from this
//              (a 79.95 is FLAG, not PASS — rounding must never flip a verdict).
//   total    — display rounding only (2 decimals).
export function weightedScore(scores, weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 10) > 1e-9) {
    throw new Error(`weights must sum to 10, got ${sum} (keys: ${Object.keys(weights).join(', ')})`);
  }
  let total = 0;
  const byKey = {};
  for (const [k, w] of Object.entries(weights)) {
    const sc = scores[k];
    if (typeof sc !== 'number' || Number.isNaN(sc)) {
      throw new Error(`missing/invalid score for dimension '${k}'`);
    }
    if (sc < 0 || sc > 10) throw new Error(`score for '${k}' out of range 0..10: ${sc}`);
    total += sc * w; // max Σ(10·w) == 10·10 == 100
    byKey[k] = sc;
  }
  return { total: Math.round(total * 100) / 100, totalRaw: total, byKey };
}

// verdictFor maps a /100 total to a verdict using the thresholds cutoffs.
//   total >= pass_min -> PASS ; >= flag_min -> FLAG ; else BLOCK.
// Callers must pass the UNROUNDED total (weightedScore().totalRaw).
export function verdictFor(total, cutoffs) {
  if (total >= cutoffs.pass_min) return 'PASS';
  if (total >= cutoffs.flag_min) return 'FLAG';
  return 'BLOCK';
}

// applyVerdictFloors caps a verdict at FLAG (never PASS) when any floored
// dimension scored below its floor (config.yaml verdict_floors, calibration-
// tunable — e.g. tree.coverage: 5 means a tree that misses pieces of the ask
// can never PASS on the strength of its other dimensions). A BLOCK is never
// lifted. floorsCfg shape: { tree: { dim: floor }, ticket: { field: floor } }.
export function applyVerdictFloors(level, byKey, verdict, floorsCfg) {
  const floors = (floorsCfg || {})[level] || {};
  const floorReasons = [];
  for (const [dim, floor] of Object.entries(floors)) {
    const sc = byKey[dim];
    if (typeof sc === 'number' && typeof floor === 'number' && sc < floor) {
      floorReasons.push(`${dim}=${sc} below floor ${floor}`);
    }
  }
  if (floorReasons.length === 0) return { verdict, floorReasons };
  return { verdict: verdict === 'PASS' ? 'FLAG' : verdict, floorReasons };
}

// flattenScores turns a judge's { key: { score, justification_tr } } map into
// the { key: score } shape weightedScore expects, plus the justification map.
// Numeric-string scores ("8" -> 8) are coerced here so a cosmetically sloppy
// judge output does not crash validation; anything non-numeric still fails
// loudly in weightedScore.
export function flattenScores(judgeScores) {
  const scores = {};
  const justifications = {};
  for (const [k, v] of Object.entries(judgeScores)) {
    let raw = typeof v === 'object' && v !== null ? v.score : v;
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      raw = Number(raw);
    }
    scores[k] = raw;
    justifications[k] = typeof v === 'object' && v !== null ? v.justification_tr : undefined;
  }
  return { scores, justifications };
}

// ───────────────────── skeleton ⇄ plan structure (M2) ────────────────────

// compareStructure verifies the Groom output kept the human-approved skeleton
// SHAPE: identical item temp_id set; per item the same type / parent_temp_id /
// depends_on (as a set) / milestone_id / repo; identical milestones (ids +
// order); identical epic temp_id / existing_key (summary/why prose MAY be
// polished by the Groomer — that is its job). Returns a list of violation
// strings; empty means no drift.
export function compareStructure(skeleton, plan) {
  const violations = [];
  const norm = (x) => (x === undefined || x === null ? null : x);

  const sItems = new Map((skeleton.items || []).map((it) => [it.temp_id, it]));
  const pItems = new Map((plan.items || []).map((it) => [it.temp_id, it]));
  for (const id of sItems.keys()) {
    if (!pItems.has(id)) violations.push(`item ${id}: in the approved skeleton but missing from the plan`);
  }
  for (const id of pItems.keys()) {
    if (!sItems.has(id)) violations.push(`item ${id}: in the plan but not in the approved skeleton`);
  }
  for (const [id, s] of sItems) {
    const p = pItems.get(id);
    if (!p) continue;
    if (p.type !== s.type) violations.push(`item ${id}: type changed ${s.type} -> ${p.type}`);
    if (norm(p.parent_temp_id) !== norm(s.parent_temp_id)) {
      violations.push(`item ${id}: parent_temp_id changed ${norm(s.parent_temp_id)} -> ${norm(p.parent_temp_id)}`);
    }
    const sDep = new Set(s.depends_on || []);
    const pDep = new Set(p.depends_on || []);
    if (sDep.size !== pDep.size || [...sDep].some((d) => !pDep.has(d))) {
      violations.push(`item ${id}: depends_on changed [${[...sDep].join(', ')}] -> [${[...pDep].join(', ')}]`);
    }
    if (norm(p.milestone_id) !== norm(s.milestone_id)) {
      violations.push(`item ${id}: milestone_id changed ${norm(s.milestone_id)} -> ${norm(p.milestone_id)}`);
    }
    if (p.repo !== s.repo) violations.push(`item ${id}: repo changed ${s.repo} -> ${p.repo}`);
  }

  const sMs = new Map((skeleton.milestones || []).map((m) => [m.milestone_id, m.order]));
  const pMs = new Map((plan.milestones || []).map((m) => [m.milestone_id, m.order]));
  for (const [id, order] of sMs) {
    if (!pMs.has(id)) violations.push(`milestone ${id}: missing from the plan`);
    else if (pMs.get(id) !== order) violations.push(`milestone ${id}: order changed ${order} -> ${pMs.get(id)}`);
  }
  for (const id of pMs.keys()) {
    if (!sMs.has(id)) violations.push(`milestone ${id}: in the plan but not in the approved skeleton`);
  }

  const sE = skeleton.epic || null;
  const pE = plan.epic || null;
  if (!!sE !== !!pE) {
    violations.push(sE
      ? 'epic: dropped by the plan'
      : 'epic: introduced by the plan but absent from the approved skeleton');
  } else if (sE && pE) {
    if (pE.temp_id !== sE.temp_id) violations.push(`epic: temp_id changed ${sE.temp_id} -> ${pE.temp_id}`);
    if (norm(pE.existing_key) !== norm(sE.existing_key)) {
      violations.push(`epic: existing_key changed ${norm(sE.existing_key)} -> ${norm(pE.existing_key)}`);
    }
  }
  return violations;
}

// ─────────────────────────── coupling slice ──────────────────────────────

// Alias table: Turkish/English ask keyword -> neutral example repo (or no-go
// zone). It maps freeform ask vocabulary onto the repo enum declared in
// thresholds.yaml repos.known (the single source the Go checks also read); an
// alias whose target repo is NOT in that known set is ignored by matchAsk rather
// than inventing a repo, so this table can never drift from the check universe.
const SLICE_ALIASES = [
  { tokens: ['api', 'endpoint', 'backend', 'rest'], repo: 'api-service' },
  { tokens: ['frontend', 'front-end', 'app', 'ui', 'arayüz', 'arayuz', 'uygulama', 'web-app', 'next'], repo: 'web-app' },
  { tokens: ['worker', 'queue', 'kuyruk', 'background', 'async', 'job', 'bildirim', 'notification', 'notify', 'e-posta', 'email', 'push', 'cron', 'zamanlanmış', 'zamanlanmis', 'schedule', 'ödeme', 'odeme', 'payment', 'subscription', 'abonelik', 'fatura'], repo: 'worker-service' },
  { tokens: ['shared-lib', 'ortak', 'kütüphane', 'kutuphane', 'library'], repo: 'shared-lib' },
  { tokens: ['kredi', 'credit', 'credits', 'bakiye', 'balance', 'ledger', 'defter', 'refund', 'iade'], zone: 'shared-write' },
];

// Known repos come from thresholds.yaml repos.known — the single source the Go
// checks also read — so the slice matcher can never drift from the check
// universe. Loaded lazily (via loadConfig) and memoized. The alias table above
// maps ask keywords INTO that list: an alias whose target repo is not known is
// ignored rather than inventing a repo.
let knownReposCache = null;
export function knownRepos() {
  if (!knownReposCache) knownReposCache = loadConfig().thresholds.repos.known;
  return knownReposCache;
}

// tokenizeAsk lowercases and splits on non-word characters, preserving Turkish
// letters so "ödeme"/"üretim" match.
function tokenizeAsk(askText) {
  const lower = String(askText).toLowerCase();
  const raw = lower.split(/[^0-9a-zçğıöşü-]+/i).filter(Boolean);
  return new Set(raw);
}

// matchAsk returns the repos + zones a freeform ask touches (case-insensitive
// token match on repo names + the alias table).
export function matchAsk(askText) {
  const tokens = tokenizeAsk(askText);
  const lower = String(askText).toLowerCase();
  const known = knownRepos();
  const repos = new Set();
  const zones = new Set();
  for (const repo of known) {
    if (tokens.has(repo) || lower.includes(repo)) repos.add(repo);
  }
  for (const a of SLICE_ALIASES) {
    const hit = a.tokens.some((t) => tokens.has(t) || lower.includes(t));
    if (!hit) continue;
    if (a.repo && known.includes(a.repo)) repos.add(a.repo);
    if (a.zone) zones.add(a.zone);
  }
  return { repos: [...repos], zones: [...zones] };
}

// computeSlice builds the coupling-map slice for prompt injection. It ALWAYS
// includes every no_go_zones stanza, then includes the tables/services entries
// whose service names keyword-match the ask. Returns a YAML string.
export function computeSlice(askText, couplingMap) {
  const { repos, zones } = matchAsk(askText);
  const repoSet = new Set(repos);

  // tables: include if the owner or any writer/reader service matched, or (for a
  // matched zone) the zone's flagship table (Account <-> shared-write).
  const tables = (couplingMap.tables || []).filter((t) => {
    if (repoSet.has(t.owner)) return true;
    const svc = [
      ...(t.writers || []).map((w) => w.service),
      ...(t.readers || []).map((r) => r.service),
    ];
    if (svc.some((s) => repoSet.has(s))) return true;
    if (zones.includes('shared-write') && t.name === 'Account') return true;
    return false;
  });

  // services: include a service whose name matched, or that syncs OUT to a
  // matched repo (an edge INTO the ask's surface area).
  const services = (couplingMap.services || []).filter((s) => {
    if (repoSet.has(s.name)) return true;
    const outs = (s.sync_out || []).map((o) => o.to);
    return outs.some((o) => repoSet.has(o));
  });

  const slice = {
    version: couplingMap.version,
    generated_at: couplingMap.generated_at,
    matched: { repos, zones }, // debugging aid; harmless in the prompt
    no_go_zones: couplingMap.no_go_zones, // ALWAYS all stanzas
    tables,
    services,
  };
  return dumpYaml(slice);
}

// ─────────────────────────── ask fixtures ────────────────────────────────

// parseAsk splits a fixture ask file into { frontmatter, body }. Frontmatter is
// the first `---`-delimited YAML block; `#`-prefixed SAMPLE comment lines above
// or inside are tolerated (stripped before YAML parse of the frontmatter block).
//
// frontmatter.stratum is normalized to 'big' | 'small' here: big asks carry a
// mandatory tree label in the DoD flow (score-agreement --dod). A missing or
// invalid stratum defaults to 'small' with a LOUD warning — never a crash.
export function parseAsk(filePath) {
  let text = readText(filePath);
  // Strip a leading run of HTML comments / markdown `#` comment lines / blanks
  // that fixtures use to mark themselves (e.g. the SAMPLE-for-plumbing note).
  text = text.replace(/^(?:\s*<!--[\s\S]*?-->\s*|[ \t]*#[^\n]*\n|\s*\n)+/, '');
  const m = text.match(/^\s*---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) throw new Error(`ask ${filePath} missing YAML frontmatter (--- ... ---)`);
  const fm = yaml.load(m[1]) || {};
  if (fm.stratum !== 'big' && fm.stratum !== 'small') {
    const had = fm.stratum;
    fm.stratum = 'small';
    console.warn(`WARN: ask ${path.basename(filePath)} ${had === undefined
      ? "has no frontmatter 'stratum'"
      : `has invalid frontmatter stratum ${JSON.stringify(had)}`} — defaulting to 'small' (expected: big | small)`);
  }
  const body = m[2].trim();
  return { frontmatter: fm, body };
}

// ─────────────────────────── git provenance ──────────────────────────────

// gitShaSafe resolves a short git SHA via READ-ONLY `git -C <dir> rev-parse
// --short <ref>` (the only git invocation this harness is allowed). Never
// throws: a failure (not a repo, unknown ref, git absent) returns
// { sha: null, note } so provenance stamping can skip-with-a-note.
export function gitShaSafe(repoDir, ref) {
  try {
    const r = spawnSync('git', ['-C', repoDir, 'rev-parse', '--short', ref], { encoding: 'utf8' });
    if (r.error) return { sha: null, note: `git rev-parse ${ref} failed in ${repoDir}: ${r.error.message}` };
    if (r.status !== 0 || !r.stdout.trim()) {
      return { sha: null, note: `git rev-parse ${ref} failed in ${repoDir}: ${String(r.stderr || '').trim() || `exit ${r.status}`}` };
    }
    return { sha: r.stdout.trim(), note: null };
  } catch (err) {
    return { sha: null, note: `git rev-parse ${ref} failed in ${repoDir}: ${err.message}` };
  }
}

// gitFetchSafe refreshes origin/main in a repo before provenance stamping and
// anchor resolution — an un-fetched remote-tracking ref silently validates
// anchors against a stale mainline (observed: a stamp cited heads 1+ fetch
// behind the real origin/main). Never throws; failure returns a note.
export function gitFetchSafe(repoDir) {
  try {
    const r = spawnSync('git', ['-C', repoDir, 'fetch', 'origin', 'main', '--quiet'], {
      encoding: 'utf8', timeout: 30_000,
    });
    if (r.error) return { ok: false, note: `git fetch failed in ${repoDir}: ${r.error.message}` };
    if (r.status !== 0) return { ok: false, note: `git fetch failed in ${repoDir}: ${String(r.stderr || '').trim() || `exit ${r.status}`}` };
    return { ok: true, note: null };
  } catch (err) {
    return { ok: false, note: `git fetch failed in ${repoDir}: ${err.message}` };
  }
}

// ─────────────────────────────── misc ────────────────────────────────────

// parseArgs is a tiny flag parser: --k v, --k=v, and boolean --flag.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// timestamp returns a filesystem-safe UTC run id: 2026-07-02T15-04-05Z.
export function timestamp(d = new Date()) {
  return d.toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
}

// safeKey sanitizes a string for use in a dry-run fixture filename.
export function safeKey(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}
