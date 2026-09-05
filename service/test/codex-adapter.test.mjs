import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexRuntime, resolveBinaryPath } from '../runtimes/codex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_PATH = path.join(ROOT, 'fixtures', 'identity', 'codex-events.jsonl');
const EVENTS = fs.readFileSync(FIXTURE_PATH, 'utf8');
const THREAD_ID = 'fixture-thread';

const BASE_REQ = {
  repoRoot: '/radsvinn-root',
  groundingRoot: ROOT,
  childEnv: {
    PATH: '/fake-bin',
    KEEP_ME: 'safe plumbing',
    ANTHROPIC_API_KEY: 'anthropic-canary',
    OPENAI_API_KEY: 'openai-canary',
  },
  timeoutMs: 1_000,
  // This is Radsvinn's built-in Claude seat default. Codex must treat it as
  // "no Codex override", omit -m, and report codex-default.
  seat: { model: 'opus' },
  userMessage: 'Produce strict JSON.',
  resume: false,
};

function testRuntime(runCodexSpawn) {
  return createCodexRuntime(
    { PATH: '/fake-bin' },
    {
      resolveBinaryPath: () => '/fake-bin/codex',
      runCodexSpawn,
    },
  );
}

function fixtureSpawn(overrides = {}) {
  return async () => ({ stdout: EVENTS, stderr: '', wallMs: 17, ...overrides });
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test('Codex event parsing extracts the thread and agent message, filters malformed-role noise, and rejects other error events', async () => {
  let defaultSeatCall;
  const runtime = testRuntime(async (call) => {
    defaultSeatCall = call;
    return { stdout: EVENTS, stderr: '', wallMs: 17 };
  });
  const result = await runtime.runPhase(BASE_REQ);

  assert.deepEqual(result, {
    text: '{"ok":true}',
    sessionId: THREAD_ID,
    costUsd: undefined,
    durationMs: 17,
    numTurns: undefined,
    model: 'codex-default',
    costTelemetryStatus: 'unavailable',
  });
  assert.equal(defaultSeatCall.args.includes('-m'), false, 'Radsvinn built-in opus default must not be sent to Codex');

  const fatal = `${EVENTS}\n${JSON.stringify({
    type: 'item.completed',
    item: { id: 'fatal', type: 'error', message: 'runtime execution failed' },
  })}\n`;
  const fatalRuntime = testRuntime(fixtureSpawn({ stdout: fatal }));
  await assert.rejects(() => fatalRuntime.runPhase(BASE_REQ), /runtime execution failed/);

  const missingThread = EVENTS
    .split(/\r?\n/)
    .filter((line) => !line.includes('"type":"thread.started"'))
    .join('\n');
  const missingThreadRuntime = testRuntime(fixtureSpawn({ stdout: missingThread }));
  await assert.rejects(
    () => missingThreadRuntime.runPhase(BASE_REQ),
    /event stream did not include a thread id/,
  );
  await assert.rejects(
    () => runtime.runPhase({ ...BASE_REQ, childEnv: undefined }),
    /requires a sandboxed childEnv/,
  );
});

test('fresh argv uses the read-only sandbox, repo root, existing grounding add-dir, JSONL, and a sanitized child environment', async (t) => {
  const calls = [];
  const runtime = testRuntime(async (call) => {
    calls.push(call);
    return { stdout: EVENTS, wallMs: 1 };
  });

  const explicitModelReq = { ...BASE_REQ, seat: { model: 'gpt-5.6-codex' } };
  const result = await runtime.runPhase(explicitModelReq);
  assert.equal(calls.length, 1);
  const { args, cwd, env, timeoutMs, binaryPath, outputPath } = calls[0];
  assert.deepEqual(args.slice(0, 2), ['exec', BASE_REQ.userMessage]);
  assert.equal(args.includes('--json'), true);
  assert.equal(flagValue(args, '--sandbox'), 'read-only');
  assert.equal(args.includes('--skip-git-repo-check'), true);
  assert.equal(flagValue(args, '--output-last-message'), outputPath);
  assert.equal(flagValue(args, '-C'), BASE_REQ.repoRoot);
  assert.equal(flagValue(args, '--add-dir'), BASE_REQ.groundingRoot);
  assert.equal(flagValue(args, '-m'), 'gpt-5.6-codex');
  assert.equal(args.includes('--ephemeral'), false);
  assert.equal(cwd, BASE_REQ.repoRoot);
  assert.deepEqual(env, { PATH: '/fake-bin', KEEP_ME: 'safe plumbing' });
  assert.equal(BASE_REQ.childEnv.ANTHROPIC_API_KEY, 'anthropic-canary', 'caller input remains immutable');
  assert.equal(BASE_REQ.childEnv.OPENAI_API_KEY, 'openai-canary', 'caller input remains immutable');
  assert.equal(timeoutMs, BASE_REQ.timeoutMs);
  assert.equal(binaryPath, '/fake-bin/codex');
  assert.equal(result.model, 'gpt-5.6-codex');

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-no-grounding-'));
  t.after(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));
  await runtime.runPhase({
    ...explicitModelReq,
    groundingRoot: path.join(emptyRoot, 'missing'),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes('--add-dir'), false, 'missing grounding roots are omitted');
});

test('resume argv uses exec resume and omits fresh-only sandbox and repository flags', async () => {
  const calls = [];
  const runtime = testRuntime(async (call) => {
    calls.push(call);
    return { stdout: EVENTS, wallMs: 1 };
  });

  await runtime.runPhase({ ...BASE_REQ, resume: true, sessionId: 'thread-to-resume' });
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 4), ['exec', 'resume', 'thread-to-resume', BASE_REQ.userMessage]);
  assert.equal(args.includes('--json'), true);
  assert.equal(flagValue(args, '--output-last-message'), calls[0].outputPath);
  for (const flag of ['--sandbox', '--skip-git-repo-check', '--add-dir', '-C', '--ephemeral']) {
    assert.equal(args.includes(flag), false, `${flag} must not be passed to codex exec resume`);
  }
});

