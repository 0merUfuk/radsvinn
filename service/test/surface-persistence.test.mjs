// surface-persistence.test.mjs — prevent orphaned client surfaces through
// BOTH loss windows.
//
//   Window A — the bridge dies MID-PLAN: the reply channel used to live only
//   in bridge RAM, so on reconnect the plan's messages had nowhere to go
//   ("no Slack channel on file — skipping post"). Now the opaque `surface`
//   descriptor on the plan record carries the address, and boot-resume
//   re-attaches from the store.
//
//   Window B — a plan reaches a TERMINAL status while the bridge is DOWN:
//   the descriptor alone can't fix this (STOP_WATCHING + seeding lastStatus
//   from the CURRENT status meant a finished plan was never re-announced).
//   The `announced_status` delivery cursor does: resume seeds lastStatus
//   from what was actually ANNOUNCED, so anything past the cursor posts on
//   the first poll.
//
// Server-side coverage runs against the real HTTP server (helpers.mjs, fake
// engine, real treecheck skeleton gate); bridge-side coverage mixes the
// house recorded-calls fakes (unit) with real-server integration drives for
// the two windows themselves. Zero network, zero sockets, zero npm deps.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createBridge } from '../slack.mjs';
import { State } from '../state.mjs';

const FAKE_ENV = { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' };
const SILENT_LOG = { error() {}, log() {} };

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** Records every call ({url, method, body}) and delegates to `responder`. */
function makeRecordingFetch(responder) {
  const calls = [];
  async function fn(url, options = {}) {
    const record = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body };
    calls.push(record);
    return responder(record, calls.length - 1);
  }
  fn.calls = calls;
  return fn;
}

function surfacePosts(fetchFn) {
  return fetchFn.calls
    .filter((c) => c.method === 'POST' && c.url.endsWith('/surface'))
    .map((c) => JSON.parse(c.body));
}

function slackPosts(fetchFn) {
  return fetchFn.calls
    .filter((c) => c.url.endsWith('chat.postMessage'))
    .map((c) => JSON.parse(c.body));
}

// ---------------------------------------------------------------------------
// server: POST /plan accepts an opaque surface, round-trips it verbatim
// ---------------------------------------------------------------------------

