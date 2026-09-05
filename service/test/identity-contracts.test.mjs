import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { State, resultsDir, agentRunDir } from '../state.mjs';
import { auditDir } from '../audit.mjs';
import { checkPlanBudget } from '../breakers.mjs';
import { resolveRuntime } from '../runtimes/registry.mjs';
import { loadConfig } from '../../dashboard/lib/config.mjs';
import { computeRoles } from '../../dashboard/lib/rbac.mjs';
import { readEnv } from '../../dashboard/lib/env.mjs';
import { signValue, verifySignedValue } from '../../dashboard/lib/hmac.mjs';
import { SESSION_COOKIE_NAME } from '../../dashboard/lib/sessions.mjs';
import { OAUTH_STATE_COOKIE_NAME } from '../../dashboard/lib/oauth.mjs';
import { verifyCsrfHeader } from '../../dashboard/lib/csrf.mjs';
import { scanText } from '../../dashboard/lib/secret-scan.mjs';

const root = path.resolve(import.meta.dirname, '../..');
function source(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

test('historical cookies, signatures, CSRF and schema identifiers remain cross-version contracts', () => {
  assert.equal(SESSION_COOKIE_NAME, '__Host-mercury_dash');
  assert.equal(OAUTH_STATE_COOKIE_NAME, '__Host-mercury_oauth');
  assert.ok(source('dashboard/server.mjs').includes("'__Host-mercury_return_to'"));
  const secret = 'fixture-signing-key';
  const value = 'fixture-session-id';
  const legacySigned = value + '.' + crypto.createHmac('sha256', secret).update(value).digest('hex');
  assert.equal(verifySignedValue(legacySigned, secret), value);
  assert.equal(signValue(value, secret), legacySigned); // new signature accepted by historical verifier
  assert.equal(verifySignedValue(legacySigned + 'bad', secret), null);
  assert.equal(verifyCsrfHeader({ headers: { 'x-mercury-csrf': 'fixture-csrf' } }, { csrf_token: 'fixture-csrf' }), true);
  assert.equal(verifyCsrfHeader({ headers: { 'x-mercury-csrf': 'bad' } }, { csrf_token: 'fixture-csrf' }), false);
  assert.ok(source('dashboard/public/app.js').includes("'X-Mercury-CSRF': CSRF")); // new browser emits old server's contract
  for (const name of ['plan', 'skeleton']) {
    assert.equal(JSON.parse(source(`contracts/${name}.schema.json`)).$id, `https://github.com/0merUfuk/mercury/contracts/${name}.schema.json`);
  }
});

test('authorization team defaults remain exact; explicit team cutover does not grant both', () => {
  const config = loadConfig({});
  const teamSlugs = ['mercury-planners', 'mercury-approvers', 'mercury-creators'];
  assert.deepEqual(computeRoles({ teamSlugs, githubId: 1, config }), ['viewer', 'planner', 'approver', 'creator']);
  const migrated = loadConfig({ DASH_TEAM_PLANNERS: 'radsvinn-planners', DASH_TEAM_APPROVERS: 'radsvinn-approvers', DASH_TEAM_CREATORS: 'radsvinn-creators' });
  assert.deepEqual(computeRoles({ teamSlugs, githubId: 1, config: migrated }), ['viewer']);
  assert.deepEqual(computeRoles({ teamSlugs: ['radsvinn-creators'], githubId: 1, config: migrated }), ['viewer', 'creator']);
});

test('legacy persisted records reload through either results-root alias; State pins its root', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-persist-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = { ...process.env };
  t.after(() => { for (const key of ['MERCURY_RESULTS_DIR', 'RADSVINN_RESULTS_DIR']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  process.env.MERCURY_RESULTS_DIR = dir;
  delete process.env.RADSVINN_RESULTS_DIR;
  const id = 'fixture-existing-plan';
  const record = { plan_id: id, status: 'created', created: { keys: ['PROJ-1'] }, surface: { kind: 'slack', channel: 'fixture' }, announced_status: 'created' };
  fs.mkdirSync(path.join(dir, 'service/plans'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'service/plans', id + '.json'), JSON.stringify(record));
  const old = new State(); old.load(); assert.deepEqual(old.get(id), record);
  process.env.RADSVINN_RESULTS_DIR = dir;
  process.env.MERCURY_RESULTS_DIR = path.join(dir, 'must-not-use');
  const fresh = new State(); fresh.load(); assert.deepEqual(fresh.get(id), record);
  process.env.RADSVINN_RESULTS_DIR = path.join(dir, 'later-config');
  assert.equal(fresh.root, dir);
  assert.equal(resultsDir(), path.join(dir, 'later-config'));
  assert.equal(agentRunDir(id, dir), path.join(dir, 'agent', 'svc-' + id));
  assert.equal(auditDir(dir), path.join(dir, 'service', 'audit'));
});

test('runtime and budget consumers keep fail-closed selection and numeric defaults', () => {
  assert.throws(() => resolveRuntime({ RADSVINN_AGENT_RUNTIME: 'invalid', MERCURY_AGENT_RUNTIME: 'claude' }), /Unknown RADSVINN_AGENT_RUNTIME/);
  assert.throws(() => resolveRuntime({ MERCURY_AGENT_RUNTIME: 'codex', PATH: '' }), /not found/);
  const plan = { cost_usd: 2 };
  assert.deepEqual(checkPlanBudget(plan, { MERCURY_PLAN_BUDGET_USD: '1' }), checkPlanBudget(plan, { RADSVINN_PLAN_BUDGET_USD: '1' }));
  assert.deepEqual(checkPlanBudget(plan, { RADSVINN_PLAN_BUDGET_USD: '', MERCURY_PLAN_BUDGET_USD: '1' }), checkPlanBudget(plan, {}));
  assert.deepEqual(checkPlanBudget(plan, { RADSVINN_PLAN_BUDGET_USD: 'invalid', MERCURY_PLAN_BUDGET_USD: '1' }), checkPlanBudget(plan, {}));
});

test('image defaults preserve both legacy operator overrides and canonical precedence', () => {
  const defaults = Object.fromEntries([...source('Dockerfile').matchAll(/\b(MERCURY_[A-Z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
  assert.equal(Object.keys(defaults).length, 4);
  for (const [legacy, fallback] of Object.entries(defaults)) {
    const canonical = legacy.replace('MERCURY_', 'RADSVINN_');
    assert.equal(readEnv(canonical, defaults), fallback);
    assert.equal(readEnv(canonical, { ...defaults, [legacy]: 'override' }), 'override');
    assert.equal(readEnv(canonical, { ...defaults, [legacy]: 'override', [canonical]: '' }), '');
  }
});

test('both secret-name prefixes are forbidden in shipped browser code', () => {
  for (const name of ['MERCURY_SERVICE_TOKEN', 'RADSVINN_SERVICE_TOKEN']) assert.ok(scanText(`const secret = '${name}'`).length > 0);
});

for (const prefix of ['MERCURY_', 'RADSVINN_']) {
  test(`${prefix} required-auth boot rejects empty bearer without opening a socket`, () => {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), [prefix + 'ENGINE']: 'fake', [prefix + 'REQUIRE_AUTH']: '1', [prefix + 'SERVICE_TOKEN']: '' };
    const result = spawnSync(process.execPath, ['service/server.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FATAL: RADSVINN_REQUIRE_AUTH=1/);
    assert.doesNotMatch(result.stdout, /listening/);
  });
}

test('canonical empty bearer cannot recover conflicting legacy auth at boot', () => {
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), RADSVINN_ENGINE: 'fake', RADSVINN_REQUIRE_AUTH: '1', RADSVINN_SERVICE_TOKEN: '', MERCURY_SERVICE_TOKEN: 'legacy-dummy' };
  const result = spawnSync(process.execPath, ['service/server.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or empty/);
  assert.doesNotMatch(result.stderr, /legacy-dummy/);
});