test('failed resume falls back to fresh exec and prepends priorArtifactText exactly once', async () => {
  const calls = [];
  const priorArtifactText = '{"plan_id":"prior-plan"}';
  const runtime = testRuntime(async (call) => {
    calls.push(call);
    if (call.args[1] === 'resume') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('session not found');
    }
    return { stdout: EVENTS, wallMs: 2 };
  });

  const result = await runtime.runPhase({
    ...BASE_REQ,
    resume: true,
    sessionId: 'missing-thread',
    priorArtifactText,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 3), ['exec', 'resume', 'missing-thread']);
  assert.deepEqual(calls[1].args.slice(0, 2), [
    'exec',
    `Your prior output was:\n\n${priorArtifactText}\n\nNow proceed with the following:\n\n${BASE_REQ.userMessage}`,
  ]);
  assert.equal(calls[1].args.includes('--sandbox'), true, 'fallback is a fresh, sandboxed exec');
  assert.equal(result.sessionId, THREAD_ID);
  assert.ok(result.durationMs >= 15, 'cold fallback duration includes the failed resume attempt');
});

test('output-last-message is primary and Codex cost telemetry remains explicitly unavailable', async () => {
  const runtime = testRuntime(async ({ outputPath }) => {
    fs.writeFileSync(outputPath, 'primary output');
    return { stdout: EVENTS, wallMs: 3 };
  });

  const result = await runtime.runPhase(BASE_REQ);
  assert.equal(result.text, 'primary output');
  assert.equal(result.costUsd, undefined);
  assert.equal(result.costTelemetryStatus, 'unavailable');
});

test('registry fails closed when Codex is unavailable and relative PATH entries resolve absolutely', async (t) => {
  const { resolveRuntime } = await import('../runtimes/registry.mjs');
  const missingPath = path.join(os.tmpdir(), 'radsvinn-path-with-no-codex');
  assert.throws(
    () => resolveRuntime({ RADSVINN_AGENT_RUNTIME: 'codex', PATH: missingPath }),
    /runtime binary not found on PATH.*codex|codex.*runtime binary not found on PATH/i,
  );

  const executableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-relative-path-'));
  t.after(() => fs.rmSync(executableDir, { recursive: true, force: true }));
  const executablePath = path.join(executableDir, 'codex');
  fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executablePath, 0o755);
  const relativeEntry = path.relative(process.cwd(), executableDir);
  assert.equal(resolveBinaryPath('codex', { PATH: relativeEntry }), executablePath);
});

test('Codex runtime advertises unsupported turn-cap, effort, and cost-reporting capabilities', () => {
  const runtime = testRuntime(fixtureSpawn());
  assert.equal(runtime.id, 'codex');
  assert.equal(runtime.binaryName, 'codex');
  assert.equal(runtime.binaryPath, '/fake-bin/codex');
  assert.deepEqual(runtime.capabilities, {
    supportsTurnCap: false,
    supportsEffort: false,
    supportsCostReporting: false,
  });
});
