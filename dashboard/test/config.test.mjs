import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, validateConfig, isTrue } from '../lib/config.mjs';

function fullEnv(overrides = {}) {
  return {
    MERCURY_PLANNER_URL: 'http://mercury.railway.internal:8090',
    MERCURY_SERVICE_TOKEN_DASHBOARD: 'a'.repeat(40),
    DASH_GITHUB_CLIENT_ID: 'client-id',
    DASH_GITHUB_CLIENT_SECRET: 'client-secret',
    DASH_SESSION_SECRET: 'b'.repeat(32),
    DASH_PUBLIC_ORIGIN: 'https://mercury-dash.up.railway.app',
    DASH_GITHUB_ORG: 'example-org',
    ...overrides,
  };
}

describe('lib/config loadConfig', () => {
  test('parses the documented env names with sane defaults', () => {
    const cfg = loadConfig(fullEnv());
    assert.equal(cfg.plannerUrl, 'http://mercury.railway.internal:8090');
    assert.equal(cfg.githubOrg, 'example-org');
    assert.equal(cfg.mutationsEnabled, true);
    assert.equal(cfg.githubApiBase, 'https://api.github.com');
    assert.equal(cfg.githubOauthBase, 'https://github.com');
    assert.deepEqual([...cfg.teamPlanners], ['mercury-planners']);
    assert.deepEqual([...cfg.teamApprovers], ['mercury-approvers']);
    assert.deepEqual([...cfg.teamCreators], ['mercury-creators']);
  });

  test('DASH_MUTATIONS=0 is the only disabling value', () => {
    assert.equal(loadConfig(fullEnv({ DASH_MUTATIONS: '0' })).mutationsEnabled, false);
    assert.equal(loadConfig(fullEnv({ DASH_MUTATIONS: '1' })).mutationsEnabled, true);
    assert.equal(loadConfig(fullEnv({})).mutationsEnabled, true, 'unset defaults to enabled');
    assert.equal(loadConfig(fullEnv({ DASH_MUTATIONS: 'false' })).mutationsEnabled, true, 'only the literal "0" disables');
  });

  test('DASH_ROLE_BOOTSTRAP parses numeric ids and drops junk', () => {
    const cfg = loadConfig(fullEnv({ DASH_ROLE_BOOTSTRAP: '123, 456,,abc, 789' }));
    assert.deepEqual([...cfg.roleBootstrapIds].sort(), [123, 456, 789]);
  });

  test('trims whitespace-only tokens/secrets to empty (treated as not configured)', () => {
    const cfg = loadConfig(fullEnv({ MERCURY_SERVICE_TOKEN_DASHBOARD: '   ' }));
    assert.equal(cfg.plannerToken, '');
  });

  test('DASH_GITHUB_API_BASE / DASH_GITHUB_OAUTH_BASE are the test seam', () => {
    const cfg = loadConfig(fullEnv({
      DASH_GITHUB_API_BASE: 'http://127.0.0.1:9999',
      DASH_GITHUB_OAUTH_BASE: 'http://127.0.0.1:9998',
    }));
    assert.equal(cfg.githubApiBase, 'http://127.0.0.1:9999');
    assert.equal(cfg.githubOauthBase, 'http://127.0.0.1:9998');
  });
});

describe('lib/config validateConfig', () => {
  test('a fully-populated env has zero problems', () => {
    assert.deepEqual(validateConfig(loadConfig(fullEnv())), []);
  });

  test('flags a missing planner url/token', () => {
    const cfg = loadConfig(fullEnv({ MERCURY_PLANNER_URL: '', MERCURY_SERVICE_TOKEN_DASHBOARD: '' }));
    const problems = validateConfig(cfg);
    assert.ok(problems.some((p) => p.includes('MERCURY_PLANNER_URL')));
    assert.ok(problems.some((p) => p.includes('MERCURY_SERVICE_TOKEN_DASHBOARD')));
  });

  test('flags a session secret shorter than 32 chars', () => {
    const cfg = loadConfig(fullEnv({ DASH_SESSION_SECRET: 'short' }));
    assert.ok(validateConfig(cfg).some((p) => p.includes('DASH_SESSION_SECRET')));
  });

  test('flags a non-https public origin in production', () => {
    const cfg = loadConfig(fullEnv({ DASH_PUBLIC_ORIGIN: 'http://insecure.example', NODE_ENV: 'production' }));
    assert.ok(validateConfig(cfg).some((p) => p.includes('https')));
  });

  test('allows http public origin outside production (local dev)', () => {
    const cfg = loadConfig(fullEnv({ DASH_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'test' }));
    assert.deepEqual(validateConfig(cfg), []);
  });

  test('flags a role bootstrap value with no valid numeric ids', () => {
    const cfg = loadConfig(fullEnv({ DASH_ROLE_BOOTSTRAP: 'not-a-number' }));
    assert.ok(validateConfig(cfg).some((p) => p.includes('DASH_ROLE_BOOTSTRAP')));
  });
});

describe('lib/config isTrue', () => {
  test('recognizes common truthy spellings', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) assert.equal(isTrue(v), true, v);
    for (const v of ['0', 'false', '', undefined, 'nope']) assert.equal(isTrue(v), false, String(v));
  });
});