test('surface server: POST /plan stores the descriptor VERBATIM (opaque) and round-trips it via GET /plan/{id} and GET /plans', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // Deliberately carries a key the service has never heard of — opacity
  // means round-tripping it untouched, never validating its meaning.
  const surface = { type: 'slack', channel: 'C42', message_ts: '1730000042.000042', future_field: { nested: ['kept'] } };
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', surface });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.deepEqual(view.body.surface, surface, 'GET /plan returns the descriptor byte-for-byte');
  assert.equal('announced_status' in view.body, false, 'no cursor was ever written — the key must be absent, not null');

  const listed = await getJson(ctx.baseUrl, '/plans');
  const entry = listed.body.plans.find((p) => p.plan_id === planId);
  assert.ok(entry, 'the plan is in the boot-resume feed');
  assert.deepEqual(entry.surface, surface, 'GET /plans carries the descriptor for boot-resume');
  assert.equal('announced_status' in entry, false);

  // House discipline: never let a fire-and-forget worker outlive teardown.
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('surface server: validation — non-object and oversized surfaces are 400 (both routes); the 1024-byte boundary is exact; legacy plans keep their key-free shape', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  // Rejected POST /plan calls create NO plan (and spawn no worker).
  for (const bad of ['a-string', 42, true, ['an', 'array']]) {
    const res = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', surface: bad });
    assert.equal(res.status, 400, `surface=${JSON.stringify(bad)} must be rejected`);
    assert.ok(res.body.details.some((d) => /surface must be a plain JSON object/.test(d)));
  }
  // Oversized: JSON.stringify({k:'x'.repeat(1017)}) is 1025 bytes.
  const over = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester', surface: { k: 'x'.repeat(1017) } });
  assert.equal(over.status, 400);
  assert.ok(over.body.details.some((d) => /1024 bytes/.test(d)));

  // One real plan, created WITHOUT a surface — the legacy shape.
  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  const legacyView = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal('surface' in legacyView.body, false, 'a legacy plan has NO surface key (JSON drops undefined)');
  assert.equal('announced_status' in legacyView.body, false);
  const legacyList = await getJson(ctx.baseUrl, '/plans');
  const legacyEntry = legacyList.body.plans.find((p) => p.plan_id === planId);
  assert.equal('surface' in legacyEntry, false, 'GET /plans keeps the legacy entry shape unchanged too');
  assert.equal('announced_status' in legacyEntry, false);

  // Byte-boundary via the surface endpoint (same surfaceError code path as
  // POST /plan): exactly 1024 serialized bytes passes, 1025 fails.
  const atLimit = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { surface: { k: 'x'.repeat(1016) } });
  assert.equal(atLimit.status, 200, 'exactly 1024 bytes is accepted');
  const pastLimit = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { surface: { k: 'x'.repeat(1017) } });
  assert.equal(pastLimit.status, 400, '1025 bytes is rejected');

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('surface server: POST /plan/{id}/surface — 404 unknown, independent surface/cursor updates, full-status-set cursor validation, empty body 400', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());

  const missing = await postJson(ctx.baseUrl, '/plan/00000000-0000-4000-8000-000000000000/surface', { surface: { type: 'slack', channel: 'C1' } });
  assert.equal(missing.status, 404);

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const planId = created.body.plan_id;

  // Surface alone.
  const surface = { type: 'slack', channel: 'C1' };
  const wroteSurface = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { surface });
  assert.equal(wroteSurface.status, 200);
  assert.deepEqual(wroteSurface.body, { ok: true });

  // Cursor alone — must not disturb the stored surface (independent fields).
  const wroteCursor = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { announced_status: 'shape_ready' });
  assert.equal(wroteCursor.status, 200);
  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.deepEqual(view.body.surface, surface, 'a cursor-only write leaves the surface untouched');
  assert.equal(view.body.announced_status, 'shape_ready');

  // Every real status is a legal cursor — the spec calls out cancelling /
  // cancelled explicitly; the transients are legal too (the bridge plants a
  // breaking_down cursor at submit time).
  for (const status of ['breaking_down', 'shape_ready', 'grooming', 'plan_ready', 'creating', 'created', 'rejected', 'failed', 'budget_blocked', 'cancelling', 'cancelled']) {
    const res = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { announced_status: status });
    assert.equal(res.status, 200, `announced_status=${status} must be accepted`);
  }

  // Anything else is not.
  for (const bad of ['not_a_status', 'CREATED', 42, {}]) {
    const res = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { announced_status: bad });
    assert.equal(res.status, 400, `announced_status=${JSON.stringify(bad)} must be rejected`);
    assert.ok(res.body.details.some((d) => /announced_status must be one of/.test(d)));
  }

  // An empty write is a client bug, not a silent no-op.
  const empty = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, {});
  assert.equal(empty.status, 400);
  assert.ok(empty.body.details.some((d) => /at least one of surface \| announced_status/.test(d)));

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('surface server: POST /plan/{id}/surface is bearer-authed like every other /plan route', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1', MERCURY_SERVICE_TOKEN: 'sekret-42' });
  t.after(() => ctx.close());
  const auth = { Authorization: 'Bearer sekret-42' };

  const created = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' }, auth);
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;

  const noAuth = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { surface: { type: 'slack', channel: 'C1' } });
  assert.equal(noAuth.status, 401, 'no token → 401');
  const withAuth = await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { surface: { type: 'slack', channel: 'C1' } }, auth);
  assert.equal(withAuth.status, 200);

  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`, auth), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
});

test('surface server: the crash-resume sweep preserves surface + announced_status on the reloaded plan', async (t) => {
  // Window B composes with the sweep: a plan swept grooming→failed at
  // service boot still carries its cursor, so a bridge that ALSO restarted
  // sees failed ≠ shape_ready and delivers the ⚠️ (with its Retry button)
  // instead of losing it.
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-surface-persist-'));
  t.after(() => fs.rmSync(resultsDir, { recursive: true, force: true }));

  const plansDir = path.join(resultsDir, 'service', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planId = '77777777-7777-4777-8777-777777777777';
  const surface = { type: 'slack', channel: 'C-SWEEP', message_ts: '1730.001' };
  fs.writeFileSync(path.join(plansDir, `${planId}.json`), JSON.stringify({
    plan_id: planId,
    status: 'grooming',
    requester: 'test-requester',
    description: 'mid-groom when the process died',
    surface,
    announced_status: 'shape_ready',
    cost_usd: 0.8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, null, 2));

  const fresh = new State(resultsDir);
  fresh.load();
  const reloaded = fresh.get(planId);
  assert.equal(reloaded.status, 'failed', 'the transient sweep still fires');
  assert.equal(reloaded.error, 'interrupted by restart');
  assert.deepEqual(reloaded.surface, surface, 'the reply-to descriptor rides the sweep untouched');
  assert.equal(reloaded.announced_status, 'shape_ready', 'the delivery cursor rides the sweep untouched');

  const onDisk = JSON.parse(fs.readFileSync(path.join(plansDir, `${planId}.json`), 'utf8'));
  assert.deepEqual(onDisk.surface, surface, 'and both survive on disk, not just in memory');
  assert.equal(onDisk.announced_status, 'shape_ready');
});

// ---------------------------------------------------------------------------
// bridge unit: submit-time surface writes
// ---------------------------------------------------------------------------

function wizardSubmissionEnvelope(channel = 'C100') {
  return {
    envelope_id: 'sub-surface',
    type: 'interactive',
    payload: {
      type: 'view_submission',
      user: { username: 'test-requester' },
      view: {
        callback_id: 'plan_wizard',
        private_metadata: JSON.stringify({ channel, requester: 'test-requester' }),
        state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: 'add a thing' } } } },
      },
    },
  };
}

test('surface bridge: wizard submit sends the surface on POST /plan, then enriches it with the placeholder ts AND plants the breaking_down cursor', async () => {
  const planId = 'dddddddd-0000-4000-8000-000000000001';
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: planId, status: 'breaking_down' });
    if (call.url.endsWith(`/plan/${planId}/surface`) && call.method === 'POST') return fakeResponse(200, { ok: true });
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '1700000042.000042', channel: 'C100' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(wizardSubmissionEnvelope(), () => {});

  const planPost = JSON.parse(serviceFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/plan')).body);
  assert.deepEqual(planPost.surface, { type: 'slack', channel: 'C100' }, 'the address rides the very first write');

  const writes = surfacePosts(serviceFetch);
  assert.equal(writes.length, 1, 'exactly one follow-up surface write after the placeholder');
  assert.deepEqual(writes[0], {
    surface: { type: 'slack', channel: 'C100', message_ts: '1700000042.000042' },
    // The breaking_down cursor is Window A's linchpin: with no cursor on
    // file, resume() would seed lastStatus from the CURRENT status (the
    // legacy fallback) and a bridge death before the first announcement
    // would swallow the shape forever.
    announced_status: 'breaking_down',
  });
});

test('surface bridge: a failed placeholder post still writes the surface + cursor (just without a message_ts)', async () => {
  const planId = 'dddddddd-0000-4000-8000-000000000002';
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: planId, status: 'breaking_down' });
    if (call.url.endsWith(`/plan/${planId}/surface`) && call.method === 'POST') return fakeResponse(200, { ok: true });
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: false, error: 'ratelimited' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(wizardSubmissionEnvelope(), () => {});

  const writes = surfacePosts(serviceFetch);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    surface: { type: 'slack', channel: 'C100' },
    announced_status: 'breaking_down',
  }, 'no ts to enrich with, but the address and cursor still reach the store');
});

// ---------------------------------------------------------------------------
// bridge unit: the resume() STOP_WATCHING × cursor matrix
// ---------------------------------------------------------------------------

test('surface bridge resume: the STOP_WATCHING × cursor matrix — announced-terminal skipped, behind-cursor terminal watched once more, legacy unchanged', async () => {
  const slack = (channel) => ({ type: 'slack', channel });
  const plans = [
    // Non-terminal, announced where it stands → watched, channel attached.
    { plan_id: 'p1', status: 'shape_ready', description: 'd1', updated_at: 't', surface: slack('C1'), announced_status: 'shape_ready' },
    // Watch-terminal AND announced there → done; never re-watched.
    { plan_id: 'p2', status: 'created', description: 'd2', updated_at: 't', surface: slack('C2'), announced_status: 'created' },
    // Watch-terminal but the cursor is BEHIND (finished while down) → one
    // more watch to deliver the final message — Window B, all three kinds.
    { plan_id: 'p3', status: 'created', description: 'd3', updated_at: 't', surface: slack('C3'), announced_status: 'shape_ready' },
    { plan_id: 'p4', status: 'rejected', description: 'd4', updated_at: 't', surface: slack('C4'), announced_status: 'plan_ready' },
    { plan_id: 'p5', status: 'cancelled', description: 'd5', updated_at: 't', surface: slack('C5'), announced_status: 'created' },
    // Watch-terminal, NO cursor (legacy) → assume announced; skip (the
    // pre-Step-1 behavior — never risk a duplicate for a plan we can't prove).
    { plan_id: 'p6', status: 'created', description: 'd6', updated_at: 't', surface: slack('C6') },
    // Retryable failed, announced → watched (a Retry can revive it), but
    // seeded AT the cursor so nothing re-posts.
    { plan_id: 'p7', status: 'failed', description: 'd7', updated_at: 't', surface: slack('C7'), announced_status: 'failed' },
    // Legacy non-terminal (no surface, no cursor) → watched channel-less,
    // lastStatus = current — exactly the old behavior.
    { plan_id: 'p8', status: 'grooming', description: 'd8', updated_at: 't' },
    // Mid-cancel bridge death: cancelling is not watch-terminal → watched,
    // seeded at the created cursor, so the eventual 🚫 cancelled posts.
    { plan_id: 'p9', status: 'cancelling', description: 'd9', updated_at: 't', surface: slack('C9'), announced_status: 'created' },
    // A FOREIGN surface (not this bridge's shape) → watched channel-less;
    // the descriptor stays opaque even to the other clients.
    { plan_id: 'p10', status: 'shape_ready', description: 'd10', updated_at: 't', surface: { type: 'dashboard', view: 'main' }, announced_status: 'shape_ready' },
  ];
  const serviceFetch = makeRecordingFetch((call) => (call.url.endsWith('/plans') ? fakeResponse(200, { plans }) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.resume();

  assert.deepEqual([...bridge.watched.keys()].sort(), ['p1', 'p10', 'p3', 'p4', 'p5', 'p7', 'p8', 'p9'], 'p2 (announced created) and p6 (legacy created) are the only skips');

  assert.equal(bridge.watched.get('p1').channel, 'C1', 'Window A: the original channel re-attaches from the store');
  assert.equal(bridge.watched.get('p1').lastStatus, 'shape_ready');
  assert.equal(bridge.watched.get('p1').placeholderActive, false, 'a resumed plan has no live placeholder');

  assert.equal(bridge.watched.get('p3').lastStatus, 'shape_ready', 'seeded at the CURSOR, so created posts on the first poll');
  assert.equal(bridge.watched.get('p4').lastStatus, 'plan_ready');
  assert.equal(bridge.watched.get('p5').lastStatus, 'created');
  assert.equal(bridge.watched.get('p7').lastStatus, 'failed', 'announced failed re-watches quietly — nothing to repost');
  assert.equal(bridge.watched.get('p8').channel, undefined, 'legacy plans stay channel-less');
  assert.equal(bridge.watched.get('p8').lastStatus, 'grooming', 'legacy fallback: lastStatus = current status');
  assert.equal(bridge.watched.get('p9').lastStatus, 'created', 'a cancel interrupted by the restart still delivers its outcome');
  assert.equal(bridge.watched.get('p10').channel, undefined, 'a foreign surface type never yields a Slack channel');
});

test('surface bridge resume: a POISONED surface (channel not a non-empty string) degrades to legacy channel-less — warn-and-skip, never garbage into chat.postMessage', async () => {
  // The descriptor is opaque CLIENT-owned data on the store: nothing
  // server-side guarantees `channel` is a string. Each of these must be
  // treated exactly like a legacy plan (watched, but channel-less).
  const poisoned = [
    { plan_id: 'x1', status: 'shape_ready', description: 'd1', updated_at: 't', surface: { type: 'slack', channel: 42 }, announced_status: 'breaking_down' },
    { plan_id: 'x2', status: 'shape_ready', description: 'd2', updated_at: 't', surface: { type: 'slack', channel: { evil: true } }, announced_status: 'breaking_down' },
    { plan_id: 'x3', status: 'shape_ready', description: 'd3', updated_at: 't', surface: { type: 'slack', channel: '' }, announced_status: 'breaking_down' },
    { plan_id: 'x4', status: 'shape_ready', description: 'd4', updated_at: 't', surface: { type: 'slack' }, announced_status: 'breaking_down' },
  ];
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plans')) return fakeResponse(200, { plans: poisoned });
    const m = call.url.match(/\/plan\/(x\d)$/);
    if (m) {
      const p = poisoned.find((pl) => pl.plan_id === m[1]);
      return fakeResponse(200, { plan_id: p.plan_id, status: p.status, skeleton: { items: [] } });
    }
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const warnings = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => warnings.push(String(m)) } });

  await bridge.resume();
  for (const p of poisoned) {
    const entry = bridge.watched.get(p.plan_id);
    assert.ok(entry, `${p.plan_id} is still watched`);
    assert.equal(entry.channel, undefined, `${p.plan_id}'s poisoned channel is dropped, not carried`);
  }

  // And the first poll takes the channel-less warn-and-skip path — zero
  // Slack calls, one warning per plan — instead of posting garbage forever.
  await bridge.pollOnce();
  assert.equal(slackFetch.calls.length, 0, 'no Slack call is ever attempted with a poisoned channel');
  for (const p of poisoned) {
    assert.ok(warnings.some((w) => w.includes(p.plan_id)), `${p.plan_id} got its no-channel warning`);
  }
});

