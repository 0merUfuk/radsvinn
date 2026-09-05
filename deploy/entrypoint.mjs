// deploy/entrypoint.mjs — the production container's first process.
// Zero dependencies. Three jobs, in order:
//
//   1. VOLUME LAYOUT — require a writable /data (the Railway volume) and
//      carve it into results/ (plan state + spend ledgers), home/ (becomes
//      $HOME so the `claude` CLI's session store persists — `--resume`
//      keeps working across redeploys), and repos/ (the grounding
//      checkouts). A container without its volume must die loudly at boot,
//      not run amnesiac and lose plan state on the next deploy.
//
//   2. GROUNDING SYNC — clone each missing grounding repo into
//      /data/repos/<repo>, fetch the ones already there. FULL-BLOB shallow
//      clones on purpose: the deterministic plan gate resolves code anchors
//      via `git cat-file -e origin/main:<path>` — a blobless/partial clone
//      (--filter=blob:none) would answer those probes with a lazy NETWORK
//      fetch per anchor (or fail outright on a detached volume), so
//      `--depth=1 --single-branch` is the only thinning used: history is
//      truncated, blobs at the tip are all present, anchors resolve
//      locally. Clone failures are FATAL when the repo is missing (first
//      boot cannot plan without grounding); fetch failures on later boots
//      are a WARN (the repo is present — stale is degraded, not dead, and
//      fetch-before-plan will surface staleness per-plan anyway).
//
//   3. EXEC THE SUPERVISOR — node cannot exec(2), so: spawn
//      service/supervise.mjs with inherited stdio, forward SIGTERM/SIGINT,
//      and exit with its code.
//
// CREDENTIAL HYGIENE: GITHUB_TOKEN is passed to git per-invocation via
// ENVIRONMENT-based config (deploy/lib.mjs gitAuthEnv — GIT_CONFIG_COUNT/
// KEY_0/VALUE_0), never argv and never a URL on the command line: the
// persisted `origin` remote stays CLEAN, so the token never lands in
// .git/config on the volume (a volume outlives token rotation), and the
// credential never appears in /proc/<pid>/cmdline either. Any git error
// text is scrubbed of x-access-token credentials before logging
// (deploy/lib.mjs scrub), and the token itself is NEVER logged.

import { readEnv } from '../dashboard/lib/env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, gitAuthEnv, resolveGroundingRepos } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const DATA = '/data';

function log(line) {
  // eslint-disable-next-line no-console
  console.error(`[radsvinn-entrypoint] ${line}`);
}

function fatal(line) {
  log(`FATAL: ${line}`);
  process.exit(1);
}

function runGit(args, env = process.env) {
  return spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
}

// -- 1. volume layout --------------------------------------------------------

try {
  fs.accessSync(DATA, fs.constants.W_OK);
} catch {
  fatal(`${DATA} is missing or not writable — is the Railway volume mounted at ${DATA}?`);
}
for (const sub of ['results', 'home', 'repos']) {
  fs.mkdirSync(path.join(DATA, sub), { recursive: true });
}
process.env.HOME = path.join(DATA, 'home'); // persists the claude session store → --resume survives redeploys
process.env.RADSVINN_RESULTS_DIR = path.join(DATA, 'results');
process.env.RADSVINN_REPOS_ROOT = path.join(DATA, 'repos');
log(`volume ready: results=${readEnv('RADSVINN_RESULTS_DIR')} home=${process.env.HOME} repos=${readEnv('RADSVINN_REPOS_ROOT')}`);

// -- 2. grounding sync -------------------------------------------------------

const groundingRepoConfig = resolveGroundingRepos(readEnv('RADSVINN_GROUNDING_REPOS'));
if (groundingRepoConfig.error) fatal(groundingRepoConfig.error);
const repos = groundingRepoConfig.repos;
// The VCS org that owns the grounding repos is deployment-specific and has NO
// baked-in default — clone URLs are `https://github.com/<org>/<repo>`, so a
// wrong default would silently clone a stranger's repos or 404. Fail loud.
const org = readEnv('RADSVINN_GROUNDING_ORG');
if (!org) fatal('RADSVINN_GROUNDING_ORG is unset — set the GitHub org/owner that hosts your grounding repos (e.g. example-org).');
const githubToken = process.env.GITHUB_TOKEN;

// Per-invocation auth env — see the header's credential-hygiene note and
// deploy/lib.mjs gitAuthEnv's env-not-argv rationale.
const gitEnv = { ...process.env, ...gitAuthEnv(githubToken) };

for (const repo of repos) {
  const dir = path.join(readEnv('RADSVINN_REPOS_ROOT'), repo);
  const cleanUrl = `https://github.com/${org}/${repo}`;

  if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, '.git'))) {
    // Torn clone from a previous crashed boot — clear it and re-clone.
    log(`grounding repo ${repo}: directory exists without .git (torn clone) — removing and re-cloning`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (!fs.existsSync(dir)) {
    if (!githubToken) {
      fatal(`grounding repo ${repo} is missing at ${dir} and GITHUB_TOKEN is unset — set a read-only fetch token so first boot can clone.`);
    }
    log(`grounding repo ${repo}: cloning ${cleanUrl} (shallow, single-branch, full blobs)`);
    const res = runGit(['clone', '--depth=1', '--single-branch', '--branch', 'main', cleanUrl, dir], gitEnv);
    if (res.status !== 0) {
      // A repo we do not have at all is fatal: planning without grounding
      // would gate anchors against nothing.
      fatal(`clone of ${repo} failed (exit ${res.status}): ${scrub(res.stderr, githubToken).slice(-500)}`);
    }
    log(`grounding repo ${repo}: cloned`);
  } else {
    const res = runGit(['-C', dir, 'fetch', '--depth=1', 'origin', 'main'], gitEnv);
    if (res.status !== 0) {
      // Repo already present: stale grounding is degraded, not dead —
      // fetch-before-plan surfaces staleness on every plan anyway.
      log(`WARN: fetch of ${repo} failed (exit ${res.status}) — continuing with the existing checkout: ${scrub(res.stderr, githubToken).slice(-300)}`);
    } else {
      // Fetch updates REFS only — without this reset the WORKING TREE the
      // agent Reads/Greps would stay frozen at the first clone forever
      // while the anchor gate validates fresh origin/main objects. Safe:
      // /data/repos checkouts are disposable read-only grounding clones no
      // human ever commits to. A reset failure is the same degraded-not-
      // dead posture as a fetch failure (fetch-before-plan surfaces staleness per plan).
      const reset = runGit(['-C', dir, 'reset', '--hard', 'origin/main']);
      if (reset.status !== 0) {
        log(`WARN: reset of ${repo} to origin/main failed (exit ${reset.status}) — continuing with the existing checkout: ${scrub(reset.stderr, githubToken).slice(-300)}`);
      } else {
        log(`grounding repo ${repo}: fetched origin/main and reset the checkout to it`);
      }
    }
  }
}

// -- 3. hand off to the supervisor -------------------------------------------

const supervisor = spawn(process.execPath, [path.join(APP_ROOT, 'service', 'supervise.mjs')], {
  cwd: APP_ROOT,
  stdio: 'inherit',
  env: process.env,
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    supervisor.kill(sig);
  });
}
supervisor.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
