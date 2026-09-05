import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runClaudeSpawn } from './lib.mjs';

test('harness actual child denies both credential prefixes and retains provider plumbing', async () => {
  const env = { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'provider-dummy', KEEP_FIXTURE: 'yes' };
  for (const prefix of ['MERCURY_', 'RADSVINN_']) {
    for (const suffix of ['JIRA_TOKEN', 'SERVICE_TOKEN', 'SERVICE_TOKEN_DASHBOARD', 'OPENROUTER_API_KEY']) env[prefix + suffix] = prefix + 'dummy';
  }
  env.DASH_SESSION_SECRET = 'session-dummy';
  const { stdout } = await runClaudeSpawn([], {
    cwd: process.cwd(), timeoutMs: 5000, env,
    spawnImpl: (_bin, _args, opts) => spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'], opts),
  });
  assert.deepEqual(JSON.parse(stdout).filter((key) => key !== '__CF_USER_TEXT_ENCODING'), ['ANTHROPIC_API_KEY', 'KEEP_FIXTURE', 'PATH']);
  assert.equal(env.MERCURY_JIRA_TOKEN, 'MERCURY_dummy');
  assert.equal(env.RADSVINN_JIRA_TOKEN, 'RADSVINN_dummy');
});

test('harness failure evidence redacts both conflicting configured values', async () => {
  const env = { MERCURY_JIRA_TOKEN: 'old-dummy-fixture', RADSVINN_JIRA_TOKEN: 'new-dummy-fixture' };
  await assert.rejects(runClaudeSpawn([], {
    cwd: process.cwd(), timeoutMs: 5000, env,
    spawnImpl: (_bin, _args, opts) => spawn(process.execPath, ['-e', 'process.stderr.write("old-dummy-fixture new-dummy-fixture"); process.exitCode=1'], opts),
  }), (err) => {
    assert.equal(err.stderr, '[REDACTED] [REDACTED]');
    return true;
  });
});