// ---------------------------------------------------------------------------
// bridge unit: cursor discipline in the poller
// ---------------------------------------------------------------------------

test('surface bridge cursor: a FAILED Slack post advances nothing — the next poll retries, and only a delivered post advances the cursor', async () => {
  const planId = 'eeeeeeee-0000-4000-8000-000000000001';
  const currentPlan = { plan_id: planId, status: 'created', created: { keys: ['PROJ-9'], verify_ok: true } };
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  let postAttempts = 0;
  const slackFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('chat.postMessage')) {
      postAttempts += 1;
      // First attempt fails (transport), second lands.
      return postAttempts === 1 ? fakeResponse(200, { ok: false, error: 'ratelimited' }) : fakeResponse(200, { ok: true, ts: '1.2' });
    }
    return fakeResponse(200, { ok: true });
  });
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'creating', messageTs: undefined });

  // Poll 1: post fails → NO cursor write, lastStatus stays behind, entry
  // survives the STOP_WATCHING delete — that is the self-heal.
  await bridge.pollOnce();
  assert.equal(surfacePosts(serviceFetch).length, 0, 'a failed post must never advance the cursor');
  assert.equal(bridge.watched.get(planId).lastStatus, 'creating', 'lastStatus stays behind so the next poll retries');

  // Poll 2: the retry lands → cursor advances → watch-terminal cleanup runs.
  await bridge.pollOnce();
  assert.equal(slackPosts(slackFetch).length, 2, 'the announcement was retried');
  const writes = surfacePosts(serviceFetch);
  assert.equal(writes.length, 1, 'exactly one cursor write, on the delivered attempt');
  assert.deepEqual(writes[0], { announced_status: 'created' });
  assert.equal(bridge.watched.has(planId), false, 'delivered created drops out of the watch map as always');
});

