// retry-guard.test.mjs — retry write guard: POST /plan/{id}/retry must NEVER re-run the
// control-plane create over a tree that already wrote real issues to Jira.
//
// Why a separate file (not http-e2e.test.mjs): `node --test` runs each test
// FILE in its own child process, so the retry write guard-specific knobs this file flips
// (RADSVINN_FAKE_VERIFY_FAIL, RADSVINN_FAKE_CREATE_PARTIAL,
// RADSVINN_FAKE_VERIFY_REJECT) are process-isolated from http-e2e.test.mjs
// running concurrently — no cross-file env leakage is possible. All filesystem state lives under per-test mkdtemp
// roots (startTestServer / local mkdtemp), so concurrent files never share
// disk state either. Within this file, top-level tests run sequentially and
// every env mutation is restored by ctx.close() / t.after (house pattern).
//
// The core safety property under test, in one line: the ONLY thing that may
// route a failed plan back into runCreateWorker is proof of ZERO prior Jira
// writes (no record, or a record that parses clean with created:[]).
// Everything else — full record, partial record, corrupt record, partial
// marker — must end in verify-only recovery and must leave the on-disk
// record byte-untouched (it is the first tree's only cleanup handle).
//
// Sentinel technique: before retrying, we read-modify-write an extra
// `"sentinel":"x"` field into the on-disk record. ANY re-run of create
// (fake or real) rewrites that file from scratch, so the sentinel surviving
// the retry is on-disk proof that no second create ever ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil, sleep } from './helpers.mjs';
import { createEngine, CREATED_RECORD_FILENAME } from '../engine.mjs';

// Drives a fresh plan through plan -> approve-shape -> create and waits for
// the create worker to settle (status leaves `creating`). Which terminal
// state it lands in depends on the RADSVINN_FAKE_* knobs the caller set.
async function driveThroughCreate(ctx) {
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  const approved = await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  assert.equal(approved.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  const creating = await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  assert.equal(creating.status, 202);
  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  return { planId, settled };
}

function runRecordPath(ctx, planId) {
  return path.join(ctx.resultsDir, 'agent', `svc-${planId}`, CREATED_RECORD_FILENAME);
}

function injectSentinel(recordPath) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.sentinel = 'x';
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
}

function readSentinel(recordPath) {
  return JSON.parse(fs.readFileSync(recordPath, 'utf8')).sentinel;
}

function writeSpawnTrap(dir, binaryName, markerPath) {
  const binaryPath = path.join(dir, binaryName);
  fs.writeFileSync(binaryPath, [
    '#!/bin/sh',
    `printf '%s\\n' ${JSON.stringify(`${binaryName} spawned`)} >> ${JSON.stringify(markerPath)}`,
    'exit 97',
    '',
  ].join('\n'));
  fs.chmodSync(binaryPath, 0o755);
}

// POSTs the retry, asserts the 202 {status:'creating'} contract, and polls
// until the recovery worker settles the plan out of `creating`.
async function retryAndSettle(ctx, planId) {
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202, 'retry from failed is accepted');
  assert.equal(retry.body.status, 'creating', 'the guard reuses the creating transient status');
  return pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
}

// -- matrix item 1 -----------------------------------------------------------

test('retry write guard case A heal: full record + verify hiccup — retry re-verifies to created, never re-creates', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_VERIFY_FAIL: '1' });
  t.after(() => ctx.close());

  // create COMPLETES (full record on disk) but the post-create --verify reads
  // red → runCreateWorker lands `failed` WITH the created marker set.
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  assert.ok(failed.body.created, 'create completed — the created marker must be present');
  assert.equal(failed.body.created.verify_ok, false);
  assert.deepEqual(failed.body.created.keys, ['PROJ-999']);
  assert.match(failed.body.error, /verify failed/);
  const recordPath = failed.body.created.record_path;
  assert.equal(recordPath, runRecordPath(ctx, planId), 'record lives at <runDir>/created-record.json');
  assert.ok(fs.existsSync(recordPath), 'the full record is on disk');

  injectSentinel(recordPath);

  // "The network heals" — the re-read now comes back green. ctx.close()
  // restores the env var (house pattern from the groom-fail pilot test).
  process.env.RADSVINN_FAKE_VERIFY_FAIL = '0';
  const healed = await retryAndSettle(ctx, planId);
  assert.equal(healed.body.status, 'created', 'a green re-read heals the plan to created');
  assert.equal(healed.body.created.verify_ok, true);
  assert.deepEqual(healed.body.created.keys, ['PROJ-999'], 'keys from the ORIGINAL create are preserved');
  assert.equal(healed.body.created.partial, undefined, 'case A never marks partial');
  assert.equal(healed.body.error, undefined, 'the verify-failure error is cleared on heal');
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');
});

