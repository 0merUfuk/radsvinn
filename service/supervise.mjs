// supervise.mjs — production supervisor for the two container processes.
//
// Railway runs ONE container; Mercury needs the planner service
// (service/server.mjs) and the Slack Socket Mode bridge (service/slack.mjs)
// alive together. This supervisor is the container's long-running process:
//
//   1. spawn the server, poll GET /healthz until it answers ok
//      (fatal exit 1 after ~60s — a server that never comes up must fail
//      the whole container so Railway's restart policy kicks in);
//   2. spawn the bridge;
//   3. child stdout/stderr INHERIT (Railway captures the container's own
//      streams — no log files to rotate, nothing buffered in RAM);
//   4. a child exiting → restart it with exponential backoff (1s → 30s
//      cap; backoff resets after a child stays up 60s). More than
//      MAX_RESTARTS restarts of the SAME child within RESTART_WINDOW_MS →
//      exit 1 and let Railway restart the whole container — a tight crash
//      loop is a container-level problem (bad env, bad deploy), not
//      something more in-process restarts will fix;
//   5. SIGTERM/SIGINT → forward SIGTERM to both children, wait up to 10s,
//      exit 0. Nothing restarts mid-shutdown.
//
// Zero dependencies, zero local imports — the supervisor must keep running
// (and keep logging) even when the service code it supervises is broken.
//
// Test seams (designed in, not bolted on): the child commands, health URL,
// health timeout/poll cadence, and backoff base are all env-overridable, so
// the smoke suite (service/test/supervise.test.mjs) drives the REAL
// restart/shutdown machinery against tiny fixture scripts — no docker
// needed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MERCURY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BACKOFF_CAP_MS = 30_000;
const BACKOFF_RESET_UPTIME_MS = 60_000;
const MAX_RESTARTS = 5; // strictly more than this within the window is fatal
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 10_000;
const HEALTH_ATTEMPT_TIMEOUT_MS = 900;