test('surface bridge cursor: a cursor-WRITE failure keeps lastStatus behind — the next poll re-announces (a duplicate beats a silent loss) and never throws', async () => {
  const planId = 'eeeeeeee-0000-4000-8000-000000000002';
  const currentPlan = {
    plan_id: planId, status: 'shape_ready', cost_usd: 0.8,
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] }, skeleton_gate: { ok: true },
  };
  let cursorAttempts = 0;
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') {
      cursorAttempts += 1;
      // First write throws (network), second is refused (500), third lands —
      // covering both writeSurface failure paths.
      if (cursorAttempts === 1) throw new Error('surface conn reset');
      if (cursorAttempts === 2) return fakeResponse(500, { error: 'boom' });
      return fakeResponse(200, { ok: true });
    }
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '9.9' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'breaking_down', messageTs: undefined });

  await assert.doesNotReject(() => bridge.pollOnce(), 'a throwing cursor write must not take down the poller');
  assert.equal(slackPosts(slackFetch).length, 1, 'the shape was announced');
  assert.equal(bridge.watched.get(planId).lastStatus, 'breaking_down', 'RAM mirrors the STORE: an unrecorded announcement does not count');

  await bridge.pollOnce();
  assert.equal(slackPosts(slackFetch).length, 2, 're-announced (the accepted duplicate) while the cursor write kept failing');
  assert.equal(bridge.watched.get(planId).lastStatus, 'breaking_down');

  await bridge.pollOnce();
  assert.equal(slackPosts(slackFetch).length, 3);
  assert.equal(bridge.watched.get(planId).lastStatus, 'shape_ready', 'the third write landed — cursor and RAM advance together');

  await bridge.pollOnce();
  assert.equal(slackPosts(slackFetch).length, 3, 'once recorded, the unchanged status posts nothing more');
});

