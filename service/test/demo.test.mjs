import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoTimeoutError, runDemo, seedGroundingRoot } from '../demo.mjs';
import { createEngine } from '../engine.mjs';
import { createServer } from '../server.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..');
const DEMO_PATH = path.join(ROOT, 'service', 'demo.mjs');
const ASK_PATH = path.join(ROOT, 'fixtures', 'demo', 'ask.md');
const POISONED_DEMO_ENV = {
  RADSVINN_DAILY_HARD_USD: '0',
  RADSVINN_DAILY_SOFT_USD: '0',
  RADSVINN_PLAN_BUDGET_USD: '0',
  RADSVINN_FAKE_GROOM_FAIL: '1',
  RADSVINN_FAKE_GROOM_TRUNCATED: '1',
  RADSVINN_FAKE_CREATE_FAIL: '1',
  RADSVINN_FAKE_CREATE_PARTIAL: '1',
  RADSVINN_FAKE_VERIFY_FAIL: '1',
  RADSVINN_FAKE_VERIFY_REJECT: '1',
  RADSVINN_FAKE_CLEANUP_FAIL: '1',
  RADSVINN_TREECHECK_BIN: '/definitely/not/the/real/treecheck',
  RADSVINN_COUPLING_MAP: '/definitely/not/the/default/coupling-map.yaml',
};

function tempParent(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-demo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('fake demo traverses the real service state machine, both human actions, and cleans up', async (t) => {
  const parent = tempParent(t);
  const logs = [];
  const result = await runDemo({
    askPath: ASK_PATH,
    timeoutMs: 30_000,
    tempParent: parent,
    logger: (line) => logs.push(line),
  });

  assert.equal(result.status, 'created');
  assert.deepEqual(result.statuses, [
    'breaking_down', 'shape_ready', 'grooming', 'plan_ready', 'creating', 'created',
  ]);
  assert.deepEqual(result.actions, ['approve_shape', 'create_tree']);
  assert.deepEqual(result.created.keys, ['PROJ-999']);
  assert.equal(result.created.verify_ok, true);
  assert.equal(result.skeleton_gate.ok, true);
  assert.equal(result.skeleton_gate.skipped, undefined, 'the real skeleton gate ran');
  assert.equal(result.skeleton_gate.exitCode, 0);
  assert.equal(result.skeleton_gate.raw.ok, true);
  assert.equal(result.skeleton_gate.raw.checks.acyclic.pass, true);
  assert.equal(result.plan_gate.ok, true);
  assert.equal(result.plan_gate.skipped, undefined, 'the real plan gate ran despite the suite skip env');
  assert.equal(result.plan_gate.exitCode, 0);
  assert.equal(result.plan_gate.raw.ok, true);
  for (const verdict of Object.values(result.plan_gate.raw.items)) {
    assert.equal(verdict.checks.anchors_exist.pass, true, 'every fixture anchor resolves on local origin/main');
    assert.doesNotMatch(
      (verdict.checks.anchors_exist.complaints || []).join('\n'),
      /origin\/main unavailable/,
      'the gate did not fall back to the working tree',
    );
  }
  assert.match(logs.join('\n'), /human action 1\/2: approve shape/);
  assert.match(logs.join('\n'), /human action 2\/2: approve creation/);

  assert.equal(fs.existsSync(result.resultsDir), false, 'temporary results are removed');
  assert.deepEqual(fs.readdirSync(parent), [], 'the caller-provided temp parent is empty');
  await assert.rejects(fetch(`${result.baseUrl}/healthz`), 'the loopback server is closed');
});

test('fake demo timeout rejects and still removes temp state and closes the listener', async (t) => {
  const parent = tempParent(t);
  const fake = createEngine('fake');
  let releasePhase1;
  const phase1Hold = new Promise((resolve) => { releasePhase1 = resolve; });
  let phase1Started = false;
  let phase1Finished = false;
  let phase1Released = false;
  const heldEngine = {
    ...fake,
    async phase1(args) {
      phase1Started = true;
      await phase1Hold;
      const result = await fake.phase1(args);
      phase1Finished = true;
      return result;
    },
  };
  const requestedUrls = [];
  const submitThenHang = async (url, init) => {
    requestedUrls.push(url);
    if (url.endsWith('/plan') && init.method === 'POST') return fetch(url, init);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        phase1Released = true;
        releasePhase1();
        reject(new Error('aborted by test'));
      }, { once: true });
    });
  };

  await assert.rejects(
    runDemo({
      askPath: ASK_PATH,
      timeoutMs: 50,
      cleanupTimeoutMs: 30_000,
      tempParent: parent,
      fetchImpl: submitThenHang,
      engine: heldEngine,
      logger: () => {},
    }),
    DemoTimeoutError,
  );
  assert.match(requestedUrls[0], /^http:\/\/127\.0\.0\.1:\d+\/plan$/);
  assert.match(requestedUrls[1], /^http:\/\/127\.0\.0\.1:\d+\/plan\/[0-9a-f-]+$/);
  assert.equal(phase1Started, true, 'the worker was definitely in flight at the timeout');
  assert.equal(phase1Released, true, 'the deterministic timeout released the held worker');
  assert.equal(phase1Finished, true, 'error cleanup drained the worker before returning');
  assert.deepEqual(fs.readdirSync(parent), [], 'timeout cleanup removes temporary results');
  const baseUrl = new URL(requestedUrls[0]).origin;
  await assert.rejects(fetch(`${baseUrl}/healthz`), 'timeout cleanup closes the server');
});