// -- matrix item 2 -----------------------------------------------------------

test('retry write guard case A verify-still-red: retry lands failed with --cleanup guidance; marker and record preserved', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_VERIFY_FAIL: '1' });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  const recordPath = failed.body.created.record_path;
  injectSentinel(recordPath);

  // Knob stays SET across the retry — the re-verify reads red again.
  const still = await retryAndSettle(ctx, planId);
  assert.equal(still.body.status, 'failed', 'a red re-read keeps the plan failed');
  assert.match(still.body.error, /verify failed again/, 'this is case A wording — a full record must not be treated as a partial tree');
  assert.match(still.body.error, /node tools\/create-tree\.mjs --cleanup/, 'error carries the exact --cleanup command');
  assert.ok(still.body.error.includes(recordPath), 'error names the record path');
  assert.ok(still.body.created, 'created marker preserved through the failed re-verify');
  assert.deepEqual(still.body.created.keys, ['PROJ-999']);
  assert.equal(still.body.created.verify_ok, false);
  assert.equal(still.body.created.partial, undefined, 'a full record must never be degraded to partial:true');
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');
});

// -- matrix item 3 -----------------------------------------------------------

test('retry write guard case B partial block: partial record blocks retry, marks partial:true, and blocks a second retry too', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_PARTIAL: '1' });
  t.after(() => ctx.close());

  // create-tree dies MID-TREE: engine.create writes the partial record then
  // throws → the plan is failed with NO created marker, record on disk.
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.created, undefined, 'engine.create threw — no created marker lands yet');
  const recordPath = runRecordPath(ctx, planId);
  assert.ok(fs.existsSync(recordPath), 'create-tree persisted the partial record before dying');
  assert.equal(JSON.parse(fs.readFileSync(recordPath, 'utf8')).created.length, 1, 'one issue is already on the board');

  injectSentinel(recordPath);

  // Unset ALL knobs: from here on, a blind re-entry into the create phase
  // WOULD succeed — so anything that blocks it is the guard itself, and the
  // "already wrote" error text below pins it to handleRetry's guard (the
  // engine-level guard says "refusing to re-create" instead).
  process.env.RADSVINN_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores

  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.status, 'failed', 'a partial tree is NEVER promoted to created');
  assert.match(blocked.body.error, /already wrote 1 issue\(s\) to Jira/, 'error states exactly what is at risk');
  assert.match(blocked.body.error, /node tools\/create-tree\.mjs --cleanup/, 'error carries the cleanup command');
  assert.ok(blocked.body.error.includes(recordPath), 'cleanup command targets the real record path');
  // slack-blocks.mjs terminalMessage truncates `error` at 500 chars — the
  // cleanup command (the user's ONLY undo handle) and its record path must
  // land inside that window, not after the verify tail.
  assert.ok(
    blocked.body.error.slice(0, 500).includes(`node tools/create-tree.mjs --cleanup ${recordPath} --live`),
    'the full cleanup command survives the 500-char Slack truncation',
  );
  // The escape hatch from the circular dead-end (human cleaned up → verify
  // reads the cancelled fragments green → same cleanup instruction again)
  // must ALSO land inside the Slack window, right after the command.
  assert.ok(
    blocked.body.error.slice(0, 500).includes('If you have already cleaned up, abandon this plan and start a new one.'),
    'the post-cleanup abandon sentence survives the 500-char Slack truncation',
  );
  assert.match(blocked.body.error, /readable/, 'a green verify over a partial record must read as readable≠complete, not success');
  assert.equal(blocked.body.created.partial, true, 'partial marker is planted as durable state');
  assert.equal(blocked.body.agent_summary, undefined, 'stale create-era agent_summary is cleared on a blocked plan');
  assert.deepEqual(blocked.body.created.keys, ['PROJ-999'], 'the recorded key is surfaced for cleanup');
  assert.equal(blocked.body.created.verify_ok, false);
  assert.equal(blocked.body.created.record_path, recordPath);
  assert.equal(readSentinel(recordPath), 'x', 'record NOT overwritten — the cleanup handle survives');

  // Second retry: plan.created now EXISTS with record_path — the promote-
  // capable case A branch must still be refused (partial:true routes case B).
  const blockedAgain = await retryAndSettle(ctx, planId);
  assert.equal(blockedAgain.body.status, 'failed', 'still failed on the second retry');
  assert.match(blockedAgain.body.error, /already wrote 1 issue\(s\) to Jira/);
  assert.equal(blockedAgain.body.created.partial, true, 'partial marker never degrades');
  assert.equal(readSentinel(recordPath), 'x', 'record STILL untouched after a second retry');
});

