import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const brands = ['radsvinn', 'mercury']; // Canonical path and compatibility fallback fixture.
const values = ['canonical-dummy-token', 'legacy-dummy-token', 'env-dummy-token'];

function fixture(t, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-token-paths-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [i, content] of files.entries()) {
    if (content === undefined) continue;
    const file = path.join(home, '.config', brands[i], 'jira-token');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === 'directory') fs.mkdirSync(file);
    else if (content === 'dangling') fs.symlinkSync(path.join(home, 'missing'), file);
    else fs.writeFileSync(file, content, { mode: 0o600 });
  }
  return home;
}

function run(home, args, settings = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { HOME: home, PATH: process.env.PATH, ...settings },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  for (const value of values) {
    assert.ok(!(result.stdout + result.stderr).includes(value), 'diagnostics must not expose fixture tokens');
  }
  return result;
}

const cases = [
  ['canonical only', [values[0]], {}, values[0]],
  ['legacy only', [undefined, values[1]], {}, values[1]],
  ['conflicting files', values.slice(0, 2), {}, values[0]],
  ['empty canonical blocks legacy', ['', values[1]], {}, null],
  ['whitespace canonical blocks legacy', [' \n', values[1]], {}, null],
  ['unreadable canonical blocks legacy', ['directory', values[1]], {}, null],
  ['dangling canonical blocks legacy', ['dangling', values[1]], {}, null],
  ['environment wins over files', values.slice(0, 2), { RADSVINN_JIRA_TOKEN: values[2] }, values[2]],
  ['environment wins over unreadable canonical', ['directory', values[1]], { RADSVINN_JIRA_TOKEN: values[2] }, values[2]],
  ['legacy environment wins over files', values.slice(0, 2), { MERCURY_JIRA_TOKEN: values[2] }, values[2]],
  ['blank canonical env masks legacy env then reads canonical file', values.slice(0, 2), { RADSVINN_JIRA_TOKEN: '', MERCURY_JIRA_TOKEN: values[2] }, values[0]],
];

for (const [name, files, settings, expected] of cases) {
  test(`Jira token: ${name}`, (t) => {
    const home = fixture(t, files);
    // A GET-only stub validates the selected credential without printing it or using a network.
    const stub = `globalThis.fetch = async (url, options) => {
      if (options.method !== 'GET' || options.headers.Authorization !== 'Bearer ' + process.env.FIXTURE_EXPECTED)
        throw Error('unexpected fixture credential or method');
      console.log('fixture fetch accepted');
      return { ok: true, status: 200, text: async () => '{"issues":[]}' };
    };`;
    const result = run(home, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, 'tools/create-tree.mjs', '--search', 'fixture'], {
      RADSVINN_JIRA_CLOUD_ID: 'fixture-cloud', FIXTURE_EXPECTED: expected ?? '', ...settings,
    });
    assert.equal(result.status, expected === null ? 1 : 0, result.stderr);
    if (expected === null) {
      assert.match(result.stderr, /RADSVINN_JIRA_TOKEN is unset/);
      assert.doesNotMatch(result.stdout, /fixture fetch accepted/);
      if (files[0] === 'directory' || files[0] === 'dangling') assert.match(result.stderr, /WARN: could not read .*radsvinn.*jira-token/);
    } else assert.match(result.stdout, /fixture fetch accepted/);
  });
}

for (const [i, brand] of brands.entries()) {
  test(`Jira token: ${brand} mode warning remains content-free`, (t) => {
    const files = [];
    files[i] = values[i];
    const home = fixture(t, files);
    fs.chmodSync(path.join(home, '.config', brand, 'jira-token'), 0o644);
    const result = run(home, ['tools/create-tree.mjs', '--help']);
    assert.equal(result.status, 0);
    assert.ok(result.stderr.includes(`chmod 600 ${path.join(home, '.config', brand, 'jira-token')}`));
  });
}

for (const files of [[values[0]], [undefined, values[1]], values.slice(0, 2), [''], ['directory'], ['dangling']]) {
  for (const envToken of [undefined, values[2]]) {
    test(`env-only boot refuses ${JSON.stringify(files.map((v) => v === undefined ? 'absent' : v === '' ? 'empty' : values.includes(v) ? 'file' : v))}, env populated=${!!envToken}`, (t) => {
      const home = fixture(t, files);
      const noListen = 'data:text/javascript,import net from "node:net"; net.Server.prototype.listen = () => { throw Error("unexpected fixture listener"); };';
      const result = run(home, ['--import', noListen, 'service/server.mjs'], {
        RADSVINN_ENGINE: 'fake', RADSVINN_REQUIRE_ENV_ONLY_TOKEN: '1',
        RADSVINN_SERVICE_TOKEN: 'dummy-service-bearer',
        RADSVINN_RESULTS_DIR: path.join(home, 'results'),
        ...(envToken ? { RADSVINN_JIRA_TOKEN: envToken } : {}),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FATAL.*file-fallback Jira token exists.*env-only/);
      assert.ok(result.stderr.includes(path.join(home, '.config', files[0] === undefined ? brands[1] : brands[0], 'jira-token')));
      assert.doesNotMatch(result.stdout, /planner service listening/);
    });
  }
}
