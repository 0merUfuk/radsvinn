// fail-closed-boot.test.mjs — fail-closed authentication and
// the env-only Jira credential invariant env-only-token boot check (B3b). These are BOOT-TIME
// behaviors of `node service/server.mjs` run directly — the auto-start
// block, not createServer() — so every test here spawns the real server as
// a child process with a controlled environment and asserts on its exit
// code / stderr / listening line. No test ever sends the child real work:
// the fake engine + a tmp results dir keep boots hermetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(ROOT, 'service', 'server.mjs');

const LISTENING_RE = /planner service listening on/;

// A clean child env: the outer test runner's own mercury knobs must never
// leak into a boot whose whole point is which knobs are (un)set.
function childEnv(t, overrides = {}) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-boot-test-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const k of [
    'MERCURY_SERVICE_TOKEN', 'MERCURY_BIND', 'MERCURY_PORT',
    'MERCURY_REQUIRE_AUTH', 'MERCURY_REQUIRE_ENV_ONLY_TOKEN',
    'MERCURY_SKIP_PLAN_ANCHORS',
  ]) delete env[k];
  return {
    ...env,
    MERCURY_ENGINE: 'fake',
    MERCURY_RESULTS_DIR: resultsDir,
    MERCURY_PORT: '0', // ephemeral — parallel boots never collide
    ...overrides,
  };
}

test('real-mode direct boot refuses the fake-only whole-plan-gate skip before listening', async (t) => {
  const { out, exited } = bootServer(t, {
    MERCURY_ENGINE: 'real',
    MERCURY_SKIP_PLAN_ANCHORS: '1',
  });
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(out.stderr, /MERCURY_SKIP_PLAN_ANCHORS=1 skips the entire plan gate/);
  assert.match(out.stderr, /allowed only with MERCURY_ENGINE=fake/);
  assert.doesNotMatch(out.stdout, LISTENING_RE);
});

function bootServer(t, envOverrides) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv(t, envOverrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, out, exited };
}