// -- matrix item 3, verify-fail variant ---------------------------------------

test('retry write guard case B partial block, verify-fail variant: red recovery read still blocks, cleanup command still inside the Slack window', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_FAKE_CREATE_PARTIAL: '1',
    // Not set yet — listed so ctx.close() restores whatever we set mid-test.
    RADSVINN_FAKE_VERIFY_FAIL: undefined,
  });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  const recordPath = runRecordPath(ctx, planId);
  injectSentinel(recordPath);

  // This time the recovery verify ITSELF reads red (network blip on the
  // read-back). The block must hold identically, and the error segments must
  // keep the Slack-safe order: reason → cleanup command → verify tail.
  process.env.RADSVINN_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores
  process.env.RADSVINN_FAKE_VERIFY_FAIL = '1'; // ctx.close() restores

  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.status, 'failed', 'a red verify never changes the answer — still blocked');
  assert.equal(blocked.body.created.partial, true, 'partial marker planted even when the verify read is red');
  assert.match(blocked.body.error, /already wrote 1 issue\(s\) to Jira/);
  assert.match(blocked.body.error, /Verify failed:/, 'the red verify is surfaced (tail, after the cleanup command)');
  assert.ok(
    blocked.body.error.slice(0, 500).includes(`node tools/create-tree.mjs --cleanup ${recordPath} --live`),
    'the full cleanup command survives the 500-char Slack truncation even with a verify-failure tail present',
  );
  assert.ok(
    blocked.body.error.slice(0, 500).includes('If you have already cleaned up, abandon this plan and start a new one.'),
    'the abandon sentence stays inside the Slack window even with a verify-failure tail present',
  );
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');
});

// -- matrix item 4 -----------------------------------------------------------

test('retry write guard case B corrupt record: retry fails closed with inspect-manually error; no marker fabricated; file untouched', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_FAIL: '1' });
  t.after(() => ctx.close());

  // CREATE_FAIL models dying BEFORE any write — failed, no marker, no record.
  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.created, undefined);
  const recordPath = runRecordPath(ctx, planId);
  assert.ok(!fs.existsSync(recordPath), 'fail-before-any-write leaves no record');

  // A crashed create-tree could leave a torn, unparseable record — a file
  // like this hides an UNKNOWN number of Jira writes, so it must fail closed.
  const garbage = '{"created": [{"key": "PROJ-'; // torn mid-write: not JSON
  fs.writeFileSync(recordPath, garbage);

  process.env.RADSVINN_FAKE_CREATE_FAIL = '0'; // ctx.close() restores

  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.status, 'failed', 'an unparseable record fails closed');
  assert.match(blocked.body.error, /could not be parsed \(or has no created\[\] list\)/, 'the wording covers BOTH garbage and shapeless-JSON records');
  assert.match(blocked.body.error, /inspect it manually/);
  assert.equal(blocked.body.created, undefined, 'no created marker is fabricated from a record we cannot trust');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), garbage, 'the corrupt record is preserved byte-for-byte for the human');
});