test('surface bridge cursor: silent transient statuses advance the RAM marker but never the durable cursor', async () => {
  const planId = 'eeeeeeee-0000-4000-8000-000000000003';
  const currentPlan = { plan_id: planId, status: 'grooming', cost_usd: 0.8 };
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'shape_ready', messageTs: undefined });

  await bridge.pollOnce();
  assert.equal(slackFetch.calls.length, 0, 'grooming posts nothing');
  assert.equal(surfacePosts(serviceFetch).length, 0, 'the cursor records what a human SAW — a silent status shows nothing');
  assert.equal(bridge.watched.get(planId).lastStatus, 'grooming', 'the RAM marker still advances so nothing double-fires later');
});

// ---------------------------------------------------------------------------
// THE TWO WINDOWS — integration drives against the real server + store
// ---------------------------------------------------------------------------

test('WINDOW A: bridge dies mid-plan → a FRESH bridge resumes from the store and posts the shape to the ORIGINAL channel (no orphan warning)', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());
  const bridgeEnv = { ...FAKE_ENV, MERCURY_SERVICE_URL: ctx.baseUrl };

  // Bridge instance 1: a teammate submits the wizard. The plan starts, the
  // placeholder posts, the surface descriptor + breaking_down cursor land in
  // the store — and then the bridge "dies" (we simply never poll it again).
  const slackFetch1 = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '1730000001.000001', channel: 'C-ORIG' }));
  const bridge1 = createBridge({ slackFetch: slackFetch1, env: bridgeEnv, log: SILENT_LOG });
  await bridge1.handleEnvelope(wizardSubmissionEnvelope('C-ORIG'), () => {});
  const planId = [...bridge1.watched.keys()][0];
  assert.ok(planId, 'sanity: the submit started a real plan');

  // The plan reaches shape_ready while the bridge is dead.
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });

  // Bridge instance 2: fresh process, fresh RAM — everything it knows comes
  // from GET /plans.
  const warnings = [];
  const slackFetch2 = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '1730000002.000002', channel: 'C-ORIG' }));
  const bridge2 = createBridge({ slackFetch: slackFetch2, env: bridgeEnv, log: { error: (m) => warnings.push(String(m)) } });
  await bridge2.resume();

  const entry = bridge2.watched.get(planId);
  assert.ok(entry, 'the resumed bridge re-watches the plan');
  assert.equal(entry.channel, 'C-ORIG', 'the ORIGINAL channel came back from the store, not RAM');
  assert.equal(entry.lastStatus, 'breaking_down', 'seeded from the cursor — the shape is still undelivered');

  await bridge2.pollOnce();
  const posts = slackPosts(slackFetch2);
  assert.equal(posts.length, 1, 'the shape posts exactly once');
  assert.equal(posts[0].channel, 'C-ORIG', 'to the original channel');
  assert.match(posts[0].blocks[0].text.text, /Proposed plan/);
  assert.equal(warnings.some((w) => /no Slack channel on file/.test(w)), false, 'the orphan warning is DEAD for surfaced plans');

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.announced_status, 'shape_ready', 'the delivery cursor advanced in the store');
});