async function until(fn, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// B1 — the bind × token matrix
// ---------------------------------------------------------------------------

test('B1: non-loopback bind + NO token → refuses to boot (exit 1, FATAL on stderr, never listens)', async (t) => {
  const { out, exited } = bootServer(t, { MERCURY_BIND: '0.0.0.0' });
  const code = await exited;
  assert.notEqual(code, 0, 'must exit non-zero');
  assert.match(out.stderr, /FATAL/, 'the fatal line lands on stderr');
  assert.match(out.stderr, /not loopback/, 'names the reason');
  assert.match(out.stderr, /MERCURY_SERVICE_TOKEN/, 'names the missing knob');
  assert.doesNotMatch(out.stdout, LISTENING_RE, 'must die BEFORE listening');
});

test('B1: non-loopback bind + EMPTY token → same refusal (empty is not a token)', async (t) => {
  const { out, exited } = bootServer(t, { MERCURY_BIND: '0.0.0.0', MERCURY_SERVICE_TOKEN: '' });
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(out.stderr, /FATAL/);
  assert.doesNotMatch(out.stdout, LISTENING_RE);
});

test('B1: non-loopback bind + a REAL token → boots', async (t) => {
  const { child, out } = bootServer(t, { MERCURY_BIND: '0.0.0.0', MERCURY_SERVICE_TOKEN: 'boot-test-token' });
  await until(() => LISTENING_RE.test(out.stdout));
  assert.doesNotMatch(out.stderr, /FATAL/);
  child.kill('SIGKILL');
});

test("B1: loopback + no token keeps today's behavior — boots", async (t) => {
  const { child, out } = bootServer(t, {}); // default bind 127.0.0.1, no token
  await until(() => LISTENING_RE.test(out.stdout));
  assert.doesNotMatch(out.stderr, /FATAL/);
  child.kill('SIGKILL');
});

test("B1: loopback + EMPTY token keeps today's behavior — boots with the WARN, no fatal", async (t) => {
  const { child, out } = bootServer(t, { MERCURY_SERVICE_TOKEN: '' });
  await until(() => LISTENING_RE.test(out.stdout));
  assert.match(out.stderr, /WARN.*EMPTY/i, "createServer's empty-token warning still fires");
  assert.doesNotMatch(out.stderr, /FATAL/);
  child.kill('SIGKILL');
});

test('B1: MERCURY_REQUIRE_AUTH=1 → fatal without a real token even on loopback (the container belt-and-suspenders)', async (t) => {
  const { out, exited } = bootServer(t, { MERCURY_REQUIRE_AUTH: '1' });
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(out.stderr, /FATAL/);
  assert.match(out.stderr, /MERCURY_REQUIRE_AUTH/);
  assert.doesNotMatch(out.stdout, LISTENING_RE);
});

test('B1: a WHITESPACE-only token is ABSENT (trimmed before the check) — fatal under MERCURY_REQUIRE_AUTH=1 and on a non-loopback bind', async (t) => {
  // A quoting accident in a deploy config ('   ') must not satisfy the
  // fail-closed gate — no client could meaningfully present it.
  const gated = bootServer(t, { MERCURY_REQUIRE_AUTH: '1', MERCURY_SERVICE_TOKEN: '   ' });
  assert.notEqual(await gated.exited, 0, 'REQUIRE_AUTH + whitespace token must exit non-zero');
  assert.match(gated.out.stderr, /FATAL/);
  assert.match(gated.out.stderr, /MERCURY_REQUIRE_AUTH/);
  assert.doesNotMatch(gated.out.stdout, LISTENING_RE);

  const exposed = bootServer(t, { MERCURY_BIND: '0.0.0.0', MERCURY_SERVICE_TOKEN: ' \t ' });
  assert.notEqual(await exposed.exited, 0, 'non-loopback + whitespace token must exit non-zero');
  assert.match(exposed.out.stderr, /FATAL/);
  assert.match(exposed.out.stderr, /not loopback/);
  assert.doesNotMatch(exposed.out.stdout, LISTENING_RE);
});

test('B1: MERCURY_REQUIRE_AUTH=1 + a real token → boots on loopback', async (t) => {
  const { child, out } = bootServer(t, { MERCURY_REQUIRE_AUTH: '1', MERCURY_SERVICE_TOKEN: 'boot-test-token' });
  await until(() => LISTENING_RE.test(out.stdout));
  assert.doesNotMatch(out.stderr, /FATAL/);
  child.kill('SIGKILL');
});

// ---------------------------------------------------------------------------
// B3b — env-only Jira credential invariant: env-only Jira token on servers
// ---------------------------------------------------------------------------

test('B3b: MERCURY_REQUIRE_ENV_ONLY_TOKEN=1 + a file-fallback token under $HOME → refuses to boot, names the file', async (t) => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-boot-home-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
  const tokenFile = path.join(fakeHome, '.config', 'mercury', 'jira-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'file-token-should-not-exist-on-a-server\n');

  const { out, exited } = bootServer(t, {
    HOME: fakeHome, // os.homedir() honors $HOME on POSIX
    MERCURY_REQUIRE_ENV_ONLY_TOKEN: '1',
    MERCURY_SERVICE_TOKEN: 'boot-test-token',
  });
  const code = await exited;
  assert.notEqual(code, 0);
  assert.match(out.stderr, /FATAL/);
  assert.match(out.stderr, /jira-token/, 'names the offending file');
  assert.match(out.stderr, /env-only/i, 'states the rule');
  assert.doesNotMatch(out.stdout, LISTENING_RE);
});

test('B3b: MERCURY_REQUIRE_ENV_ONLY_TOKEN=1 with NO file fallback under $HOME → boots', async (t) => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-boot-home-'));
  t.after(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

  const { child, out } = bootServer(t, {
    HOME: fakeHome,
    MERCURY_REQUIRE_ENV_ONLY_TOKEN: '1',
    MERCURY_SERVICE_TOKEN: 'boot-test-token',
  });
  await until(() => LISTENING_RE.test(out.stdout));
  assert.doesNotMatch(out.stderr, /FATAL/);
  child.kill('SIGKILL');
});