// -- matrix item 4, null-literal variant --------------------------------------

test('retry write guard case B null-literal record: a file containing JSON `null` still routes to the guard — fails closed, file untouched', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_FAIL: '1' });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.created, undefined);
  const recordPath = runRecordPath(ctx, planId);
  assert.ok(!fs.existsSync(recordPath), 'fail-before-any-write leaves no record');

  // JSON.parse('null') === null — the exact value the guard's routing uses
  // for "no file". A record file that EXISTS with this content must still
  // route to case B (the primary guard) on the explicit exists fact, never
  // fall through the ladder into a promote-capable create pass.
  fs.writeFileSync(recordPath, 'null');

  process.env.RADSVINN_FAKE_CREATE_FAIL = '0'; // ctx.close() restores

  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.status, 'failed', 'a literal-null record fails closed — never the create ladder');
  assert.match(blocked.body.error, /could not be parsed \(or has no created\[\] list\)/, 'the primary guard wording, not the engine guard\'s "refusing to re-create"');
  assert.match(blocked.body.error, /inspect it manually/);
  assert.equal(blocked.body.created, undefined, 'no created marker is fabricated from a null record');
  assert.equal(fs.readFileSync(recordPath, 'utf8'), 'null', 'the file is preserved byte-for-byte');
});

// -- matrix item 5 -----------------------------------------------------------

test('retry write guard clean-empty fall-through: a record proving zero Jira writes does NOT block retry — create re-runs to created', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_FAIL: '1' });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  const recordPath = runRecordPath(ctx, planId);

  // create-tree's catch persists the record even when it dies BEFORE its
  // first Jira POST — created:[] is on-disk PROOF of zero writes, and the
  // guard must let that retry through (blocking it would strand every
  // genuinely-incomplete create forever).
  fs.writeFileSync(recordPath, JSON.stringify({ created: [], links: [] }));

  process.env.RADSVINN_FAKE_CREATE_FAIL = '0'; // ctx.close() restores

  const done = await retryAndSettle(ctx, planId);
  assert.equal(done.body.status, 'created', 'a zero-write record falls through to a real retry that succeeds');
  assert.deepEqual(done.body.created.keys, ['PROJ-999']);
  assert.equal(done.body.created.verify_ok, true);
  const after = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(after.created.length, 1, 'engine.create legitimately overwrote the clean-empty record');
});

// -- matrix item 6 -----------------------------------------------------------

