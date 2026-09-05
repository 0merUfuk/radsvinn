import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readEnv } from '../../dashboard/lib/env.mjs';
import { resolveLlmRuntime, openRouterChildEnv } from '../openrouter-meter.mjs';
import { loadConfig, validateConfig } from '../../dashboard/lib/config.mjs';
import { sandboxedEnv, createEngine, buildClaudeArgs as engineArgs } from '../engine.mjs';
import { buildClaudeArgs } from '../runtimes/claude.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('../../fixtures/identity/legacy-env-keys.json', import.meta.url)));

for (const legacy of Object.keys(inventory)) {
  const canonical = legacy.replace('MERCURY_', 'RADSVINN_');
  test(`${canonical}: alias, precedence, absence, empty and dynamic reads`, () => {
    const env = {};
    assert.equal(readEnv(canonical, env), undefined);
    env[legacy] = 'legacy-dummy';
    assert.equal(readEnv(canonical, env), 'legacy-dummy');
    env[canonical] = 'canonical-dummy';
    assert.equal(readEnv(canonical, env), 'canonical-dummy');
    env[canonical] = '';
    assert.equal(readEnv(canonical, env), '');
    delete env[canonical];
    env[legacy] = 'changed-dummy';
    assert.equal(readEnv(canonical, env), 'changed-dummy');
    delete env[legacy];
    env[canonical] = 'new-only-dummy';
    assert.equal(readEnv(canonical, env), 'new-only-dummy');
    assert.deepEqual(env, { [canonical]: 'new-only-dummy' });
  });
}

test('invalid canonical provider and blank canonical credential never use legacy', () => {
  assert.throws(() => resolveLlmRuntime({ RADSVINN_LLM_PROVIDER: 'invalid', MERCURY_LLM_PROVIDER: 'anthropic' }), /must be/);
  assert.throws(() => resolveLlmRuntime({ RADSVINN_LLM_PROVIDER: 'openrouter', RADSVINN_OPENROUTER_API_KEY: '', MERCURY_OPENROUTER_API_KEY: 'dummy' }), /required/);
  assert.deepEqual(resolveLlmRuntime({ MERCURY_LLM_PROVIDER: 'openrouter', MERCURY_OPENROUTER_API_KEY: 'dummy' }),
    resolveLlmRuntime({ RADSVINN_LLM_PROVIDER: 'openrouter', RADSVINN_OPENROUTER_API_KEY: 'dummy' }));
});

test('dashboard boot config resolves legacy and fails closed for blank canonical bearer', () => {
  const old = loadConfig({ MERCURY_PLANNER_URL: 'http://127.0.0.1:8090', MERCURY_SERVICE_TOKEN_DASHBOARD: 'dummy' });
  const fresh = loadConfig({ RADSVINN_PLANNER_URL: 'http://127.0.0.1:8090', RADSVINN_SERVICE_TOKEN_DASHBOARD: 'dummy' });
  assert.deepEqual(old, fresh);
  const conflict = loadConfig({ RADSVINN_SERVICE_TOKEN_DASHBOARD: '', MERCURY_SERVICE_TOKEN_DASHBOARD: 'dummy' });
  assert.ok(validateConfig(conflict).some((s) => s.includes('RADSVINN_SERVICE_TOKEN_DASHBOARD')));
});

test('fake engine keeps live environment reads after construction', async () => {
  const env = { MERCURY_FAKE_GROOM_FAIL: '1' };
  const engine = createEngine('fake', { env });
  await assert.rejects(engine.groom({}), /groom failed/);
  env.RADSVINN_FAKE_GROOM_FAIL = '0';
  env.RADSVINN_FAKE_GROOM_TRUNCATED = '1';
  await assert.rejects(engine.groom({}), /exceeded --max-turns/);
});

test('dynamic seats and explicit empty allowed-tools preserve existing default semantics', () => {
  const names = ['MERCURY_AGENT_MODEL_DECOMPOSE', 'RADSVINN_AGENT_MODEL_DECOMPOSE'];
  const previous = names.map((key) => process.env[key]);
  try {
    delete process.env.RADSVINN_AGENT_MODEL_DECOMPOSE;
    process.env.MERCURY_AGENT_MODEL_DECOMPOSE = 'sonnet';
    const old = engineArgs({ kind: 'phase1', userMessage: 'dummy', sessionId: 'dummy' });
    process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = 'opus';
    const fresh = engineArgs({ kind: 'phase1', userMessage: 'dummy', sessionId: 'dummy' });
    assert.equal(old[old.indexOf('--model') + 1], 'sonnet');
    assert.equal(fresh[fresh.indexOf('--model') + 1], 'opus');
  } finally {
    names.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
  const args = buildClaudeArgs({ userMessage: 'dummy', sessionId: 'dummy' }, { RADSVINN_AGENT_ALLOWED_TOOLS: '', MERCURY_AGENT_ALLOWED_TOOLS: 'Bash' });
  assert.ok(!args.includes('--allowedTools'));
});

test('both credential prefixes are stripped, including conflicting values', () => {
  const source = { PATH: '/dummy', ANTHROPIC_API_KEY: 'provider-dummy' };
  for (const prefix of ['MERCURY_', 'RADSVINN_']) {
    for (const suffix of ['JIRA_TOKEN', 'SERVICE_TOKEN', 'SERVICE_TOKEN_DASHBOARD', 'OPENROUTER_API_KEY']) source[prefix + suffix] = prefix + 'dummy';
  }
  const stripped = sandboxedEnv(source);
  assert.deepEqual(stripped, { PATH: '/dummy', ANTHROPIC_API_KEY: 'provider-dummy' });
  const proxyEnv = openRouterChildEnv(stripped, { baseUrl: 'http://127.0.0.1:1', capability: 'cap-dummy' });
  assert.equal(proxyEnv.ANTHROPIC_AUTH_TOKEN, 'cap-dummy');
  for (const prefix of ['MERCURY_', 'RADSVINN_']) assert.equal(openRouterChildEnv(source, { baseUrl: 'http://127.0.0.1:1', capability: 'cap-dummy' })[prefix + 'OPENROUTER_API_KEY'], undefined);
  assert.equal(source.MERCURY_JIRA_TOKEN, 'MERCURY_dummy');
});
