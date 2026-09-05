// token-identity.test.mjs — §5.1/§6.4: per-client bearer classification
// (classifyClient) and the confirm-string re-verification the dashboard
// token additionally requires on create/cancel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer } from '../server.mjs';

// `actor` is optional (the bridge tolerates its absence); when the caller
// is driving this through the DASHBOARD token, the caller must pass one —
// that token requires actor on every mutating route, POST /plan included.
async function driveToPlanReady(ctx, headers, actor) {
  const planBody = { description: 'x'.repeat(50), requester: 'test-requester', ...(actor ? { actor } : {}) };
  const created = await postJson(ctx.baseUrl, '/plan', planBody, headers);
  assert.equal(created.status, 202);
  const planId = created.body.plan_id;
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`, headers), (r) => r.body.status === 'shape_ready', { timeoutMs: 30000 });
  await postJson(ctx.baseUrl, `/plan/${planId}/approve-shape`, actor ? { actor } : {}, headers);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`, headers), (r) => r.body.status === 'plan_ready');
  return planId;
}

test('classifyClient: the primary token tags client:"slack", the dashboard token tags client:"dashboard", anything else 401s', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_SERVICE_TOKEN: 'bridge-secret',
    RADSVINN_SERVICE_TOKEN_DASHBOARD: 'dash-secret',
  });
  t.after(() => ctx.close());

  const noAuth = await getJson(ctx.baseUrl, '/plans');
  assert.equal(noAuth.status, 401);

  const wrongToken = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer wrong' });
  assert.equal(wrongToken.status, 401);

  const bridge = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer bridge-secret' });
  assert.equal(bridge.status, 200);

  const dashboard = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer dash-secret' });
  assert.equal(dashboard.status, 200);

  // `client` itself is never returned on any response — it only surfaces in
  // the audit ledger. Prove the classification indirectly via the
  // actor-required rule, which is gated purely on `client === 'dashboard'`.
  const dashNoActor = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' }, { Authorization: 'Bearer dash-secret' });
  assert.equal(dashNoActor.status, 400, 'the dashboard token requires actor — proves this request classified as client:"dashboard"');

  const bridgeNoActor = await postJson(ctx.baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' }, { Authorization: 'Bearer bridge-secret' });
  assert.equal(bridgeNoActor.status, 202, 'the bridge token does not require actor — proves this request classified as client:"slack"');
  await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${bridgeNoActor.body.plan_id}`, { Authorization: 'Bearer bridge-secret' }),
    (r) => r.body.status !== 'breaking_down',
    { timeoutMs: 30000 },
  );
});

test('a blank/whitespace-only dashboard token is treated as NOT CONFIGURED — that bearer arm is disabled entirely', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_SERVICE_TOKEN: 'bridge-secret',
    RADSVINN_SERVICE_TOKEN_DASHBOARD: '   ',
  });
  t.after(() => ctx.close());

  // `Authorization: Bearer ` (an empty credential) must never authenticate.
  const emptyBearer = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer ' });
  assert.equal(emptyBearer.status, 401);

  // Nor may the literal untrimmed CONFIG value become a credential.
  const whitespaceAsToken = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer    ' });
  assert.equal(whitespaceAsToken.status, 401, 'the whitespace config value must not become a literal credential either');

  const bridge = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer bridge-secret' });
  assert.equal(bridge.status, 200, 'the primary token still works normally');
});

test('dashboard-token create/cancel require the typed confirm string; missing or mismatched -> 400 and never trips the CAS; bridge token is unaffected', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SKIP_PLAN_ANCHORS: '1',
    RADSVINN_SERVICE_TOKEN: 'bridge-secret',
    RADSVINN_SERVICE_TOKEN_DASHBOARD: 'dash-secret',
  });
  t.after(() => ctx.close());
  const dashHeaders = { Authorization: 'Bearer dash-secret' };
  const dashActor = { source: 'dashboard', id: 'gh:example-user' };

  const planId = await driveToPlanReady(ctx, dashHeaders, dashActor);
  const id8 = planId.slice(0, 8);

  const noConfirm = await postJson(ctx.baseUrl, `/plan/${planId}/create`, { actor: dashActor }, dashHeaders);
  assert.equal(noConfirm.status, 400, 'a missing confirm string must 400 on the dashboard token');
  assert.match(noConfirm.body.error, /confirm must equal/);

  const wrongConfirm = await postJson(ctx.baseUrl, `/plan/${planId}/create`, { actor: dashActor, confirm: 'create-jira-tree WRONGID8' }, dashHeaders);
  assert.equal(wrongConfirm.status, 400, 'a mismatched id8 must 400, never fuzzy-match');

  const stillPlanReady = await getJson(ctx.baseUrl, `/plan/${planId}`, dashHeaders);
  assert.equal(stillPlanReady.body.status, 'plan_ready', 'a rejected confirm attempt must never trip the CAS');

  const rightConfirm = await postJson(
    ctx.baseUrl, `/plan/${planId}/create`, { actor: dashActor, confirm: `create-jira-tree ${id8}` }, dashHeaders,
  );
  assert.equal(rightConfirm.status, 202, 'the exact confirm string is accepted');
  const createdPlan = await pollUntil(
    () => getJson(ctx.baseUrl, `/plan/${planId}`, dashHeaders), (r) => r.body.status !== 'creating',
  );
  assert.equal(createdPlan.body.status, 'created');

  const cancelNoConfirm = await postJson(ctx.baseUrl, `/plan/${planId}/cancel`, { actor: dashActor }, dashHeaders);
  assert.equal(cancelNoConfirm.status, 400);
  const cancelRight = await postJson(
    ctx.baseUrl, `/plan/${planId}/cancel`, { actor: dashActor, confirm: `cancel-jira-tree ${id8}` }, dashHeaders,
  );
  assert.equal(cancelRight.status, 202);
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${planId}`, dashHeaders), (r) => r.body.status !== 'cancelling');

  // The bridge token has never required a confirm string — unaffected by design.
  const bridgeHeaders = { Authorization: 'Bearer bridge-secret' };
  const bridgePlanId = await driveToPlanReady(ctx, bridgeHeaders);
  const bridgeCreate = await postJson(ctx.baseUrl, `/plan/${bridgePlanId}/create`, {}, bridgeHeaders);
  assert.equal(bridgeCreate.status, 202, 'the bridge token has never required a confirm string');
  await pollUntil(() => getJson(ctx.baseUrl, `/plan/${bridgePlanId}`, bridgeHeaders), (r) => r.body.status !== 'creating');
});

test('identical dashboard and primary tokens fail service construction', () => {
  assert.throws(
    () => createServer({
      engineMode: 'fake',
      token: 'same-secret',
      dashboardToken: 'same-secret',
    }),
    /RADSVINN_SERVICE_TOKEN_DASHBOARD must be distinct from RADSVINN_SERVICE_TOKEN/,
    'a shared bearer would disable dashboard-only actor and confirmation enforcement',
  );
});

test('control: distinct dashboard and primary tokens construct and authenticate normally', async (t) => {
  const ctx = await startTestServer({
    RADSVINN_SERVICE_TOKEN: 'one-secret',
    RADSVINN_SERVICE_TOKEN_DASHBOARD: 'a-different-secret',
  });
  t.after(() => ctx.close());

  const primary = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer one-secret' });
  const dashboard = await getJson(ctx.baseUrl, '/plans', { Authorization: 'Bearer a-different-secret' });
  assert.equal(primary.status, 200);
  assert.equal(dashboard.status, 200);
});