test('retry write guard engine guard: create() refuses over an existing record with writes (both engines); allows clean-empty overwrite', async (t) => {
  // Direct unit test of the defense-in-depth layer — no server involved.
  // Explicitly clear the knobs (and restore after) so this test is immune to
  // ordering: the clean-empty leg below runs a REAL fake create.
  const knobs = [
    'RADSVINN_FAKE_CREATE_FAIL',
    'RADSVINN_FAKE_CREATE_PARTIAL',
    'RADSVINN_FAKE_VERIFY_FAIL',
    'RADSVINN_AGENT_RUNTIME',
    'RADSVINN_LLM_PROVIDER',
    'PATH',
  ];
  const prev = {};
  for (const k of knobs) { prev[k] = process.env[k]; delete process.env[k]; }
  t.after(() => {
    for (const k of knobs) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-engine-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fixtureBin = path.join(tmp, 'runtime-bin');
  const spawnMarker = path.join(tmp, 'unexpected-spawn.txt');
  fs.mkdirSync(fixtureBin, { recursive: true });
  for (const binaryName of ['claude', 'codex', 'node']) writeSpawnTrap(fixtureBin, binaryName, spawnMarker);
  process.env.PATH = fixtureBin;
  process.env.RADSVINN_LLM_PROVIDER = 'anthropic';

  const engine = createEngine('fake');

  // (1) non-empty record → refuse, and leave the record byte-identical.
  const nonEmptyDir = path.join(tmp, 'non-empty');
  fs.mkdirSync(nonEmptyDir, { recursive: true });
  const nonEmptyPath = path.join(nonEmptyDir, CREATED_RECORD_FILENAME);
  const nonEmptyBody = JSON.stringify({ created: [{ temp_id: 'e1', key: 'PROJ-123', type: 'Epic', summary: 'first tree' }], links: [] });
  fs.writeFileSync(nonEmptyPath, nonEmptyBody);
  await assert.rejects(() => engine.create({ runDir: nonEmptyDir }), /1 issue\(s\) already recorded.+refusing to re-create/);
  assert.equal(fs.readFileSync(nonEmptyPath, 'utf8'), nonEmptyBody, 'a refused create must not touch the record');

  // (2) unparseable record → refuse (corruption hides an unknown number of writes).
  const corruptDir = path.join(tmp, 'corrupt');
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, CREATED_RECORD_FILENAME), '{"created": [{');
  await assert.rejects(() => engine.create({ runDir: corruptDir }), /unparseable.+refusing to re-create/);

  // (3) parseable but no created[] array → refuse (shape corruption).
  const shapelessDir = path.join(tmp, 'shapeless');
  fs.mkdirSync(shapelessDir, { recursive: true });
  fs.writeFileSync(path.join(shapelessDir, CREATED_RECORD_FILENAME), '{"issues": []}');
  await assert.rejects(() => engine.create({ runDir: shapelessDir }), /no created\[\] array.+refusing to re-create/);

  // (4) clean-empty record ({"created":[]}) → allowed; create overwrites it.
  const cleanDir = path.join(tmp, 'clean-empty');
  fs.mkdirSync(cleanDir, { recursive: true });
  const cleanPath = path.join(cleanDir, CREATED_RECORD_FILENAME);
  fs.writeFileSync(cleanPath, JSON.stringify({ created: [], links: [] }));
  const result = await engine.create({ runDir: cleanDir });
  assert.equal(result.verifyOk, true);
  assert.deepEqual(result.created.map((c) => c.key), ['PROJ-999']);
  assert.equal(JSON.parse(fs.readFileSync(cleanPath, 'utf8')).created.length, 1, 'clean-empty record was overwritten');

  // (5) the REAL engine carries the same guard for both supported agent
  // runtimes. Fixture executables make eager runtime discovery hermetic; every
  // fixture binary is also a trap, so any unexpected agent or create-tree spawn
  // writes spawnMarker and exits before it can reach credentials, network, or
  // actual user tools.
  assert.equal(process.env.PATH, fixtureBin, 'real-engine guard uses the isolated fixture-only PATH');
  for (const runtime of ['claude', 'codex']) {
    process.env.RADSVINN_AGENT_RUNTIME = runtime;
    const realEngine = createEngine('real');
    assert.equal(fs.existsSync(spawnMarker), false, `${runtime} runtime discovery must not spawn`);

    const realDir = path.join(tmp, `real-non-empty-${runtime}`);
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'plan.json'), '{}'); // pass the plan.json precondition
    const realRecordPath = path.join(realDir, CREATED_RECORD_FILENAME);
    const realRecordBody = JSON.stringify({ created: [{ key: `PROJ-${runtime === 'claude' ? '1' : '2'}` }], links: [] });
    fs.writeFileSync(realRecordPath, realRecordBody);

    await assert.rejects(() => realEngine.create({ runDir: realDir }), /refusing to re-create/);
    assert.equal(fs.readFileSync(realRecordPath, 'utf8'), realRecordBody, `${runtime} refused create must not touch the record`);
    assert.equal(fs.existsSync(spawnMarker), false, `${runtime} guard must throw before any agent or create-tree spawn`);
  }
});

