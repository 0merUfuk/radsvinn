// grounding.mjs — the configurable grounding-repos root plus the per-plan
// refresh of origin/main. Zero dependencies, like everything under
// service/.
//
// The plan-mode anchor gate resolves `<repo>/<path>` code anchors against
// `origin/main` GIT OBJECTS of checkouts living under one root directory.
// On a laptop that root is the sibling `../grounding` workspace; in the
// container it is the persistent volume's `/data/repos` (seeded by
// deploy/entrypoint.mjs). `reposRoot()` is the ONE place that resolution
// lives — gates.mjs (`-repos-root`), engine.mjs (`--add-dir`, so the
// sandboxed agent can READ the grounding repos outside the app dir), and
// `fetchGroundingRepos()` below all consume it.
//
// Anchors validate against whatever `origin/main` the local
// clones happen to hold — a checkout that has not fetched for a week
// happily green-lights anchors that were deleted upstream days ago, and the
// human approver has no way to see that. `fetchGroundingRepos()` refreshes
// `origin/main` in every repo under the root BEFORE phase 1 runs, and its
// result rides the plan (`grounding` via toPublicView) so a FAILED fetch is
// VISIBLY degraded at the Slack shape gate ("anchors may validate against
// stale code") instead of silently planning on stale refs — the never-
// silent rule is the whole point of fetch-before-plan.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MERCURY_ROOT } from './state.mjs';
import { scrub, gitAuthEnv } from '../deploy/lib.mjs';

// Generous per-repo ceiling: a fetch is one negotiation round-trip on a
// warm clone, but a cold day (big force-push upstream) should not flip the
// plan into "degraded" over a slow-but-succeeding fetch. The post-fetch
// reset shares the same generous ceiling — a big upstream delta re-checks
// out many files on a cold volume.
const FETCH_TIMEOUT_MS = 60 * 1000;
// Per-repo failure text is truncated so a pathological git error (or many
// repos failing at once) cannot bloat the plan record / Slack context line.
const DETAIL_MAX_CHARS = 500;

/**
 * The directory under which grounding repos live. `MERCURY_REPOS_ROOT`
 * (absolute, or resolved against the mercury repo root) overrides; the
 * default is the laptop-era sibling `../grounding` checkout.
 */
export function reposRoot() {
  const raw = process.env.MERCURY_REPOS_ROOT || '../grounding';
  return path.isAbsolute(raw) ? raw : path.resolve(MERCURY_ROOT, raw);
}

// One git step — argv array (never a shell; the dir name is
// filesystem-derived but the no-shell rule is house-wide), hard timeout,
// resolves {ok, error?} and NEVER rejects. Stderr is scrubbed of token
// material BEFORE it can reach the error string: the error rides the plan
// record (`grounding.detail`) and the Slack context line, and a git failure
// message can echo the authenticated URL.
function runGitStep(args, env) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, error: `timed out after ${FETCH_TIMEOUT_MS}ms` });
    }, FETCH_TIMEOUT_MS);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn failed: ${scrub(err.message, process.env.GITHUB_TOKEN)}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: scrub(stderr, process.env.GITHUB_TOKEN).trim().slice(-200) || `exit ${code}` });
    });
  });
}

// `git -C <dir> fetch origin main`, then — on success — `git -C <dir>
// reset --hard origin/main`.
//
// AUTH: all grounding repos are PRIVATE — an unauthenticated fetch fails in
// the container, so without this every plan would carry grounding.ok:false
// (a permanent false alarm; the runbook's own healthy-boot smoke would fail
// by construction). When GITHUB_TOKEN is set the credential is injected via
// ENVIRONMENT-based git config (gitAuthEnv: GIT_CONFIG_COUNT/KEY_0/VALUE_0)
// — env, NOT argv, because at plan time a concurrent LLM child can read a
// sibling process's /proc argv but not its environment; and nothing
// persists (the stored `origin` URL stays clean). See deploy/lib.mjs.
//
// RESET: fetch updates REFS only — the working tree the sandboxed agent
// Reads/Greps stays frozen at whatever the first clone checked out, growing
// ever staler while the anchor gate validates fresh origin/main objects.
// The reset snaps the checkout to the just-fetched tip. Safe because this
// path only runs under MERCURY_FETCH_BEFORE_PLAN=1 (the container posture),
// where every repo under reposRoot() is a disposable read-only grounding
// clone (/data/repos) that no human ever commits to. Do NOT enable the flag
// against a root of human working checkouts — reset --hard destroys
// uncommitted work by design. A failed reset counts the repo as failed
// (visible degradation): refs and working tree would disagree, which is
// exactly the staleness fetch-before-plan exists to surface.
async function fetchOne(dir) {
  const env = { ...process.env, ...gitAuthEnv(process.env.GITHUB_TOKEN) };
  const fetched = await runGitStep(['-C', dir, 'fetch', 'origin', 'main'], env);
  if (!fetched.ok) return fetched;
  const reset = await runGitStep(['-C', dir, 'reset', '--hard', 'origin/main'], env);
  if (!reset.ok) return { ok: false, error: `fetched, but reset --hard origin/main failed: ${reset.error}` };
  return { ok: true };
}

/**
 * Refreshes grounding repos before planning. Gated on
 * `MERCURY_FETCH_BEFORE_PLAN=1` — when
 * the flag is off this returns `undefined` and the caller stores nothing
 * (legacy plans keep their exact shape). When on: every immediate
 * subdirectory of `reposRoot()` that carries a `.git` gets a
 * `git fetch origin main`, all in parallel, each under its own timeout.
 *
 * Returns `{ok:true}` when every repo fetched, `{ok:false, detail}` naming
 * each failing repo otherwise. NEVER throws — a fetch problem must degrade
 * the plan visibly (the caller renders the stale-anchors warning), never
 * kill the worker.
 */
export async function fetchGroundingRepos() {
  if (process.env.MERCURY_FETCH_BEFORE_PLAN !== '1') return undefined;

  const root = reposRoot();
  let repos;
  try {
    repos = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name))
      .filter((dir) => fs.existsSync(path.join(dir, '.git')));
  } catch (err) {
    return { ok: false, detail: `repos root unreadable: ${root} (${err.message})`.slice(0, DETAIL_MAX_CHARS) };
  }
  if (repos.length === 0) {
    // Zero grounding repos is a misconfiguration, not a clean pass — the
    // anchor gate would be validating against nothing.
    return { ok: false, detail: `no git repositories under ${root}` };
  }

  const results = await Promise.all(repos.map(async (dir) => ({ dir, res: await fetchOne(dir) })));
  const failures = results.filter((r) => !r.res.ok);
  if (failures.length === 0) return { ok: true };
  const detail = failures
    .map((f) => `${path.basename(f.dir)}: ${f.res.error}`)
    .join('; ')
    .slice(0, DETAIL_MAX_CHARS);
  return { ok: false, detail };
}