test('demo request deadline remains armed while the response body is stalled', async (t) => {
  const parent = tempParent(t);
  let requestedUrl;
  const stalledBodyFetch = (url, { signal }) => {
    requestedUrl = url;
    return Promise.resolve({
      ok: true,
      status: 202,
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('stalled body aborted')), { once: true });
      }),
    });
  };

  await assert.rejects(
    runDemo({
      askPath: ASK_PATH,
      timeoutMs: 25,
      tempParent: parent,
      fetchImpl: stalledBodyFetch,
      logger: () => {},
    }),
    DemoTimeoutError,
  );
  assert.match(requestedUrl, /^http:\/\/127\.0\.0\.1:\d+\/plan$/);
  assert.deepEqual(fs.readdirSync(parent), [], 'stalled-body cleanup removes temporary results');
});

test('grounding seed rejects unsafe fixture repo names before any repo write', (t) => {
  const parent = tempParent(t);
  const cases = [
    { itemRepo: '../escape', anchorRepo: 'web-app' },
    { itemRepo: 'web-app', anchorRepo: '../escape' },
    { itemRepo: 'nested/repo', anchorRepo: 'web-app' },
    { itemRepo: 'web-app', anchorRepo: '..' },
  ];

  for (const [index, entry] of cases.entries()) {
    const resultsDir = path.join(parent, `unsafe-${index}`);
    fs.mkdirSync(resultsDir);
    const plan = {
      items: [{
        repo: entry.itemRepo,
        fields: { related_links: { code_anchors: [`${entry.anchorRepo}:src/file.ts:Symbol`] } },
      }],
    };
    assert.throws(() => seedGroundingRoot(resultsDir, plan), /unsafe fixture repository slug/);
    assert.equal(fs.existsSync(path.join(resultsDir, 'grounding')), false, 'validation precedes grounding writes');
  }
  assert.equal(fs.existsSync(path.join(parent, 'escape')), false, 'no traversal target was created');
});