// -- beyond the matrix: fail-closed edges ------------------------------------

test('retry write guard partial marker survives record deletion: retry stays blocked on the marker alone — never re-creates', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_CREATE_PARTIAL: '1' });
  t.after(() => ctx.close());

  const { planId } = await driveThroughCreate(ctx);
  process.env.RADSVINN_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores

  // First retry plants the durable partial marker (matrix item 3's path).
  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.created.partial, true);

  // A human cleans up out-of-band and deletes the record file, but the plan
  // state still carries the marker — the guard must fail closed on the
  // marker alone (the on-disk record being gone proves nothing about Jira).
  fs.rmSync(runRecordPath(ctx, planId));

  const stillBlocked = await retryAndSettle(ctx, planId);
  assert.equal(stillBlocked.body.status, 'failed', 'marker alone keeps the guard closed — no blind re-create');
  assert.match(stillBlocked.body.error, /record file at .+ is missing \(deleted after a manual cleanup\?\)/, 'a missing record is reported as MISSING — not as parse corruption, and never as permission');
  assert.match(stillBlocked.body.error, /cannot prove zero writes/, 'the block reason is spelled out');
  assert.equal(stillBlocked.body.created.partial, true, 'the existing marker is never dropped');
  assert.deepEqual(stillBlocked.body.created.keys, ['PROJ-999'], 'the recorded keys survive for the human');
});

test('retry write guard verify REJECTS (spawn failure): the partial marker survives — planted by the handler BEFORE anything awaitable', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_FAKE_CREATE_PARTIAL: '1',
    // Not set yet — listed so ctx.close() restores whatever we set mid-test.
    RADSVINN_FAKE_VERIFY_REJECT: undefined,
  });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.created, undefined, 'engine.create threw — no marker yet');
  const recordPath = runRecordPath(ctx, planId);
  injectSentinel(recordPath);

  // The recovery verify REJECTS outright (the real engine's spawn-failure/
  // timeout path) — the worker's catch lands a plain `failed` and never
  // reaches its marker-writing state.update. The marker must ALREADY be on
  // the plan, planted synchronously by handleRetry before the await.
  process.env.RADSVINN_FAKE_CREATE_PARTIAL = '0'; // ctx.close() restores
  process.env.RADSVINN_FAKE_VERIFY_REJECT = '1'; // ctx.close() restores

  const blocked = await retryAndSettle(ctx, planId);
  assert.equal(blocked.body.status, 'failed', 'a rejecting verify lands failed via the worker catch');
  assert.match(blocked.body.error, /verify spawn failed/, 'the spawn failure is surfaced');
  assert.ok(blocked.body.created, 'created marker present despite the worker never completing');
  assert.equal(blocked.body.created.partial, true, 'the durable partial marker survived the rejected verify');
  assert.equal(blocked.body.created.record_path, recordPath);
  assert.deepEqual(blocked.body.created.keys, ['PROJ-999']);
  assert.equal(readSentinel(recordPath), 'x', 'record byte-untouched — NO second create ran');

  // The whole point of planting early: even after the record file is gone,
  // the next retry must stay blocked on the marker alone. Without the
  // handler-side plant this exact chain (reject → delete → retry) fell
  // through the ladder and re-created the tree.
  fs.rmSync(recordPath);
  process.env.RADSVINN_FAKE_VERIFY_REJECT = '0';
  const stillBlocked = await retryAndSettle(ctx, planId);
  assert.equal(stillBlocked.body.status, 'failed', 'marker alone keeps the guard closed after the record is deleted');
  assert.match(stillBlocked.body.error, /cannot prove zero writes/);
  assert.equal(stillBlocked.body.created.partial, true, 'the marker is never dropped');
});

