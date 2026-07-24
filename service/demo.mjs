// demo.mjs — fake-engine walkthrough with no model, tracker, or remote-grounding calls.
//
// The driver talks to createServer() over loopback instead of calling engine
// methods directly, so it exercises the production HTTP handlers, persisted
// state machine, audit trail, deterministic gates, and both human actions.
// The engine and tracker writer remain fake. A temporary local git repository
// supplies origin/main anchor objects to the real plan gate without a remote.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createEngine } from './engine.mjs';
import { gatePlan, gateSkeleton } from './gates.mjs';
import { createServer } from './server.mjs';
import { TRANSIENT_STATUSES } from './state.mjs';

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MERCURY_ROOT = path.resolve(SERVICE_DIR, '..');
const DEFAULT_ASK_PATH = path.join(MERCURY_ROOT, 'fixtures', 'demo', 'ask.md');
const FIXTURE_PLAN_PATH = path.join(MERCURY_ROOT, 'fixtures', 'e2e-sample', 'plan.json');
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const SAFE_REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEMO_TREECHECK_COMMAND = Object.freeze({
  command: 'go',
  args: Object.freeze(['run', './cmd/treecheck']),
});
const DEMO_COUPLING_MAP = path.join(MERCURY_ROOT, 'coupling-map.yaml');

export class DemoTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoTimeoutError';
  }
}

function parseAnchor(anchor) {
  const first = anchor.indexOf(':');
  const second = first < 0 ? -1 : anchor.indexOf(':', first + 1);
  const repo = first < 0 ? '' : anchor.slice(0, first);
  const anchorPath = first < 0
    ? ''
    : anchor.slice(first + 1, second < 0 ? undefined : second);
  const symbol = second < 0 ? '' : anchor.slice(second + 1);
  if (!repo || !anchorPath) throw new Error(`invalid fixture anchor: ${anchor}`);
  return { repo, anchorPath, symbol };
}

function gitEnv(configPath) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: configPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Mercury Demo',
    GIT_AUTHOR_EMAIL: 'demo@mercury.invalid',
    GIT_COMMITTER_NAME: 'Mercury Demo',
    GIT_COMMITTER_EMAIL: 'demo@mercury.invalid',
  };
}

function runGit(repoDir, args, { configPath, hooksPath }) {
  try {
    execFileSync('git', [
      '-c', `core.hooksPath=${hooksPath}`,
      '-c', 'commit.gpgSign=false',
      ...args,
    ], {
      cwd: repoDir,
      env: gitEnv(configPath),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`demo grounding git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`, { cause: err });
  }
}

/** Seeds every repo/path/symbol cited by the existing fake plan fixture. */
export function seedGroundingRoot(resultsDir, suppliedPlan) {
  const plan = suppliedPlan || JSON.parse(fs.readFileSync(FIXTURE_PLAN_PATH, 'utf8'));
  const fixtureRepoNames = new Set((plan.items || []).map((item) => item.repo));
  const anchors = (plan.items || []).flatMap((item) => (
    item.fields?.related_links?.code_anchors || []
  ));
  if (anchors.length === 0) throw new Error('demo fixture plan has no code anchors to seed');

  const groundingRoot = path.resolve(resultsDir, 'grounding');
  const files = new Map();
  const repoDirs = new Set();
  for (const anchor of anchors) {
    const { repo, anchorPath, symbol } = parseAnchor(anchor);
    fixtureRepoNames.add(repo);
    const repoDir = path.resolve(groundingRoot, repo);
    if (!SAFE_REPO_SLUG.test(repo) || path.dirname(repoDir) !== groundingRoot) {
      throw new Error(`unsafe fixture repository slug: ${JSON.stringify(repo)}`);
    }
    const filePath = path.resolve(repoDir, anchorPath);
    if (!filePath.startsWith(`${path.resolve(repoDir)}${path.sep}`)) {
      throw new Error(`fixture anchor escapes its repository: ${anchor}`);
    }
    repoDirs.add(repoDir);
    const symbols = files.get(filePath) || new Set();
    if (symbol) symbols.add(symbol);
    files.set(filePath, symbols);
  }
  // Validate item.repo values too, including a repo that happens to have no
  // anchor. All validation completes before any mkdir, write, or git command.
  for (const repo of fixtureRepoNames) {
    const repoDir = typeof repo === 'string' ? path.resolve(groundingRoot, repo) : '';
    if (typeof repo !== 'string' || !SAFE_REPO_SLUG.test(repo) || path.dirname(repoDir) !== groundingRoot) {
      throw new Error(`unsafe fixture repository slug: ${JSON.stringify(repo)}`);
    }
  }

  for (const [filePath, symbols] of files) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const symbolLines = [...symbols].map((symbol) => `// anchor symbol: ${symbol}`);
    fs.writeFileSync(filePath, [
      '// Placeholder tracked only inside the temporary Mercury demo grounding repo.',
      ...symbolLines,
      '',
    ].join('\n'));
  }

  const gitSandboxDir = path.join(resultsDir, 'git-sandbox');
  const configPath = path.join(gitSandboxDir, 'empty.gitconfig');
  const hooksPath = path.join(gitSandboxDir, 'empty-hooks');
  const templateDir = path.join(gitSandboxDir, 'empty-template');
  fs.mkdirSync(hooksPath, { recursive: true });
  fs.mkdirSync(templateDir, { recursive: true });
  fs.writeFileSync(configPath, '');
  const gitOptions = { configPath, hooksPath };
  for (const repoDir of repoDirs) {
    runGit(repoDir, ['init', '--quiet', `--template=${templateDir}`], gitOptions);
    runGit(repoDir, ['add', '--all'], gitOptions);
    runGit(repoDir, ['commit', '--quiet', '--no-gpg-sign', '-m', 'Seed Mercury demo anchors'], gitOptions);
    // The checker resolves only git objects reachable from origin/main. This
    // local remote-tracking ref has no configured remote and performs no I/O.
    runGit(repoDir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], gitOptions);
  }
  return groundingRoot;
}

