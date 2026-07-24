// create-tree-attach.test.mjs — tool-level proof of attach mode.
// attach-epic.test.mjs proves the service wire on the
// fake engine; these tests drive the REAL tools/create-tree.mjs as a child
// process with a scripted fetch (create-tree-fetch-stub.mjs via
// `node --import`), pinning the actual Jira wire the attach fix changed:
//
//   (i)   the GET verify of existing_key happens BEFORE any POST;
//   (ii)  a nonexistent key → exit 1, ZERO POSTs, NO record file;
//   (iii) an exists-but-not-Epic key → same;
//   (iv)  happy attach → no epic POST, every L0 parents under the existing
//         key, the record carries attached_epic OUTSIDE created[];
//   (v)   --cleanup --live over that record transitions ONLY created[] keys,
//         never the attached epic;
//   plus the tool-boundary key-shape guard: a malformed
//   existing_key dies loudly with ZERO requests, live or dry.
//
// Hermetic by construction: tmp dirs, fixture COPIES, and a fetch stub that
// answers every route the tool knows — zero network, no dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'create-tree.mjs');
const STUB = pathToFileURL(path.join(HERE, 'create-tree-fetch-stub.mjs')).href;
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'e2e-sample');

// Stages a tmp run dir with fixture COPIES (plan.json's epic.existing_key
// overridden) and returns the paths the tool + assertions need.
function stageRun(t, existingKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-attach-tool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'plan.json'), 'utf8'));
  plan.epic.existing_key = existingKey;
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.copyFileSync(path.join(FIXTURE_DIR, 'skeleton.json'), path.join(dir, 'skeleton.json'));
  return {
    dir,
    plan,
    planPath: path.join(dir, 'plan.json'),
    recordPath: path.join(dir, 'created-record.json'),
  };
}

// Spawns the TOOL under the fetch stub and returns {status, stdout, stderr,
// log} where log is the parsed request journal (empty array when the run
// died before its first request).
function runTool(args, { logPath, existingIssues = {} }) {
  const res = spawnSync(process.execPath, ['--import', STUB, TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Any real call would 401 anyway, but the stub answers first — the
      // token/cloudId only have to satisfy the tool's presence checks (the
      // stub strips the gateway prefix regardless of the cloudId value).
      MERCURY_JIRA_TOKEN: 'test-token-never-sent-anywhere',
      MERCURY_JIRA_CLOUD_ID: 'test-cloud-id',
      MERCURY_JIRA_PROJECT: 'PROJ',
      MERCURY_TEST_FETCH_LOG: logPath,
      MERCURY_TEST_EXISTING_ISSUES: JSON.stringify(existingIssues),
    },
  });
  assert.equal(res.error, undefined, `spawn failed: ${res.error}`);
  // The stub creates the log file at import time — its existence proves the
  // stub installed BEFORE the tool ran (no silent real-fetch fallthrough).
  assert.ok(fs.existsSync(logPath), 'fetch stub must have installed (log file missing)');
  const log = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, log };
}

const EXISTING_EPIC = { 'PROJ-451': { summary: 'existing epic', issuetype: 'Epic' } };

test('attach happy path (iv + i): GET-verify precedes every POST, no epic create, every L0 parents under the existing key, attached_epic sits outside created[]', (t) => {
  const run = stageRun(t, 'PROJ-451');
  const logPath = path.join(run.dir, 'fetch.jsonl');
  const res = runTool(['--plan', run.planPath, '--scope', 'full', '--live', '--out', run.recordPath], {
    logPath,
    existingIssues: EXISTING_EPIC,
  });
  assert.equal(res.status, 0, `expected exit 0; stderr:\n${res.stderr}`);

  // (i) call order — the attach verify GET is request #0, strictly before
  // any POST (a typo'd key must die with zero side effects).
  const attachGetIdx = res.log.findIndex((r) => r.method === 'GET' && r.url.includes('/issue/PROJ-451?'));
  const firstPostIdx = res.log.findIndex((r) => r.method === 'POST');
  assert.ok(attachGetIdx >= 0, 'the existing key is GET-verified');
  assert.equal(attachGetIdx, 0, 'the verify GET is the FIRST request of the whole run');
  assert.ok(firstPostIdx > attachGetIdx, 'no POST lands before the verify GET');

  // (iv) wire shape: the fixture has 3 L0 items (i1 Task, i2/i3 Story) and
  // no sub-tasks — exactly 3 issue POSTs, none an Epic, all parented under
  // the pre-existing key.
  const issuePosts = res.log.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/issue'));
  assert.equal(issuePosts.length, 3, 'exactly the 3 fixture L0 items are POSTed');
  assert.equal(
    issuePosts.some((r) => r.body.fields.issuetype && r.body.fields.issuetype.name === 'Epic'),
    false,
    'attach mode never POSTs an epic — the duplicate-epic incident',
  );
  for (const r of issuePosts) {
    assert.equal(r.body.fields.parent.key, 'PROJ-451', `L0 "${r.body.fields.summary}" must parent under the existing epic`);
  }

  // (iv) record shape: attached_epic OUTSIDE created[], no Epic inside it.
  const rec = JSON.parse(fs.readFileSync(run.recordPath, 'utf8'));
  assert.deepEqual(rec.attached_epic, { temp_id: 'epic-1', key: 'PROJ-451', summary: 'existing epic' });
  assert.equal(rec.created.length, 3, 'created[] journals exactly the 3 real creates');
  assert.equal(rec.created.some((c) => c.type === 'Epic'), false, 'created[] carries NO Epic entry');
});