test('retry write guard verify-only recovery is never budget-blocked: a tripped daily breaker cannot strand a paid-for tree', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_FAKE_VERIFY_FAIL: '1',
    // Not set yet — listed so ctx.close() restores whatever we set mid-test.
    RADSVINN_DAILY_HARD_USD: undefined,
  });
  t.after(() => ctx.close());

  const { planId, settled: failed } = await driveThroughCreate(ctx);
  assert.equal(failed.body.status, 'failed');

  // The daily breaker trips AFTER the tree was already created ($1.7 spent
  // during planning ≥ $0 cap). The recovery read is zero-LLM-spend and must
  // NOT be blocked — otherwise an already-paid-for tree stays unverified.
  process.env.RADSVINN_DAILY_HARD_USD = '0';
  process.env.RADSVINN_FAKE_VERIFY_FAIL = '0';
  const healed = await retryAndSettle(ctx, planId);
  assert.equal(healed.body.status, 'created', 'recovery verify runs despite the tripped daily breaker');
  assert.equal(healed.body.created.verify_ok, true);
});

// -- budget_blocked is retryable --------------------------------

test('budget-retry behavior: a budget_blocked plan retries once the cap lifts — the Retry button no longer lies', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_DAILY_HARD_USD: '0' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;
  const blocked = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');
  assert.equal(blocked.body.status, 'budget_blocked', 'a $0 hard cap blocks before the first engine call');

  // The cap "resets" (UTC midnight, or raised) — the worker re-checks both
  // breakers on entry, so the accepted retry proceeds through the pipeline.
  process.env.RADSVINN_DAILY_HARD_USD = '1000'; // restored by ctx.close()
  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202, 'budget_blocked is retryable (budget-retry behavior) — no more 409ing button');
  assert.equal(retry.body.status, 'breaking_down', 'nothing was built before the block, so retry re-decomposes');
  const done = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  assert.equal(done.body.status, 'shape_ready', 'the retried plan proceeds normally');
});

test('budget-retry behavior: a still-capped retry re-blocks cleanly — accepted, then honestly budget_blocked again, never a 409 or a wedge', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_DAILY_HARD_USD: '0' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'budget_blocked');

  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202, 'the retry is ACCEPTED while still capped');
  const reblocked = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down');
  assert.equal(reblocked.body.status, 'budget_blocked', 'the worker re-checks the breaker on entry and re-blocks honestly');
});

// -- gate-checked resume ladder (found by the content-visibility adversarial review) ---
// Artifact presence alone is NOT proof of a completed phase: a plan whose
// deterministic gate FAILED still has its artifact on disk. Before this
// check, one Retry click routed such a plan straight into runCreateWorker —
// a REAL Jira tree from a gate-failed plan that never reached plan_ready and
// was therefore never rendered at ANY human gate.

test('gate-check: a plan whose PLAN gate failed retries into grooming (which re-gates) — NEVER into create', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // Drive to plan_ready normally (both artifacts on disk, both gates green)…
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready');

  // …then force exactly the state a red plan gate leaves behind: `failed`
  // with plan.json ON DISK and a NOT-ok plan_gate (runGroomWorker's
  // gate-fail path persists the artifact before gating).
  ctx.app._state.update(planId, {
    status: 'failed',
    plan_gate: { ok: false, raw: 'forced red gate (test seam)' },
    error: 'plan gate failed (test seam)',
  });

  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'grooming',
    'a gate-failed plan re-grooms (re-gating its output) — it must NEVER ride the artifact ladder into creating');

  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(settled.body.status, 'plan_ready', 're-groomed, re-gated green, waiting at the HUMAN gate');
  assert.equal(fs.existsSync(runRecordPath(ctx, planId)), false, 'create never ran — no record was ever written');
});

test('gate-check: a MISSING plan-gate result fails closed the same way (the phase never provably completed)', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready');

  // plan.json is on disk but the gate result is gone (e.g. a legacy plan, or
  // a crash between artifact write and gate) — must NOT be treated as passed.
  ctx.app._state.update(planId, { status: 'failed', plan_gate: undefined, error: 'seam: gate result lost' });

  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'grooming', 'missing gate result → re-run the phase, never assume it passed');
});