test('WINDOW B: a plan reaches created while the bridge is DOWN → resume + poll still announces it, advances the cursor, and a second resume is idempotent', async (t) => {
  const ctx = await startTestServer({ MERCURY_SKIP_PLAN_ANCHORS: '1' });
  t.after(() => ctx.close());
  const bridgeEnv = { ...FAKE_ENV, MERCURY_SERVICE_URL: ctx.baseUrl };

  // A surfaced plan, announced through the shape gate (cursor shape_ready —
  // exactly what a live bridge would have recorded after posting the shape).
  const created = await postJson(ctx.baseUrl, '/plan', {
    description: 'x'.repeat(50), requester: 'test-requester',
    surface: { type: 'slack', channel: 'C-B' },
  });
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/surface`, { announced_status: 'shape_ready' });

  // Bridge goes down; the plan is driven all the way to `created` (approve +
  // create can come from any surface — a raw API call here).
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'plan_ready');
  await postJson(ctx.baseUrl, `/plan/${planId}/create`, {});
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`), (r) => r.body.status === 'created');

  // Fresh bridge. Pre-Step-1 code would skip this plan entirely (created ∈
  // STOP_WATCHING) — the finished plan would be invisible forever.
  const slackFetch2 = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '2.2' }));
  const bridge2 = createBridge({ slackFetch: slackFetch2, env: bridgeEnv, log: SILENT_LOG });
  await bridge2.resume();
  const entry = bridge2.watched.get(planId);
  assert.ok(entry, 'a watch-terminal plan with a BEHIND cursor is watched once more');
  assert.equal(entry.channel, 'C-B');
  assert.equal(entry.lastStatus, 'shape_ready', 'seeded from the cursor, not the current status');

  await bridge2.pollOnce();
  const posts = slackPosts(slackFetch2);
  assert.equal(posts.length, 1, 'the created message POSTS — today\'s code would have skipped it');
  assert.equal(posts[0].channel, 'C-B');
  assert.match(posts[0].blocks[0].text.text, /🎫 Created:/);
  assert.match(posts[0].blocks[0].text.text, /PROJ-999/);
  assert.equal(bridge2.watched.has(planId), false, 'delivered → the watch-terminal cleanup still applies');

  const view = await getJson(ctx.baseUrl, `/plan/${planId}`);
  assert.equal(view.body.announced_status, 'created', 'the cursor advanced to created');

  // A THIRD bridge boot: cursor === status === created → not re-watched,
  // nothing re-posts. The recovery is idempotent.
  const slackFetch3 = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge3 = createBridge({ slackFetch: slackFetch3, env: bridgeEnv, log: SILENT_LOG });
  await bridge3.resume();
  assert.equal(bridge3.watched.has(planId), false, 'announced-at-terminal is never re-watched');
  await bridge3.pollOnce();
  assert.equal(slackFetch3.calls.length, 0, 'and nothing posts — exactly once, then silence');
});
