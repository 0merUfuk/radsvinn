import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderShell } from '../../dashboard/lib/pages.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const noNetwork = 'data:text/javascript,globalThis.fetch=()=>{throw Error("unexpected fixture network")}';

test('standalone writer accepts both prefixes; canonical blanks never recover old env credentials', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-writer-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const record = path.join(home, 'created-record.json');
  fs.writeFileSync(record, '{"created":[]}');
  const run = (settings) => spawnSync(process.execPath, ['--import', noNetwork, 'tools/create-tree.mjs', '--verify', record], {
    cwd: root, env: { HOME: home, PATH: process.env.PATH, ...settings }, encoding: 'utf8', timeout: 5000,
  });
  for (const prefix of ['MERCURY_', 'RADSVINN_']) {
    const result = run({ [prefix + 'JIRA_TOKEN']: 'dummy-fixture', [prefix + 'JIRA_CLOUD_ID']: 'fixture-cloud' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Radsvinn Phase-0/);
    assert.doesNotMatch(result.stdout, /Mercury|dummy-fixture/);
  }
  const legacy = { MERCURY_JIRA_TOKEN: 'dummy-fixture', MERCURY_JIRA_CLOUD_ID: 'fixture-cloud' };
  assert.match(run({ ...legacy, RADSVINN_JIRA_TOKEN: '' }).stderr, /RADSVINN_JIRA_TOKEN is unset/);
  assert.match(run({ ...legacy, RADSVINN_JIRA_CLOUD_ID: '' }).stderr, /RADSVINN_JIRA_CLOUD_ID is unset/);
  // Legacy compatibility fallback remains covered by the boot-time env-only guard.
  const tokenDir = path.join(home, '.config', 'mercury');
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, 'jira-token'), 'local-dummy-fixture', { mode: 0o600 });
  assert.equal(run({ RADSVINN_JIRA_CLOUD_ID: 'fixture-cloud' }).status, 0);
  const boot = spawnSync(process.execPath, ['service/server.mjs'], {
    cwd: root, env: { HOME: home, PATH: process.env.PATH, RADSVINN_ENGINE: 'fake', RADSVINN_REQUIRE_ENV_ONLY_TOKEN: '1' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(boot.status, 1);
  assert.match(boot.stderr, /file-fallback Jira token exists/);
  assert.doesNotMatch(boot.stderr, /local-dummy-fixture/);
});

for (const prefix of ['MERCURY_', 'RADSVINN_']) {
  test(`${prefix} supervisor resolves computed commands and timing overrides without a network listener`, () => {
    const result = spawnSync(process.execPath, ['service/supervise.mjs'], {
      cwd: root, env: { PATH: process.env.PATH, [prefix + 'SUPERVISE_SERVER_CMD']: `${process.execPath} service/test/supervise-fixture-idle.mjs`, [prefix + 'SUPERVISE_HEALTH_URL']: 'fixture:health', [prefix + 'SUPERVISE_HEALTH_TIMEOUT_MS']: '20', [prefix + 'SUPERVISE_HEALTH_POLL_MS']: '5' },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /supervise-fixture-idle/);
    assert.match(result.stderr, /within 20ms/);
    assert.doesNotMatch(result.stderr, /bridge started/);
  });
}

test('dashboard rendered shell uses the canonical identity', () => {
  const html = renderShell();
  assert.match(html, /<title>Radsvinn<\/title>/);
  assert.match(html, /RADSVINN<span/);
  assert.doesNotMatch(html, /mercury/i);
});
