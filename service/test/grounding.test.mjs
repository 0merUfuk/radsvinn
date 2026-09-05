// grounding.test.mjs — B4: the configurable grounding root + fetch-before-plan's
// fetch-before-plan. Real `git` against tmp fixtures (a local repo whose
// origin is a sibling BARE repo — zero network), the real server + fake
// engine for the service-level wire, and the pure skeletonMessage builder
// for the visible-degradation contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reposRoot, fetchGroundingRepos } from '../grounding.mjs';
import { skeletonMessage } from '../slack-blocks.mjs';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RADSVINN_ROOT = path.resolve(HERE, '..', '..');

function git(args, opts = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8', ...opts });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// A grounding root containing one healthy repo: `<root>/<name>` cloned from
// a sibling bare origin, so `git fetch origin main` succeeds with zero
// network.
function makeRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-grounding-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repos');
  fs.mkdirSync(root);
  return { base, root };
}

function addHealthyRepo(base, root, name) {
  const bare = path.join(base, `${name}-origin.git`);
  git(['init', '--bare', '--initial-branch=main', bare]);
  const seed = path.join(base, `${name}-seed`);
  git(['init', '--initial-branch=main', seed]);
  fs.writeFileSync(path.join(seed, 'file.txt'), `${name}\n`);
  git(['-C', seed, 'add', '.']);
  git(['-C', seed, '-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'seed']);
  git(['-C', seed, 'push', bare, 'main']);
  git(['clone', bare, path.join(root, name)]);
}

function addBrokenRepo(root, name) {
  const dir = path.join(root, name);
  git(['init', '--initial-branch=main', dir]);
  git(['-C', dir, 'remote', 'add', 'origin', '/nonexistent/nowhere.git']);
}

function withEnv(t, key, value) {
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// A fake `git` on PATH that dumps the auth-relevant environment it received
// and exits as told — the house-clean seam for asserting WHAT fetchOne's
// spawn carries without shipping a token to any real git.
function makeGitShim(t, { exitCode = 0, stderrLine = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-git-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dump = path.join(dir, 'env-dump.txt');
  const script = [
    '#!/bin/sh',
    '{',
    '  echo "GIT_CONFIG_COUNT=${GIT_CONFIG_COUNT-<unset>}"',
    '  echo "GIT_CONFIG_KEY_0=${GIT_CONFIG_KEY_0-<unset>}"',
    '  echo "GIT_CONFIG_VALUE_0=${GIT_CONFIG_VALUE_0-<unset>}"',
    `} >> "${dump}"`,
    stderrLine ? `echo "${stderrLine}" >&2` : ':',
    `exit ${exitCode}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'git'), script);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { shimDir: dir, dump };
}

// The shim never inits real repos — discovery only requires `<dir>/.git`.
function addShimRepo(root, name) {
  fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
}

// ---------------------------------------------------------------------------
// reposRoot()
// ---------------------------------------------------------------------------

test('reposRoot: defaults to the sibling ../grounding, resolved against the radsvinn root', (t) => {
  withEnv(t, 'RADSVINN_REPOS_ROOT', undefined);
  assert.equal(reposRoot(), path.resolve(RADSVINN_ROOT, '..', 'grounding'));
});

test('reposRoot: an absolute RADSVINN_REPOS_ROOT is used as-is; a relative one resolves against the radsvinn root', (t) => {
  withEnv(t, 'RADSVINN_REPOS_ROOT', '/data/repos');
  assert.equal(reposRoot(), '/data/repos');
  withEnv(t, 'RADSVINN_REPOS_ROOT', 'my-repos');
  assert.equal(reposRoot(), path.resolve(RADSVINN_ROOT, 'my-repos'));
});

// ---------------------------------------------------------------------------
// fetchGroundingRepos()
// ---------------------------------------------------------------------------

test('fetch-before-plan: flag off → undefined (no grounding field, legacy shape untouched)', async (t) => {
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', undefined);
  assert.equal(await fetchGroundingRepos(), undefined);
});

test('fetch-before-plan: every repo fetches clean → {ok:true}', async (t) => {
  const { base, root } = makeRoot(t);
  addHealthyRepo(base, root, 'repo-a');
  addHealthyRepo(base, root, 'repo-b');
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  const res = await fetchGroundingRepos();
  assert.deepEqual(res, { ok: true });
});

test('fetch-before-plan: a repo with a bogus origin → ok:false, the failing repo NAMED, the healthy one not blamed — and it never throws', async (t) => {
  const { base, root } = makeRoot(t);
  addHealthyRepo(base, root, 'repo-good');
  addBrokenRepo(root, 'repo-broken');
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  const res = await fetchGroundingRepos();
  assert.equal(res.ok, false);
  assert.match(res.detail, /repo-broken/, 'the failing repo is named');
  assert.doesNotMatch(res.detail, /repo-good/, 'the healthy repo is not blamed');
});

test('fetch-before-plan: zero git repos under the root is a misconfiguration → ok:false', async (t) => {
  const { root } = makeRoot(t);
  fs.mkdirSync(path.join(root, 'not-a-repo')); // a dir without .git is skipped
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  const res = await fetchGroundingRepos();
  assert.equal(res.ok, false);
  assert.match(res.detail, /no git repositories/);
});

test('fetch-before-plan: a missing root → ok:false naming the root, never a throw', async (t) => {
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', '/nonexistent/radsvinn-grounding-root');
  const res = await fetchGroundingRepos();
  assert.equal(res.ok, false);
  assert.match(res.detail, /unreadable/);
  assert.match(res.detail, /\/nonexistent\/radsvinn-grounding-root/);
});

test('fetch-before-plan freshness: an upstream commit+file lands in the WORKING TREE after fetchGroundingRepos, not just in refs', async (t) => {
  const { base, root } = makeRoot(t);
  addHealthyRepo(base, root, 'repo-fresh');
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  withEnv(t, 'GITHUB_TOKEN', undefined); // local-path origin — no auth in play

  // The origin gains a commit + file AFTER the clone: the agent's checkout
  // is now stale in exactly the way fix 2 exists to kill.
  const seed = path.join(base, 'repo-fresh-seed');
  fs.writeFileSync(path.join(seed, 'fresh-file.txt'), 'new upstream content\n');
  git(['-C', seed, 'add', '.']);
  git(['-C', seed, '-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-m', 'upstream moves on']);
  git(['-C', seed, 'push', path.join(base, 'repo-fresh-origin.git'), 'main']);

  const checkoutFile = path.join(root, 'repo-fresh', 'fresh-file.txt');
  assert.equal(fs.existsSync(checkoutFile), false, 'sanity: the clone predates the upstream commit');

  const res = await fetchGroundingRepos();
  assert.deepEqual(res, { ok: true });
  assert.equal(fs.existsSync(checkoutFile), true, 'reset --hard origin/main snapped the checkout to the fetched tip');
});

// ---------------------------------------------------------------------------
// fetch-before-plan auth: env-based git credentials (the container's private grounding repos)
// ---------------------------------------------------------------------------

test('fetch-before-plan auth: with GITHUB_TOKEN set, the git spawn env carries the three GIT_CONFIG_* auth vars; unset → absent', async (t) => {
  const { root } = makeRoot(t);
  addShimRepo(root, 'repo-x');
  const { shimDir, dump } = makeGitShim(t);
  withEnv(t, 'PATH', `${shimDir}${path.delimiter}${process.env.PATH}`);
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  withEnv(t, 'GITHUB_TOKEN', 'shim-token-123');

  const res = await fetchGroundingRepos();
  assert.deepEqual(res, { ok: true });
  const dumped = fs.readFileSync(dump, 'utf8');
  assert.match(dumped, /GIT_CONFIG_COUNT=1/);
  assert.match(dumped, /GIT_CONFIG_KEY_0=url\.https:\/\/x-access-token:shim-token-123@github\.com\/\.insteadOf/);
  assert.match(dumped, /GIT_CONFIG_VALUE_0=https:\/\/github\.com\//);

  // Same run, token gone (withEnv's t.after still restores the original):
  // the auth vars must be ABSENT, not empty — git treats a set-but-empty
  // GIT_CONFIG_COUNT differently from an unset one.
  fs.writeFileSync(dump, '');
  delete process.env.GITHUB_TOKEN;
  await fetchGroundingRepos();
  const dumped2 = fs.readFileSync(dump, 'utf8');
  assert.match(dumped2, /GIT_CONFIG_COUNT=<unset>/);
  assert.match(dumped2, /GIT_CONFIG_KEY_0=<unset>/);
  assert.match(dumped2, /GIT_CONFIG_VALUE_0=<unset>/);
});

test('fetch-before-plan auth: a failing fetch NEVER leaks the token into detail — credentialed URLs and the literal token are masked', async (t) => {
  const { root } = makeRoot(t);
  addShimRepo(root, 'repo-leaky');
  const { shimDir } = makeGitShim(t, {
    exitCode: 128,
    stderrLine: "fatal: unable to access 'https://x-access-token:sekret-token-123@github.com/example-org/repo-leaky/': 403 sekret-token-123 rejected",
  });
  withEnv(t, 'PATH', `${shimDir}${path.delimiter}${process.env.PATH}`);
  withEnv(t, 'RADSVINN_FETCH_BEFORE_PLAN', '1');
  withEnv(t, 'RADSVINN_REPOS_ROOT', root);
  withEnv(t, 'GITHUB_TOKEN', 'sekret-token-123');

  const res = await fetchGroundingRepos();
  assert.equal(res.ok, false);
  assert.match(res.detail, /repo-leaky/, 'the failing repo is still named');
  assert.doesNotMatch(res.detail, /sekret-token-123/, 'the token never reaches the plan record / Slack context line');
  assert.match(res.detail, /x-access-token:\*\*\*@/, 'the credential fragment is masked, not silently dropped');
});

// ---------------------------------------------------------------------------
// service wire: the result rides the plan and toPublicView
// ---------------------------------------------------------------------------

test('fetch-before-plan wire: with the flag on, the plan carries grounding (ok:true here) via GET /plan', async (t) => {
  const { base, root } = makeRoot(t);
  addHealthyRepo(base, root, 'repo-a');
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_FETCH_BEFORE_PLAN: '1',
    RADSVINN_REPOS_ROOT: root,
  });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready',
    { timeoutMs: 30000 },
  );
  assert.deepEqual(shapeReady.body.grounding, { ok: true });
});

test('fetch-before-plan wire: a failing fetch degrades VISIBLY (grounding.ok:false on the plan) and never blocks the plan', async (t) => {
  const { root } = makeRoot(t);
  addBrokenRepo(root, 'repo-broken');
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_FETCH_BEFORE_PLAN: '1',
    RADSVINN_REPOS_ROOT: root,
  });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready',
    { timeoutMs: 30000 },
  );
  assert.equal(shapeReady.body.status, 'shape_ready', 'the plan proceeded despite the failed fetch');
  assert.equal(shapeReady.body.grounding.ok, false);
  assert.match(shapeReady.body.grounding.detail, /repo-broken/);
});

test('fetch-before-plan wire: flag off → NO grounding field on the plan (legacy shape)', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  const shapeReady = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`),
    (r) => r.body.status === 'shape_ready',
    { timeoutMs: 30000 },
  );
  assert.ok(!('grounding' in shapeReady.body), 'JSON drops undefined — legacy plans keep their exact shape');
});

// ---------------------------------------------------------------------------
// visible degradation at the Slack shape gate
// ---------------------------------------------------------------------------

const WARNING = '⚠ grounding fetch failed — anchors may validate against stale code';

function contextText(message) {
  const ctx = message.blocks.find((b) => b.type === 'context');
  return ctx.elements.map((e) => e.text).join(' ');
}

test('fetch-before-plan surface: skeletonMessage appends the stale-anchors warning ONLY when grounding && !grounding.ok', () => {
  const base = { plan_id: '00000000-0000-4000-8000-000000000001', description: 'd', skeleton: { items: [] } };

  const failed = skeletonMessage({ ...base, grounding: { ok: false, detail: 'repo-broken: exit 128' } });
  assert.ok(contextText(failed).includes(WARNING), 'renders the warning on a failed fetch');

  const ok = skeletonMessage({ ...base, grounding: { ok: true } });
  assert.ok(!contextText(ok).includes(WARNING), 'no warning on a clean fetch');

  const legacy = skeletonMessage(base);
  assert.ok(!contextText(legacy).includes(WARNING), 'no warning when the field is absent (flag off / legacy plan)');
});
