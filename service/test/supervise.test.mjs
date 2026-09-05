// supervise.test.mjs — B5: smoke tests over the REAL supervisor
// (service/supervise.mjs) driven through its designed-in env seams
// (RADSVINN_SUPERVISE_{SERVER,BRIDGE}_CMD + the health/backoff knobs)
// against tiny fixture scripts. CI-safe: no docker, no network beyond
// loopback, every child is killed in t.after.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SUPERVISE = path.join(ROOT, 'service', 'supervise.mjs');

const FIXTURE_SERVER = path.join(HERE, 'supervise-fixture-server.mjs');
const FIXTURE_BRIDGE = path.join(HERE, 'supervise-fixture-bridge.mjs');
const FIXTURE_CRASH_ONCE = path.join(HERE, 'supervise-fixture-crash-once.mjs');
const FIXTURE_CRASH_LOOP = path.join(HERE, 'supervise-fixture-crash-loop.mjs');
const FIXTURE_IDLE = path.join(HERE, 'supervise-fixture-idle.mjs');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startSupervisor(t, { serverFixture, bridgeFixture, env = {} }) {
  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (k.startsWith('RADSVINN_SUPERVISE_')) delete cleanEnv[k];
  }
  delete cleanEnv.RADSVINN_PORT;

  const child = spawn(process.execPath, [SUPERVISE], {
    cwd: ROOT,
    env: {
      ...cleanEnv,
      RADSVINN_SUPERVISE_SERVER_CMD: `${process.execPath} ${serverFixture}`,
      RADSVINN_SUPERVISE_BRIDGE_CMD: `${process.execPath} ${bridgeFixture}`,
      RADSVINN_SUPERVISE_HEALTH_POLL_MS: '50',
      ...env,
    },
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

async function until(fn, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('B5: happy boot — server first, bridge only after /healthz answers; SIGTERM terminates both children and exits 0', async (t) => {
  const port = await freePort();
  const { child, out, exited } = startSupervisor(t, {
    serverFixture: FIXTURE_SERVER,
    bridgeFixture: FIXTURE_BRIDGE,
    env: { RADSVINN_PORT: String(port) },
  });

  await until(() => out.stdout.includes('fixture-bridge started'));
  const serverIdx = out.stdout.indexOf('fixture-server listening');
  const bridgeIdx = out.stdout.indexOf('fixture-bridge started');
  assert.ok(serverIdx !== -1 && serverIdx < bridgeIdx, 'the server came up before the bridge was spawned');
  assert.match(out.stderr, /server healthy — starting bridge/);

  child.kill('SIGTERM');
  const code = await exited;
  assert.equal(code, 0, 'clean shutdown exits 0');
  assert.match(out.stdout, /fixture-server terminated/, 'SIGTERM was forwarded to the server');
  assert.match(out.stdout, /fixture-bridge terminated/, 'SIGTERM was forwarded to the bridge');
  assert.match(out.stderr, /shutdown complete/);
});

test('B5: a crashed child is RESTARTED (with backoff) and the supervisor keeps running', async (t) => {
  const port = await freePort();
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-supervise-test-')), 'crashed-once');
  t.after(() => fs.rmSync(path.dirname(marker), { recursive: true, force: true }));

  const { child, out, exited } = startSupervisor(t, {
    serverFixture: FIXTURE_SERVER,
    bridgeFixture: FIXTURE_CRASH_ONCE,
    env: {
      RADSVINN_PORT: String(port),
      RADSVINN_TEST_MARKER: marker,
      RADSVINN_SUPERVISE_BACKOFF_BASE_MS: '50',
    },
  });

  // First run crashes; the restarted run prints "stable" — that line
  // existing at all proves the restart happened.
  await until(() => out.stdout.includes('fixture-crash-once stable'));
  assert.match(out.stdout, /fixture-crash-once crashing/);
  assert.match(out.stderr, /bridge exited \(code=1/);
  assert.match(out.stderr, /restarting bridge in \d+ms/);

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('B5: a tight crash loop (>5 restarts in the window) is FATAL — exit 1 so the container restarts', async (t) => {
  const port = await freePort();
  const { out, exited } = startSupervisor(t, {
    serverFixture: FIXTURE_SERVER,
    bridgeFixture: FIXTURE_CRASH_LOOP,
    env: {
      RADSVINN_PORT: String(port),
      RADSVINN_SUPERVISE_BACKOFF_BASE_MS: '10',
    },
  });

  const code = await exited;
  assert.equal(code, 1);
  assert.match(out.stderr, /FATAL: bridge restarted \d+ times/);
  // The sibling was SIGTERMed on the way out, but its inherited-stdio
  // farewell can land AFTER the supervisor's own exit event — poll for it.
  await until(() => /fixture-server terminated/.test(out.stdout));
});

test('B5: a spawn-error child (nonexistent binary) runs the restart policy EXACTLY once per death — no error+exit double-fire — and crash-loops to fatal', async (t) => {
  const port = await freePort();
  const { out, exited } = startSupervisor(t, {
    serverFixture: FIXTURE_SERVER,
    bridgeFixture: FIXTURE_BRIDGE, // overridden by the env below
    env: {
      RADSVINN_PORT: String(port),
      RADSVINN_SUPERVISE_BRIDGE_CMD: '/nonexistent/radsvinn-no-such-binary',
      RADSVINN_SUPERVISE_BACKOFF_BASE_MS: '10',
    },
  });

  const code = await exited;
  assert.equal(code, 1, 'a spawn-error crash loop is fatal like any other crash loop');
  assert.match(out.stderr, /bridge spawn error/);
  // One death, one restart decision: 6 deaths (the initial spawn + 5
  // restarts) hit MAX_RESTARTS=5, so exactly 5 "restarting" lines precede
  // the fatal 6th. A double-fired death (Node can emit BOTH 'error' and
  // 'exit' for a failed spawn) would skew both counts.
  assert.match(out.stderr, /FATAL: bridge restarted 6 times/);
  assert.equal((out.stderr.match(/bridge spawn error/g) || []).length, 6, 'six deaths, each logged once');
  assert.equal((out.stderr.match(/restarting bridge in \d+ms/g) || []).length, 5, 'five restarts scheduled — never two per death');
});

test('B5: a server that never becomes healthy is FATAL after the deadline — the bridge is never spawned', async (t) => {
  const port = await freePort(); // nothing will listen here
  const { out, exited } = startSupervisor(t, {
    serverFixture: FIXTURE_IDLE,
    bridgeFixture: FIXTURE_BRIDGE,
    env: {
      RADSVINN_PORT: String(port),
      RADSVINN_SUPERVISE_HEALTH_TIMEOUT_MS: '600',
    },
  });

  const code = await exited;
  assert.equal(code, 1);
  assert.match(out.stderr, /FATAL: server never became healthy/);
  assert.ok(!out.stdout.includes('fixture-bridge started'), 'the bridge was never spawned');
});
