import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { redactSecrets } from '../../dashboard/lib/child-env.mjs';
import { runClaudeSpawn } from '../runtimes/claude.mjs';
import { parseCodexEvents } from '../runtimes/codex.mjs';

const env = {
  MERCURY_SERVICE_TOKEN: 'DUMMY_OLD_CREDENTIAL_0123456789',
  RADSVINN_SERVICE_TOKEN: 'DUMMY_NEW_CREDENTIAL_9876543210',
  ANTHROPIC_AUTH_TOKEN: 'DUMMY_PROXY_CAPABILITY_123456',
};

test('redaction removes both conflicting spellings and source-labelled values', () => {
  const out = redactSecrets(Object.values(env).join(' ') + ' MERCURY_JIRA_TOKEN=unknown-dummy RADSVINN_JIRA_TOKEN=other-dummy', env);
  for (const value of Object.values(env)) assert.ok(!out.includes(value));
  assert.ok(!out.includes('unknown-dummy'));
  assert.ok(!out.includes('other-dummy'));
});

function spawnFixture(stdout, stderr, code) {
  return (_bin, _args, opts) => {
    assert.equal(opts.env.MERCURY_SERVICE_TOKEN, undefined);
    assert.equal(opts.env.RADSVINN_SERVICE_TOKEN, undefined);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    process.nextTick(() => { child.stdout.emit('data', stdout); child.stderr.emit('data', stderr); child.emit('close', code); });
    return child;
  };
}

test('Claude diagnostics redact full text before truncation and include injected capability', async () => {
  for (const value of Object.values(env)) {
    const stderr = value + 'x'.repeat(1980);
    await assert.rejects(runClaudeSpawn({ binaryPath: '/fixture', args: [], repoRoot: '.', childEnv: env, spawnImpl: spawnFixture('', stderr, 1) }), (err) => {
      assert.ok(!err.message.includes(value.slice(-12)));
      return true;
    });
  }
  await assert.rejects(runClaudeSpawn({ binaryPath: '/fixture', args: [], repoRoot: '.', childEnv: env, spawnImpl: spawnFixture(env.MERCURY_SERVICE_TOKEN, '', 0) }), (err) => {
    assert.ok(!err.message.includes('DUMMY_OLD'));
    assert.match(err.message, /non-JSON/);
    return true;
  });
});

test('Codex malformed JSON and error events cannot leak old or new credentials', () => {
  for (const value of Object.values(env)) {
    assert.throws(() => parseCodexEvents(value, env), (err) => !err.message.includes('DUMMY_'));
    assert.throws(() => parseCodexEvents(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: value } }), env), (err) => !err.message.includes('DUMMY_'));
  }
});