test('grounding git setup ignores every inherited GIT_* poison variable', (t) => {
  const parent = tempParent(t);
  const resultsDir = path.join(parent, 'poisoned-git');
  fs.mkdirSync(resultsDir);
  const poison = {
    GIT_CONFIG_PARAMETERS: 'malformed poison',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/definitely/not/a/hooks/path',
    GIT_COMMON_DIR: '/definitely/not/a/common-dir',
    GIT_OBJECT_DIRECTORY: '/definitely/not/an/object-dir',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/definitely/not/alternate-objects',
    GIT_DIR: '/definitely/not/a/git-dir',
    GIT_WORK_TREE: '/definitely/not/a/work-tree',
    GIT_INDEX_FILE: '/definitely/not/an/index',
  };
  const previous = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  Object.assign(process.env, poison);
  let groundingRoot;
  try {
    groundingRoot = seedGroundingRoot(resultsDir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const repoDir = path.join(groundingRoot, 'web-app');
  assert.equal(fs.existsSync(path.join(repoDir, '.git')), true);
  const originMain = fs.readFileSync(path.join(repoDir, '.git', 'refs', 'remotes', 'origin', 'main'), 'utf8').trim();
  assert.match(originMain, /^[0-9a-f]{40,64}$/);
});

test('fake engine fault env is injectable while a clean env remains fault-free', async (t) => {
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-clean-fake-env-'));
  const faultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-fault-fake-env-'));
  t.after(() => fs.rmSync(cleanDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(faultDir, { recursive: true, force: true }));

  const clean = createEngine('fake', { env: {} });
  const faulty = createEngine('fake', { env: { RADSVINN_FAKE_GROOM_FAIL: '1' } });
  const cleanPhase = await clean.phase1({ runDir: cleanDir });
  await clean.groom({ runDir: cleanDir, sessionId: cleanPhase.sessionId });
  assert.equal(fs.existsSync(path.join(cleanDir, 'plan.json')), true);

  const faultPhase = await faulty.phase1({ runDir: faultDir });
  await assert.rejects(
    faulty.groom({ runDir: faultDir, sessionId: faultPhase.sessionId }),
    /groom failed/,
  );
});

test('make demo succeeds despite inherited breaker, fake-fault, and gate-override poison', () => {
  const result = spawnSync('make', ['demo'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...POISONED_DEMO_ENV },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /real skeleton gate passed/);
  assert.match(result.stdout, /human action 1\/2: approve shape/);
  assert.match(result.stdout, /real plan gate passed against local origin\/main/);
  assert.match(result.stdout, /human action 2\/2: approve creation/);
  assert.match(result.stdout, /\[demo\] created PROJ-999/);
});

test('demo CLI exits nonzero on errors', () => {
  const missingAsk = path.join(os.tmpdir(), `radsvinn-missing-ask-${process.pid}.md`);
  const result = spawnSync(process.execPath, [DEMO_PATH, missingAsk], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[demo\] failed:/);
  assert.match(result.stderr, /ENOENT/);
});

test('real createServer refuses the fake-only whole-plan-gate skip even with an injected gate', (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-real-skip-refusal-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
  const previous = process.env.RADSVINN_SKIP_PLAN_ANCHORS;
  process.env.RADSVINN_SKIP_PLAN_ANCHORS = '1';
  try {
    assert.throws(
      () => createServer({
        resultsDir,
        engineMode: 'real',
        engine: {},
        gatePlan: async () => ({ ok: true, skipped: true }),
      }),
      /skips the entire plan gate.*allowed only with RADSVINN_ENGINE=fake/,
    );
  } finally {
    if (previous === undefined) delete process.env.RADSVINN_SKIP_PLAN_ANCHORS;
    else process.env.RADSVINN_SKIP_PLAN_ANCHORS = previous;
  }
});

test('createServer.listen rejects bind errors instead of leaving a pending promise', async (t) => {
  const blocker = http.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(() => resolve())));

  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-listen-error-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
  const app = createServer({
    resultsDir,
    engineMode: 'fake',
    engine: createEngine('fake'),
    token: null,
    dashboardToken: null,
  });
  const { port } = blocker.address();

  await assert.rejects(
    app.listen(port, '127.0.0.1'),
    (err) => err && err.code === 'EADDRINUSE',
  );
  await app.close();
});