test('gate-check: a red SKELETON gate retries all the way back to breaking_down (re-decompose re-gates the shape)', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  // skeleton.json is on disk, but its gate is forced red — grooming over a
  // gate-failed shape would be garbage-in; the ladder must re-decompose.
  ctx.app._state.update(planId, {
    status: 'failed',
    skeleton_gate: { ok: false, raw: 'forced red skeleton gate (test seam)' },
    error: 'skeleton gate failed (test seam)',
  });

  const retry = await postJson(ctx.baseUrl, `/plan/${planId}/retry`, {});
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, 'breaking_down', 'a red shape gate re-decomposes — never grooms over a failed shape');
  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  assert.equal(settled.body.status, 'shape_ready', 're-decomposed and re-gated green');
});

// -- concurrency regression regression --------------------------------------
//
// handleRetry's new §5.2 body read (`await readJsonBody(...)`) is a yield
// point between the handler's initial `state.get(planId)` and the ladder's
// branch decisions below it. Before the fix, those decisions read the
// PRE-await snapshot even though `hasSkeleton`/`hasPlan` (plain
// `fs.existsSync` calls) are evaluated fresh, AFTER the await — so a
// plan_gate that lands DURING the read window was invisible to the ladder
// even though the matching plan.json on disk was not. This drives a real
// yield across that exact window: a streamed request body enqueues nothing
// until the mutation below has already run, so — regardless of network
// scheduling — the server can only ever observe "mutation, then body",
// never the reverse.

test('gate-truthfulness (review): handleRetry judges the CURRENT plan_gate/plan.json after its body-read yield, not the pre-await snapshot', async (t) => {
  const ctx = await startTestServer({ RADSVINN_SKIP_PLAN_ANCHORS: '1', RADSVINN_FAKE_GROOM_FAIL: '1' });
  t.after(() => ctx.close());

  // Drive to `failed` at the groom step: skeleton.json + a PASSING
  // skeleton_gate exist, but plan.json/plan_gate do not (the same pilot
  // scenario http-e2e.test.mjs's groom-fail test drives). Left alone, the
  // ladder's pre-fix judgment would target 'grooming'.
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  const failed = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.skeleton_gate.ok, true);
  assert.equal(failed.body.plan_gate, undefined, 'no plan_gate yet — an unfixed ladder would target grooming');

  const runDir = path.join(ctx.resultsDir, 'agent', `svc-${planId}`);

  const stream = new ReadableStream({
    async start(controller) {
      // Headroom for the server to dispatch handleRetry and suspend at its
      // `await readJsonBody` BEFORE any body byte exists to resolve it —
      // sub-millisecond in practice for an in-process loopback request.
      await sleep(50);
      // Land a fresh, passing plan_gate + plan.json exactly inside the
      // yield window. `enqueue` below strictly follows this in program
      // order, so the server cannot observe the body before this mutation
      // regardless of TCP/stream buffering.
      fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ fake: 'groomed-during-the-yield-window' }));
      ctx.app._state.update(planId, { plan_gate: { ok: true, raw: {} } });
      controller.enqueue(new TextEncoder().encode('{}'));
      controller.close();
    },
  });

  const res = await fetch(`${ctx.baseUrl}/plan/${planId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  });
  const body = await res.json();

  assert.equal(res.status, 202);
  // Pre-fix, handleRetry's ladder judged `plan.plan_gate` off the pre-await
  // snapshot (undefined) while `hasPlan` (a live fs.existsSync) already saw
  // the fresh file — the mismatched pairing would have re-targeted
  // 'grooming' and silently re-run groom over an artifact whose gate, by
  // the time the CAS actually committed, had already passed. Fixed, the
  // ladder re-reads state after the yield and must resume at 'creating'.
  assert.equal(body.status, 'creating', 'the retry ladder must judge the CURRENT plan_gate/plan.json, not the pre-await snapshot');

  const settled = await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'creating');
  assert.equal(settled.body.status, 'created', 'the ladder correctly proceeded straight to create with the fresh gate state');
});