function log(line) {
  // stderr, like every other operational line this repo emits.
  // eslint-disable-next-line no-console
  console.error(`[mercury-supervise] ${line}`);
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Whitespace-split command override (the test seam). No shell-quoting
// support — fixture/production commands are plain `node <script>` shapes.
function commandFor(name, defaultScript) {
  const raw = process.env[`MERCURY_SUPERVISE_${name}_CMD`];
  if (raw && raw.trim().length > 0) return raw.trim().split(/\s+/);
  return [process.execPath, path.join(MERCURY_ROOT, defaultScript)];
}

function createSupervisor() {
  const backoffBaseMs = envInt('MERCURY_SUPERVISE_BACKOFF_BASE_MS', 1000);
  const healthUrl = process.env.MERCURY_SUPERVISE_HEALTH_URL
    || `http://127.0.0.1:${process.env.MERCURY_PORT || 8090}/healthz`;
  const healthTimeoutMs = envInt('MERCURY_SUPERVISE_HEALTH_TIMEOUT_MS', 60_000);
  const healthPollMs = envInt('MERCURY_SUPERVISE_HEALTH_POLL_MS', 1000);

  let shuttingDown = false;

  /** name -> child record */
  const children = new Map();

  function makeChild(name, cmd) {
    const child = {
      name,
      cmd,
      proc: null,
      startedAt: 0,
      backoffMs: backoffBaseMs,
      restartTimes: [],
      restartTimer: null,
    };
    children.set(name, child);
    return child;
  }

  function startChild(child) {
    child.startedAt = Date.now();
    child.proc = spawn(child.cmd[0], child.cmd.slice(1), {
      cwd: MERCURY_ROOT,
      stdio: 'inherit', // Railway captures the container streams directly
      env: process.env,
    });
    log(`${child.name} started (pid ${child.proc.pid}): ${child.cmd.join(' ')}`);
    // Per-death guard: on a failed spawn Node can emit BOTH 'error' AND
    // 'exit' for the same process — without this flag one death would run
    // the restart policy twice (two restart timers → duplicate children,
    // double-counted restartTimes). One death, one onChildExit.
    let deathHandled = false;
    const handleDeath = (code, signal) => {
      if (deathHandled) return;
      deathHandled = true;
      onChildExit(child, code, signal);
    };
    child.proc.on('error', (err) => {
      // Spawn failure surfaces as an error, not an exit — route it through
      // the same restart policy so a bad command crash-loops to fatal
      // instead of silently leaving the child dead.
      log(`${child.name} spawn error: ${err.message}`);
      handleDeath(-1);
    });
    child.proc.on('exit', (code, signal) => {
      handleDeath(code, signal);
    });
  }

  function onChildExit(child, code, signal) {
    child.proc = null;
    if (shuttingDown) return; // never restart mid-shutdown

    const uptime = Date.now() - child.startedAt;
    log(`${child.name} exited (code=${code} signal=${signal || 'none'}) after ${Math.round(uptime / 1000)}s`);

    // A child that stayed up long enough was healthy — its next failure is
    // a fresh incident, not a continuation of the last crash loop.
    if (uptime >= BACKOFF_RESET_UPTIME_MS) child.backoffMs = backoffBaseMs;

    const now = Date.now();
    child.restartTimes = child.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    child.restartTimes.push(now);
    if (child.restartTimes.length > MAX_RESTARTS) {
      log(`FATAL: ${child.name} restarted ${child.restartTimes.length} times within ${RESTART_WINDOW_MS / 60000} minutes — giving up; exiting 1 so the container restarts.`);
      fatalExit();
      return;
    }

    const delay = child.backoffMs;
    child.backoffMs = Math.min(child.backoffMs * 2, BACKOFF_CAP_MS);
    log(`restarting ${child.name} in ${delay}ms`);
    // Belt and suspenders under the per-death guard in startChild: never
    // let two live restart timers exist for one child — the older one would
    // spawn a duplicate process the supervisor no longer tracks.
    if (child.restartTimer) clearTimeout(child.restartTimer);
    child.restartTimer = setTimeout(() => {
      child.restartTimer = null;
      if (!shuttingDown) startChild(child);
    }, delay);
  }

  function killAll(signal) {
    for (const child of children.values()) {
      if (child.restartTimer) {
        clearTimeout(child.restartTimer);
        child.restartTimer = null;
      }
      if (child.proc) {
        try {
          child.proc.kill(signal);
        } catch {
          // already dead — nothing to do
        }
      }
    }
  }

  function fatalExit() {
    shuttingDown = true;
    killAll('SIGTERM');
    process.exit(1);
  }

  function liveCount() {
    let n = 0;
    for (const child of children.values()) if (child.proc) n += 1;
    return n;
  }

  async function shutdown(signalName) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signalName} received — forwarding SIGTERM to children`);
    killAll('SIGTERM');
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (liveCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (liveCount() > 0) {
      log(`children still alive after ${SHUTDOWN_GRACE_MS}ms — SIGKILL`);
      killAll('SIGKILL');
    }
    log('shutdown complete');
    process.exit(0);
  }

  async function healthOk() {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_ATTEMPT_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function run() {
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    process.on('SIGINT', () => { shutdown('SIGINT'); });

    const server = makeChild('server', commandFor('SERVER', 'service/server.mjs'));
    const bridge = makeChild('bridge', commandFor('BRIDGE', 'service/slack.mjs'));

    startChild(server);

    // Gate the bridge on the server actually answering — the bridge's very
    // first act is GET /plans boot-resume, and pointing it at a socket that
    // isn't listening yet just burns its own retry budget. A server that
    // never comes healthy fails the WHOLE container (exit 1) so Railway
    // restarts it — a half-up container that looks alive is worse than a
    // restart. Server crash-during-poll is fine: the exit handler restarts
    // it and this loop keeps polling until the overall deadline.
    const healthDeadline = Date.now() + healthTimeoutMs;
    log(`waiting for ${healthUrl} (up to ${healthTimeoutMs}ms)`);
    for (;;) {
      if (shuttingDown) return;
      if (await healthOk()) break;
      if (Date.now() > healthDeadline) {
        log(`FATAL: server never became healthy at ${healthUrl} within ${healthTimeoutMs}ms — exiting 1.`);
        fatalExit();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, healthPollMs));
    }
    log('server healthy — starting bridge');

    if (!shuttingDown) startChild(bridge);
  }

  return { run };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  createSupervisor().run().catch((err) => {
    log(`FATAL: supervisor crashed: ${err.message}`);
    process.exit(1);
  });
}
