// gates.mjs — the service's authoritative deterministic validation boundary.
//
// The service-mode agent is explicitly instructed not to run treecheck.
// Instead, the service validates every proposed artifact here. server.mjs
// may feed a deterministic complaint back through bounded regeneration, but
// no artifact reaches a human approval gate unless this boundary accepts it.
//
// Exit-code contract (cmd/treecheck/main.go, authoritative):
//   0 = OK (no hard failure)      -> ok: true
//   1 = hard fail (checker/BLOCK) -> ok: false
//   2 = usage/config error        -> ok: false
//
// The exit code remains the semantic verdict contract. An exit-0 child must
// ALSO emit the documented JSON shape; empty/garbled/shape-less stdout fails
// closed instead of turning a broken or substituted checker into a green gate.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MERCURY_ROOT } from './state.mjs';
import { reposRoot } from './grounding.mjs';
import { resolveCouplingMapPath } from './coupling-map.mjs';

const DEFAULT_TREECHECK_COMMAND = Object.freeze({
  command: 'go',
  args: Object.freeze(['run', './cmd/treecheck']),
});

function treecheckCommand(override) {
  if (override !== undefined) {
    if (!override
        || typeof override.command !== 'string'
        || override.command.length === 0
        || !Array.isArray(override.args)
        || !override.args.every((arg) => typeof arg === 'string')) {
      throw new TypeError('checkerCommand must be { command: non-empty string, args: string[] }');
    }
    return [override.command, [...override.args]];
  }
  const bin = process.env.MERCURY_TREECHECK_BIN;
  if (bin) return [bin, []];
  return [DEFAULT_TREECHECK_COMMAND.command, [...DEFAULT_TREECHECK_COMMAND.args]];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Baseline keys emitted by the authoritative Go check orders:
// skeleton.go:skeletonCheckOrder and precheck.go:planCheckOrder. Additional
// future checks remain forward-compatible, but an exit-0 response may not omit
// any check the current binary is required to run.
const SKELETON_CHECKS = [
  'acyclic',
  'hierarchy_legal',
  'order_consistent',
  'milestone_shippable',
  'sizing_sane',
  'summary_consistency',
  'output_language_metadata',
];
const PLAN_CHECKS = [
  'plan_structure',
  'hierarchy_legal',
  'fields_present',
  'single_repo',
  'anchors_exist',
  'anchor_consistency',
  'zone_routing',
  'sizing_bounds',
];

function isVerdict(value, requiredChecks) {
  if (!isObject(value)
      || typeof value.ok !== 'boolean'
      || typeof value.hard_fail !== 'boolean'
      || typeof value.regen_complaint !== 'string'
      || !isObject(value.checks)
      || !requiredChecks.every((name) => Object.hasOwn(value.checks, name))) return false;
  const checks = Object.values(value.checks);
  if (checks.length === 0 || !checks.every((check) => (
    isObject(check) && typeof check.pass === 'boolean'
  ))) return false;
  const allPass = checks.every((check) => check.pass);
  return value.ok === allPass && value.hard_fail === !value.ok;
}

function planItemIDs(stdinData) {
  let plan;
  try {
    plan = JSON.parse(stdinData);
  } catch {
    return null;
  }
  if (!isObject(plan) || !Array.isArray(plan.items) || plan.items.length === 0) {
    return null;
  }
  const ids = new Set();
  for (const item of plan.items) {
    if (!isObject(item)
        || typeof item.temp_id !== 'string'
        || item.temp_id.trim().length === 0
        || ids.has(item.temp_id)) {
      return null;
    }
    ids.add(item.temp_id);
  }
  return ids;
}

function isExpectedOutput(parsed, mode, stdinData) {
  if (mode === 'skeleton') return isVerdict(parsed, SKELETON_CHECKS);
  if (mode !== 'plan' || !isObject(parsed) || typeof parsed.ok !== 'boolean' || !isObject(parsed.items)) {
    return false;
  }
  const expectedIDs = planItemIDs(stdinData);
  const verdictIDs = Object.keys(parsed.items);
  if (expectedIDs === null
      || verdictIDs.length !== expectedIDs.size
      || !verdictIDs.every((id) => expectedIDs.has(id))) {
    return false;
  }
  const verdicts = Object.values(parsed.items);
  return verdicts.every((verdict) => isVerdict(verdict, PLAN_CHECKS))
    && parsed.ok === verdicts.every((verdict) => verdict.ok);
}

function runTreecheck(modeArgs, stdinData, options = {}) {
  const modeArg = modeArgs.find((arg) => arg.startsWith('-mode='));
  const mode = modeArg && modeArg.slice('-mode='.length);
  return new Promise((resolve) => {
    const [cmd, baseArgs] = treecheckCommand(options.checkerCommand);
    const child = spawn(cmd, [...baseArgs, ...modeArgs], {
      cwd: MERCURY_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve({ ok: false, raw: { spawnError: String(err) }, exitCode: null, stderr: String(err) });
    });
    child.on('close', (code) => {
      let parsed;
      let parsedOk = true;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsedOk = false;
        parsed = { unparsedStdout: stdout };
      }
      const expectedOutput = parsedOk && isExpectedOutput(parsed, mode, stdinData);
      const validExitZeroOutput = expectedOutput && parsed.ok === true;
      resolve({
        ok: code === 0 && validExitZeroOutput,
        raw: parsed,
        exitCode: code,
        stderr,
        ...(code === 0 && !validExitZeroOutput
          ? { outputError: `treecheck exited 0 without a valid ${mode || 'unknown'} verdict` }
          : {}),
      });
    });
    // A substituted command may exit before consuming stdin (e.g. /usr/bin/true).
    // Ignore the resulting EPIPE; its empty stdout is rejected above.
    child.stdin.on('error', () => {});
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

/**
 * Runs `treecheck -mode=skeleton` over `<runDir>/skeleton.json`.
 * `checkerCommand` is an explicit test/demo seam; ordinary service calls omit
 * it and retain the MERCURY_TREECHECK_BIN override (or the default Go command).
 */
export async function gateSkeleton(runDir, options = {}) {
  const skeletonPath = path.join(runDir, 'skeleton.json');
  let data;
  try {
    data = await readFile(skeletonPath, 'utf8');
  } catch (err) {
    return { ok: false, raw: { error: `cannot read ${skeletonPath}: ${err.message}` }, exitCode: null };
  }
  return runTreecheck(['-mode=skeleton'], data, options);
}

/**
 * Runs `treecheck -mode=plan` with the resolved repos root and coupling-map
 * path over `<runDir>/plan.json`. The repos root comes from `grounding.mjs` —
 * the laptop default is the sibling `../grounding` checkout; the container
 * overrides via `MERCURY_REPOS_ROOT` (the persistent volume's `/data/repos`).
 * The coupling-map resolver is shared with prompt injection, so the model and
 * deterministic gate cannot silently evaluate different maps. Explicit
 * `checkerCommand` and `couplingMapPath` options are test/demo seams; ordinary
 * service calls omit them and retain the documented environment behavior.
 *
 * `skipPlanGate: true` skips the ENTIRE plan gate, returning
 * `{ok:true, skipped:true}`. gatePlan deliberately never reads
 * MERCURY_SKIP_PLAN_ANCHORS itself: createServer may translate that legacy,
 * misleadingly named environment knob only for fake-engine test instances.
 */
export async function gatePlan(runDir, options = {}) {
  if (options.skipPlanGate === true) {
    return { ok: true, skipped: true };
  }
  const planReposRoot = options.reposRoot || reposRoot();
  const couplingMapPath = options.couplingMapPath ?? resolveCouplingMapPath();
  const planPath = path.join(runDir, 'plan.json');
  let data;
  try {
    data = await readFile(planPath, 'utf8');
  } catch (err) {
    return { ok: false, raw: { error: `cannot read ${planPath}: ${err.message}` }, exitCode: null };
  }
  return runTreecheck([
    '-mode=plan',
    `-repos-root=${planReposRoot}`,
    `-coupling-map=${couplingMapPath}`,
  ], data, options);
}