function assertLoopback(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error(`demo refused non-loopback request: ${url}`);
  }
}

async function requestJson(fetchImpl, url, { method = 'GET', body, deadline, operation }) {
  assertLoopback(url);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DemoTimeoutError(`${operation} timed out`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref?.();
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    // Keep the same deadline armed until the entire body arrives. Receiving
    // headers is not a completed API call when a peer can stall response.text().
    text = await response.text();
  } catch (err) {
    if (controller.signal.aborted) throw new DemoTimeoutError(`${operation} timed out`);
    throw new Error(`${operation} failed: ${err.message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(`${operation} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus({ fetchImpl, baseUrl, planId, expected, pending, deadline, pollIntervalMs }) {
  for (;;) {
    const plan = await requestJson(fetchImpl, `${baseUrl}/plan/${planId}`, {
      deadline,
      operation: `waiting for ${expected}`,
    });
    if (plan.status === expected) return plan;
    if (!pending.has(plan.status)) {
      const detail = plan.error ? `: ${plan.error}` : '';
      throw new Error(`expected ${expected}, planner reached ${plan.status}${detail}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DemoTimeoutError(`waiting for ${expected} timed out`);
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

async function drainTransientPlans(state, { timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = [...state.plans.values()].filter((plan) => TRANSIENT_STATUSES.has(plan.status));
    if (active.length === 0) return;
    if (Date.now() >= deadline) {
      const summary = active.map((plan) => `${plan.plan_id}:${plan.status}`).join(', ');
      throw new DemoTimeoutError(`cleanup timed out waiting for planner workers: ${summary}`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Runs one fake plan through both human gates and returns its terminal view.
 * The loopback listener is closed before cleanup. On an error, every transient
 * plan in this isolated State is drained before its OS-temp root is removed.
 */
export async function runDemo(options = {}) {
  const askPath = path.resolve(options.askPath || DEFAULT_ASK_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || console.log;
  const tempParent = options.tempParent || os.tmpdir();

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('demo timeout must be a positive number of milliseconds');
  }
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new Error('demo cleanup timeout must be a positive number of milliseconds');
  }
  if (typeof fetchImpl !== 'function') throw new Error('demo requires a fetch implementation');

  const description = fs.readFileSync(askPath, 'utf8').trim();
  if (!description) throw new Error(`demo ask is empty: ${askPath}`);

  const resultsDir = fs.mkdtempSync(path.join(tempParent, 'mercury-demo-'));
  let app;
  let baseUrl;
  let outcome;
  let runError;
  const statuses = [];
  const actions = [];

  try {
    const groundingRoot = seedGroundingRoot(resultsDir);
    app = createServer({
      resultsDir,
      engineMode: 'fake',
      engine: options.engine || createEngine('fake', { env: {} }),
      breakerEnv: {},
      token: null,
      dashboardToken: null,
      // Demo isolation: inherited operator overrides must not substitute the
      // checker or map. The walkthrough always exercises the repository's real
      // Go gate and default coupling map against its seeded local origin/main.
      gateSkeleton: (runDir) => gateSkeleton(runDir, {
        checkerCommand: DEMO_TREECHECK_COMMAND,
      }),
      gatePlan: (runDir) => gatePlan(runDir, {
        reposRoot: groundingRoot,
        couplingMapPath: DEMO_COUPLING_MAP,
        checkerCommand: DEMO_TREECHECK_COMMAND,
      }),
      fetchGroundingRepos: async () => undefined,
    });

    const address = await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const deadline = Date.now() + timeoutMs;

    const submitted = await requestJson(fetchImpl, `${baseUrl}/plan`, {
      method: 'POST',
      body: { description, requester: 'demo-user', mode: 'front_door' },
      deadline,
      operation: 'submitting demo plan',
    });
    const planId = submitted.plan_id;
    statuses.push(submitted.status);
    logger(`[demo] submitted ${planId}`);

    const shapeReady = await waitForStatus({
      fetchImpl, baseUrl, planId, expected: 'shape_ready',
      pending: new Set(['breaking_down']), deadline, pollIntervalMs,
    });
    statuses.push(shapeReady.status);
    logger('[demo] real skeleton gate passed — exercising human action 1/2: approve shape');

    const approved = await requestJson(fetchImpl, `${baseUrl}/plan/${planId}/approve-shape`, {
      method: 'POST', body: {}, deadline, operation: 'approving demo shape',
    });
    actions.push('approve_shape');
    statuses.push(approved.status);

    const planReady = await waitForStatus({
      fetchImpl, baseUrl, planId, expected: 'plan_ready',
      pending: new Set(['grooming']), deadline, pollIntervalMs,
    });
    statuses.push(planReady.status);
    logger('[demo] real plan gate passed against local origin/main — exercising human action 2/2: approve creation');

    const creating = await requestJson(fetchImpl, `${baseUrl}/plan/${planId}/create`, {
      method: 'POST', body: {}, deadline, operation: 'approving demo creation',
    });
    actions.push('create_tree');
    statuses.push(creating.status);

    const terminal = await waitForStatus({
      fetchImpl, baseUrl, planId, expected: 'created',
      pending: new Set(['creating']), deadline, pollIntervalMs,
    });
    statuses.push(terminal.status);
    logger(`[demo] created ${terminal.created.keys.join(', ')} (fake tracker; no tracker writes)`);

    outcome = {
      ...terminal,
      baseUrl,
      resultsDir,
      statuses,
      actions,
    };
  } catch (err) {
    runError = err;
  }

  // Stop accepting work first. A worker already dispatched by an accepted
  // request is independent of the listener, so error cleanup then drains every
  // transient plan from this demo's isolated State before deleting its files.
  let closeError;
  if (app) {
    try {
      await app.close();
    } catch (err) {
      closeError = err;
    }
  }

  let drainError;
  if (runError && app) {
    try {
      await drainTransientPlans(app._state, { timeoutMs: cleanupTimeoutMs, pollIntervalMs });
    } catch (err) {
      drainError = err;
    }
  }

  let removeError;
  if (!drainError) {
    try {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    } catch (err) {
      removeError = err;
    }
  }

  const cleanupError = closeError || drainError || removeError;
  if (runError) {
    if (cleanupError) {
      const retained = drainError ? `; temporary state retained at ${resultsDir}` : '';
      throw new Error(`${runError.message}; demo cleanup failed: ${cleanupError.message}${retained}`, { cause: runError });
    }
    throw runError;
  }
  if (cleanupError) throw new Error(`demo cleanup failed: ${cleanupError.message}`, { cause: cleanupError });
  return outcome;
}

function cliTimeoutMs() {
  const raw = process.env.MERCURY_DEMO_TIMEOUT_MS;
  return raw === undefined ? DEFAULT_TIMEOUT_MS : Number(raw);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  runDemo({ askPath: process.argv[2], timeoutMs: cliTimeoutMs() }).catch((err) => {
    console.error(`[demo] failed: ${err.message}`);
    process.exitCode = 1;
  });
}