test('nonexistent existing_key (ii): exit 1, ZERO POSTs, NO record file', (t) => {
  const run = stageRun(t, 'PROJ-999');
  const logPath = path.join(run.dir, 'fetch.jsonl');
  const res = runTool(['--plan', run.planPath, '--scope', 'full', '--live', '--out', run.recordPath], {
    logPath,
    existingIssues: {}, // PROJ-999 → stub answers 404
  });
  assert.equal(res.status, 1, 'a typo\'d key must never silently become a fresh epic');
  assert.match(res.stderr, /existing_key = "PROJ-999" could not be read/);
  assert.equal(res.log.some((r) => r.method === 'POST'), false, 'zero POSTs — nothing was written to Jira');
  assert.equal(fs.existsSync(run.recordPath), false, 'no record file — the death precedes even the WAL init');
});

test('exists-but-not-Epic existing_key (iii): exit 1, ZERO POSTs, NO record file', (t) => {
  const run = stageRun(t, 'PROJ-500');
  const logPath = path.join(run.dir, 'fetch.jsonl');
  const res = runTool(['--plan', run.planPath, '--scope', 'full', '--live', '--out', run.recordPath], {
    logPath,
    existingIssues: { 'PROJ-500': { summary: 'a task, not an epic', issuetype: 'Task' } },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /issuetype is "Task", not Epic/);
  assert.equal(res.log.some((r) => r.method === 'POST'), false, 'zero POSTs');
  assert.equal(fs.existsSync(run.recordPath), false, 'no record file');
});

test('cleanup over an attach record (v): transitions ONLY created[] keys — the attached epic is never touched', (t) => {
  // First: a real (stubbed) attach create to produce the record.
  const run = stageRun(t, 'PROJ-451');
  const createLog = path.join(run.dir, 'fetch-create.jsonl');
  const created = runTool(['--plan', run.planPath, '--scope', 'full', '--live', '--out', run.recordPath], {
    logPath: createLog,
    existingIssues: EXISTING_EPIC,
  });
  assert.equal(created.status, 0, created.stderr);
  const rec = JSON.parse(fs.readFileSync(run.recordPath, 'utf8'));
  const createdKeys = rec.created.map((c) => c.key);
  assert.equal(createdKeys.length, 3);

  // Then: the sweep, journaled to its OWN log so create traffic can't blur
  // the assertions.
  const cleanupLog = path.join(run.dir, 'fetch-cleanup.jsonl');
  const swept = runTool(['--cleanup', run.recordPath, '--live'], {
    logPath: cleanupLog,
    existingIssues: EXISTING_EPIC,
  });
  assert.equal(swept.status, 0, swept.stderr);

  const transitionKey = (url) => {
    const m = new URL(url).pathname.match(/\/issue\/([^/]+)\/transitions$/);
    return m && m[1];
  };
  const touched = swept.log.map((r) => transitionKey(r.url)).filter(Boolean);
  assert.ok(touched.length > 0, 'the sweep transitions the created issues');
  for (const key of touched) {
    assert.ok(createdKeys.includes(key), `sweep touched ${key}, which is not in created[]`);
  }
  for (const key of createdKeys) {
    assert.ok(
      swept.log.some((r) => r.method === 'GET' && transitionKey(r.url) === key),
      `${key}: transitions read`,
    );
    assert.ok(
      swept.log.some((r) => r.method === 'POST' && transitionKey(r.url) === key),
      `${key}: transition POSTed`,
    );
  }
  assert.equal(
    swept.log.some((r) => r.url.includes('PROJ-451')),
    false,
    'NOT ONE request names the attached epic — Mercury did not create it',
  );
});

test('malformed existing_key at the tool boundary dies loudly with ZERO requests — live and dry-run alike', (t) => {
  for (const live of [true, false]) {
    const run = stageRun(t, 'PROJ-1/../secret?x=');
    const logPath = path.join(run.dir, 'fetch.jsonl');
    const args = ['--plan', run.planPath, '--scope', 'full'];
    if (live) args.push('--live', '--out', run.recordPath);
    const res = runTool(args, { logPath, existingIssues: EXISTING_EPIC });
    assert.equal(res.status, 1, `${live ? 'live' : 'dry'}: a malformed key must die`);
    assert.match(res.stderr, /is not a legal Jira issue key/);
    assert.equal(res.log.length, 0, `${live ? 'live' : 'dry'}: ZERO requests — the guard runs before any network`);
    assert.equal(fs.existsSync(run.recordPath), false, 'no record file');
  }
});
