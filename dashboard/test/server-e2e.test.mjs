// test/server-e2e.test.mjs — independent-tester-authored integration suite.
//
// Every existing *.test.mjs file in this PR tests lib/*.mjs functions in
// isolation; NONE of them boot the real server.mjs request pipeline, and
// NONE of them exercise the OAuth flow (test/fake-github.mjs and
// test/fake-planner.mjs existed unused before this file). That leaves the
// actual wiring in server.mjs — request ordering, RBAC-before-upstream,
// the DASH_MUTATIONS gate, confirm-string enforcement, actor construction,
// CSRF/Origin enforcement, and the whole OAuth callback — completely
// unprotected by any regression test. This file closes that gap per the
// task's adversarial mandate (full OAuth flow against a fake GitHub server,
// RBAC-before-upstream call assertions, hostile-input matrix).

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGithub } from './fake-github.mjs';
import { createFakePlanner } from './fake-planner.mjs';
import {
  baseTestConfig, startTestServer, request, cookieValueFromSetCookie, mintSession,
} from './helpers.mjs';
import { SESSION_COOKIE_NAME } from '../lib/sessions.mjs';
import { OAUTH_STATE_COOKIE_NAME } from '../lib/oauth.mjs';

let fakeGithub;
let githubBaseUrl;
let fakePlanner;
let plannerBaseUrl;

before(async () => {
  fakeGithub = createFakeGithub();
  githubBaseUrl = await fakeGithub.listen();
  fakePlanner = createFakePlanner({ token: 'planner-test-token' });
  plannerBaseUrl = await fakePlanner.listen();
});

after(async () => {
  await fakeGithub.close();
  await fakePlanner.close();
});

beforeEach(() => {
  fakePlanner.reset();
});

function cfg(overrides = {}) {
  return baseTestConfig({
    plannerUrl: plannerBaseUrl,
    plannerToken: 'planner-test-token',
    githubApiBase: githubBaseUrl,
    githubOauthBase: githubBaseUrl,
    ...overrides,
  });
}

// Drives the REAL OAuth flow end to end (login -> callback) against the fake
// GitHub server and returns the resulting session cookie + csrf token.
async function loginAs(baseUrl, { login = 'octocat', id = 1, name = 'Octocat', teams = [] } = {}) {
  const loginResp = await request(baseUrl, '/auth/login');
  assert.equal(loginResp.status, 302);
  const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
  assert.ok(oauthStateCookie, 'login must set the pre-auth state cookie');
  const authorizeUrl = new URL(loginResp.location);
  const state = authorizeUrl.searchParams.get('state');
  assert.ok(state);

  const code = `code-${login}-${Math.random().toString(36).slice(2)}`;
  fakeGithub.addCode(code, { token: `tok-${login}`, scope: 'read:org' });
  fakeGithub.addUser(`tok-${login}`, {
    login, id, name, membership: { status: 200, state: 'active' }, teams,
  });

  const cbResp = await request(baseUrl, `/auth/callback?code=${code}&state=${state}`, {
    cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthStateCookie}`,
  });
  assert.equal(cbResp.status, 302, `callback should redirect; got ${cbResp.status} ${JSON.stringify(cbResp.body)}`);
  const sessionCookie = cookieValueFromSetCookie(cbResp.setCookies, SESSION_COOKIE_NAME);
  assert.ok(sessionCookie, 'callback must set the session cookie on success');
  const cookie = `${SESSION_COOKIE_NAME}=${sessionCookie}`;

  const sessResp = await request(baseUrl, '/api/session', { cookie });
  assert.equal(sessResp.status, 200);
  return { cookie, csrf: sessResp.body.csrf_token, roles: sessResp.body.roles, login: sessResp.body.login };
}

// Mints a session directly in the store (skips the OAuth round trip, like
// mintSession()) AND registers a matching fake-GitHub user for its gh_token.
// This matters because approve-shape/create/cancel are FORCE_RECHECK_KINDS
// (§4.3 point 3): they unconditionally re-verify org+team membership against
// GitHub before ANY role check is even consulted, regardless of how fresh
// the session's cached roles are. A session minted with mintSession() alone
// has a gh_token GitHub has never heard of, so a forced recheck on those
// three routes correctly (this is verified, working behavior, not a bug —
// see the tester's findings) fails closed with 401 "membership no longer
// active" rather than reaching the 403 role check at all. Tests that target
// role-deny behavior on those three routes must register a matching
// fake-GitHub identity so the recheck can succeed and the ROLE gate is what
// gets exercised.
let ghUserCounter = 0;
function mintFullSession(sessionStore, { roles = ['viewer'], teams = [] } = {}) {
  ghUserCounter += 1;
  const login = `rbac-user-${ghUserCounter}`;
  const githubId = 900000 + ghUserCounter;
  const ghToken = `gh-token-${login}`;
  const { cookie, record } = mintSession(sessionStore, {
    login, githubId, display: login, roles, ghToken,
  });
  fakeGithub.addUser(ghToken, {
    login, id: githubId, membership: { status: 200, state: 'active' }, teams,
  });
  return { cookie, record, login, githubId };
}

describe('e2e: full OAuth flow against a real fake-GitHub server (no bypass flag exists)', () => {
  test('happy path: login -> callback -> session with correctly mapped roles', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie, roles, login } = await loginAs(baseUrl, {
        login: 'planner-user', id: 42, teams: [{ slug: 'mercury-planners', organization: { login: 'example-org' } }],
      });
      assert.equal(login, 'planner-user');
      assert.deepEqual(new Set(roles), new Set(['viewer', 'planner']));
      assert.ok(cookie);
    } finally {
      await close();
    }
  });

  test('non-member is refused: no session cookie, generic 403, best-effort revoke fired', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const loginResp = await request(baseUrl, '/auth/login');
      const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
      const state = new URL(loginResp.location).searchParams.get('state');
      const code = 'code-nonmember';
      fakeGithub.addCode(code, { token: 'tok-nonmember' });
      fakeGithub.addUser('tok-nonmember', { login: 'outsider', id: 999, membership: { status: 404 } });

      const before = fakeGithub.revokeCalls.length;
      const cb = await request(baseUrl, `/auth/callback?code=${code}&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthStateCookie}`,
      });
      assert.equal(cb.status, 403);
      assert.equal(cookieValueFromSetCookie(cb.setCookies, SESSION_COOKIE_NAME), undefined, 'no session cookie of any kind');
      assert.match(cb.body.error, /restricted to members of the .+ organization/);
      assert.equal(fakeGithub.revokeCalls.length, before + 1, 'best-effort revoke must fire on deny');
    } finally {
      await close();
    }
  });

  test('non-member and pending-invite produce the IDENTICAL denial (no enumeration oracle)', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      async function attempt(login, membership) {
        const loginResp = await request(baseUrl, '/auth/login');
        const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
        const state = new URL(loginResp.location).searchParams.get('state');
        const code = `code-${login}`;
        fakeGithub.addCode(code, { token: `tok-${login}` });
        fakeGithub.addUser(`tok-${login}`, { login, id: Math.floor(Math.random() * 100000), membership });
        return request(baseUrl, `/auth/callback?code=${code}&state=${state}`, {
          cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthStateCookie}`,
        });
      }
      const notMember = await attempt('a-not-member', { status: 404 });
      const pending = await attempt('b-pending', { status: 200, state: 'pending' });
      assert.equal(notMember.status, pending.status);
      // Bodies necessarily differ only by the reflected `<login>` value —
      // strip the login token, the rest of the message must be identical.
      const strip = (msg, login) => msg.replace(login, '<login>');
      assert.equal(strip(notMember.body.error, 'a-not-member'), strip(pending.body.error, 'b-pending'));
    } finally {
      await close();
    }
  });

  test('state-cookie HMAC tamper is rejected: mismatched state -> 403, no session, cookie cleared', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const loginResp = await request(baseUrl, '/auth/login');
      const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
      const legitState = new URL(loginResp.location).searchParams.get('state');
      fakeGithub.addCode('code-tamper', { token: 'tok-tamper' });
      fakeGithub.addUser('tok-tamper', { login: 'tamperer', id: 5, membership: { status: 200, state: 'active' } });

      // Attacker flips one hex character of the signed cookie value itself.
      const tampered = oauthStateCookie.slice(0, -1) + (oauthStateCookie.slice(-1) === 'a' ? 'b' : 'a');
      const cb = await request(baseUrl, `/auth/callback?code=code-tamper&state=${legitState}`, {
        cookie: `${OAUTH_STATE_COOKIE_NAME}=${tampered}`,
      });
      assert.equal(cb.status, 403);
      assert.equal(cookieValueFromSetCookie(cb.setCookies, SESSION_COOKIE_NAME), undefined);
    } finally {
      await close();
    }
  });

  test('state cookie is single-use: replaying the same callback twice fails the second time', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const loginResp = await request(baseUrl, '/auth/login');
      const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
      const state = new URL(loginResp.location).searchParams.get('state');
      fakeGithub.addCode('code-once', { token: 'tok-once' });
      fakeGithub.addUser('tok-once', { login: 'onceuser', id: 6, membership: { status: 200, state: 'active' } });
      const cookieHeader = `${OAUTH_STATE_COOKIE_NAME}=${oauthStateCookie}`;

      const first = await request(baseUrl, `/auth/callback?code=code-once&state=${state}`, { cookie: cookieHeader });
      assert.equal(first.status, 302);
      // Same cookie, same code+state, sent again (code already consumed by
      // fake-github AND nothing stops a client from replaying the cookie —
      // but a fresh code exchange must fail since the code is single-use).
      const second = await request(baseUrl, `/auth/callback?code=code-once&state=${state}`, { cookie: cookieHeader });
      assert.equal(second.status, 403, 'replayed authorization code must not mint a second session');
    } finally {
      await close();
    }
  });

  test('CSRF/PKCE plumbing: the callback fails closed if GitHub reports scope missing read:org', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const loginResp = await request(baseUrl, '/auth/login');
      const oauthStateCookie = cookieValueFromSetCookie(loginResp.setCookies, OAUTH_STATE_COOKIE_NAME);
      const state = new URL(loginResp.location).searchParams.get('state');
      fakeGithub.addCode('code-badscope', { token: 'tok-badscope', scope: 'repo' }); // NOT read:org
      const cb = await request(baseUrl, `/auth/callback?code=code-badscope&state=${state}`, {
        cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthStateCookie}`,
      });
      assert.equal(cb.status, 403);
    } finally {
      await close();
    }
  });
});

describe('e2e: RBAC is enforced before any planner call is ever made', () => {
  const CASES = [
    { kind: 'create_plan', method: 'POST', path: '/api/plans', role: 'planner', body: { description: 'x' } },
    { kind: 'reject', method: 'POST', path: (id) => `/api/plan/${id}/reject`, role: 'planner', needsPlan: true },
    { kind: 'retry', method: 'POST', path: (id) => `/api/plan/${id}/retry`, role: 'planner', needsPlan: true },
    { kind: 'approve-shape', method: 'POST', path: (id) => `/api/plan/${id}/approve-shape`, role: 'approver', needsPlan: true },
    { kind: 'create', method: 'POST', path: (id) => `/api/plan/${id}/create`, role: 'creator', needsPlan: true },
    { kind: 'cancel', method: 'POST', path: (id) => `/api/plan/${id}/cancel`, role: 'creator', needsPlan: true },
  ];
  const PLAN_ID = '11111111-1111-1111-1111-111111111111';

  for (const c of CASES) {
    test(`${c.kind}: a session WITHOUT ${c.role} gets 403 and the planner sees zero calls`, async () => {
      const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
      try {
        // No teams registered -> a forced recheck (for approve-shape/create/
        // cancel) legitimately re-confirms active org membership but zero
        // mapped roles, so the ROLE gate (not the membership gate) is what's
        // under test here.
        const { cookie, record } = mintFullSession(sessionStore, { roles: ['viewer'], teams: [] });
        const path = typeof c.path === 'function' ? c.path(PLAN_ID) : c.path;
        const sessResp = await request(baseUrl, '/api/session', { cookie });
        const csrf = sessResp.body.csrf_token;
        const res = await request(baseUrl, path, {
          method: c.method,
          cookie,
          origin: 'https://dash.test',
          headers: { 'X-Mercury-CSRF': csrf },
          body: c.body || {},
        });
        assert.equal(res.status, 403, `expected 403 role-denial, got ${res.status} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.role_denied, true);
        assert.equal(fakePlanner.calls.length, 0, `${c.kind} must not reach the planner when RBAC denies — saw calls: ${JSON.stringify(fakePlanner.calls)}`);
        void record;
      } finally {
        await close();
      }
    });
  }

  test('a viewer CAN read (get_plan) and the call DOES reach the planner', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer'] });
      const res = await request(baseUrl, `/api/plan/${PLAN_ID}`, { cookie });
      assert.equal(res.status, 404); // fake planner's generic default for unseeded plans
      assert.equal(fakePlanner.calls.length, 1);
      assert.equal(fakePlanner.calls[0].path, `/plan/${PLAN_ID}`);
    } finally {
      await close();
    }
  });
});

describe('e2e: DASH_MUTATIONS=0 blocks every mutation with a distinct body, reads unaffected', () => {
  test('create_plan, approve-shape, create, cancel, reject, retry all 403 with mutations_disabled', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg({ mutationsEnabled: false }) });
    try {
      // approve-shape/create/cancel force-recheck regardless of the
      // DASH_MUTATIONS flag (RBAC runs before the mutations gate, §4.3/
      // server.mjs ordering) — register all three mapped teams so the
      // forced recheck doesn't itself deny before we reach the gate we're
      // actually testing.
      const org = 'example-org';
      const { cookie } = mintFullSession(sessionStore, {
        roles: ['viewer', 'planner', 'approver', 'creator'],
        teams: [
          { slug: 'mercury-planners', organization: { login: org } },
          { slug: 'mercury-approvers', organization: { login: org } },
          { slug: 'mercury-creators', organization: { login: org } },
        ],
      });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const csrf = sessResp.body.csrf_token;
      const id = '22222222-2222-2222-2222-222222222222';
      // 'reject' now follows the same clean contract as every other mutating
      // route: server.mjs's FIX moved the mutations gate before reject's
      // plan-detail GET, so it can no longer make a live upstream call (or
      // leak that call's raw status/body) while mutations are disabled — see
      // the dedicated regression test below for the direct ordering proof.
      const attempts = [
        ['POST', '/api/plans', { description: 'x' }],
        ['POST', `/api/plan/${id}/reject`, {}],
        ['POST', `/api/plan/${id}/retry`, {}],
        ['POST', `/api/plan/${id}/approve-shape`, {}],
        ['POST', `/api/plan/${id}/create`, { confirm: `create-jira-tree ${id.slice(0, 8)}` }],
        ['POST', `/api/plan/${id}/cancel`, { confirm: `cancel-jira-tree ${id.slice(0, 8)}` }],
      ];
      for (const [method, path, body] of attempts) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(baseUrl, path, {
          method, cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': csrf }, body,
        });
        assert.equal(res.status, 403, `${path} should 403 under DASH_MUTATIONS=0, got ${res.status}`);
        assert.equal(res.body.mutations_disabled, true, `${path} body must be the DISTINCT mutations-disabled shape, got ${JSON.stringify(res.body)}`);
        assert.equal(res.body.role_denied, undefined, `${path} must not be confusable with a role-denial body`);
      }
      assert.equal(fakePlanner.calls.length, 0, 'no route — including reject — may reach the planner while mutations are disabled');
      // Reads still work.
      const listRes = await request(baseUrl, '/api/plans', { cookie });
      assert.equal(listRes.status, 200);
    } finally {
      await close();
    }
  });

  test('FIXED (server.mjs reject case, was ~405-423): the mutations gate now runs BEFORE the plan-detail GET, ' +
    'so a disabled deploy never makes a live upstream call and never leaks its raw status/body instead of the ' +
    'distinct mutations_disabled 403 — regression test for the ordering bug', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg({ mutationsEnabled: false }) });
    try {
      const { cookie } = mintFullSession(sessionStore, { roles: ['viewer', 'planner'], teams: [] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      // An id the fake planner has nothing seeded for (its default is a
      // 404) — before the fix this 404 leaked straight through
      // DASH_MUTATIONS=0; this proves the planner is never even asked now,
      // regardless of what its (unreached) response would have been.
      const id = '22222222-2222-2222-2222-222299999999'.slice(0, 36);
      const res = await request(baseUrl, `/api/plan/${id}/reject`, {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: {},
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.mutations_disabled, true);
      assert.equal(fakePlanner.calls.length, 0, 'the plan-detail GET must never fire while mutations are disabled');
    } finally {
      await close();
    }
  });

  test('the mutations-disabled body is DISTINCT from the RBAC role-denial body (§9.4 runbook step 4 depends on this)', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg({ mutationsEnabled: false }) });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer'] }); // lacks planner role too
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: {},
      });
      // RBAC runs BEFORE the mutations gate, so a role-less session must see
      // the ROLE denial, not the mutations-disabled one, even with mutations off.
      assert.equal(res.status, 403);
      assert.equal(res.body.role_denied, true, 'RBAC must be evaluated before the DASH_MUTATIONS gate');
      assert.equal(res.body.mutations_disabled, undefined);
    } finally {
      await close();
    }
  });
});

describe('e2e: mutation rate-limit buckets are independent per kind (regression)', () => {
  test("create_plan's own 5/min budget does not starve the 20/min budget shared by every other mutation", async () => {
    // BUG found while adding regression coverage for the reject-ordering fix
    // above (not in the original review): create_plan's session bucket and
    // every other mutation's session bucket used to share the literal same
    // key (`mut:s:${session.id}`). A token bucket is created once per key
    // and later calls only refill/reuse it — they never reset to a NEW
    // call's `capacity` — so whichever kind hit the key FIRST silently
    // capped the OTHER kind's calls to its leftovers for the rest of the
    // window. Fixed in server.mjs via `sessionMutationKey` namespacing the
    // key by which budget applies (§3.4 defines these as two independent
    // rows: 5/min for create_plan, 20/min for everything else).
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintFullSession(sessionStore, { roles: ['viewer', 'planner'], teams: [] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const csrf = sessResp.body.csrf_token;
      const id = '22222222-2222-2222-2222-222222222222';

      // Exhaust create_plan's own 5/min budget first.
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(baseUrl, '/api/plans', {
          method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': csrf }, body: { description: 'x' },
        });
        assert.notEqual(res.status, 429, `create_plan attempt ${i + 1}/5 should still be within its own budget`);
      }
      const sixth = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': csrf }, body: { description: 'x' },
      });
      assert.equal(sixth.status, 429, "create_plan's own 5/min budget really is exhausted by the 6th call");

      // A DIFFERENT mutation kind, same session, must NOT be affected by
      // create_plan's now-exhausted budget.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(baseUrl, `/api/plan/${id}/reject`, {
          method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': csrf }, body: {},
        });
        assert.notEqual(res.status, 429, `reject attempt ${i + 1}/10 must not be rate-limited by create_plan's separate, already-exhausted budget`);
      }
    } finally {
      await close();
    }
  });
});

describe('e2e: confirm-string is enforced server-side on create/cancel', () => {
  test('create without a confirm string is rejected before reaching the planner', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintFullSession(sessionStore, {
        roles: ['viewer', 'creator'],
        teams: [{ slug: 'mercury-creators', organization: { login: 'example-org' } }],
      });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const id = '33333333-3333-3333-3333-333333333333';
      const res = await request(baseUrl, `/api/plan/${id}/create`, {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: {},
      });
      assert.equal(res.status, 400);
      assert.equal(fakePlanner.calls.length, 0, 'no upstream call when the confirm string is missing');
    } finally {
      await close();
    }
  });

  test('create with the WRONG plan-id prefix in the confirm string is rejected', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintFullSession(sessionStore, {
        roles: ['viewer', 'creator'],
        teams: [{ slug: 'mercury-creators', organization: { login: 'example-org' } }],
      });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const id = '44444444-4444-4444-4444-444444444444';
      const res = await request(baseUrl, `/api/plan/${id}/create`, {
        method: 'POST',
        cookie,
        origin: 'https://dash.test',
        headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token },
        body: { confirm: 'create-jira-tree 00000000' },
      });
      assert.equal(res.status, 400);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('create with the correct confirm string reaches the planner and echoes request_id', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintFullSession(sessionStore, {
        roles: ['viewer', 'creator'],
        teams: [{ slug: 'mercury-creators', organization: { login: 'example-org' } }],
      });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const id = '55555555-5555-5555-5555-555555555555';
      const res = await request(baseUrl, `/api/plan/${id}/create`, {
        method: 'POST',
        cookie,
        origin: 'https://dash.test',
        headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token },
        body: { confirm: `create-jira-tree ${id.slice(0, 8)}` },
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(fakePlanner.calls.length, 1);
      assert.equal(fakePlanner.calls[0].path, `/plan/${id}/create`);
    } finally {
      await close();
    }
  });

  test('reject and retry do NOT require a confirm string (only create/cancel do)', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const id = '66666666-6666-6666-6666-666666666666';
      fakePlanner.on('GET', `/plan/${id}`, { status: 200, body: { plan_id: id, requester_id: sessResp.body.login, status: 'shape_ready' } });
      const res = await request(baseUrl, `/api/plan/${id}/reject`, {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: {},
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      await close();
    }
  });
});

describe('e2e: CSRF/Origin layer on real HTTP requests', () => {
  test('a mutation with no Origin header at all is rejected (non-browser clients have no business here)', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: { description: 'x' },
      });
      assert.equal(res.status, 403);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('a mutation with the WRONG Origin is rejected', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://evil.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: { description: 'x' },
      });
      assert.equal(res.status, 403);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('correct Origin but missing/wrong CSRF header is rejected', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const noHeader = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://dash.test', body: { description: 'x' },
      });
      assert.equal(noHeader.status, 403);
      const wrongHeader = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': 'totally-wrong' }, body: { description: 'x' },
      });
      assert.equal(wrongHeader.status, 403);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('reads never require Origin/CSRF at all (GETs are side-effect-free by contract)', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer'] });
      const res = await request(baseUrl, '/api/plans', { cookie }); // no Origin, no CSRF header
      assert.equal(res.status, 200);
    } finally {
      await close();
    }
  });
});

describe('e2e: actor is constructed ONLY from the server-side session — smuggling attempts fail', () => {
  test('a forged `actor` field in the request body is discarded; the upstream actor is the real session identity', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, {
        login: 'real-user', githubId: 777, display: 'Real User', roles: ['viewer', 'planner'],
      });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST',
        cookie,
        origin: 'https://dash.test',
        headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token },
        body: {
          description: 'legit ask',
          actor: { source: 'slack', id: 'gh:attacker', display: 'Attacker', roles: ['creator'] },
          requester: 'Attacker Display', // also attempts to smuggle requester identity
          requester_id: 'attacker-login',
        },
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(fakePlanner.calls.length, 1);
      const forwarded = fakePlanner.calls[0].body;
      assert.deepEqual(forwarded.actor, {
        source: 'dashboard', id: 'gh:real-user', github_id: 777, display: 'Real User', roles: ['viewer', 'planner'],
      }, `actor must come from the session, not the body — forwarded: ${JSON.stringify(forwarded.actor)}`);
      assert.equal(forwarded.requester, 'Real User', 'requester must be server-stamped, not attacker-supplied');
      assert.equal(forwarded.requester_id, 'real-user', 'requester_id must be server-stamped, not attacker-supplied');
    } finally {
      await close();
    }
  });

  test('an X-Radsvinn-Actor / X-Radsvinn-Role header cannot influence RBAC or the forwarded actor', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { login: 'plain-viewer', roles: ['viewer'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST',
        cookie,
        origin: 'https://dash.test',
        headers: {
          'X-Mercury-CSRF': sessResp.body.csrf_token,
          'X-Radsvinn-Role': 'creator',
          'X-Radsvinn-Actor': 'gh:attacker',
        },
        body: { description: 'x' },
      });
      // plain-viewer lacks `planner`, so this must still be a role denial —
      // proving the spoofed X-Radsvinn-Role header changed nothing.
      assert.equal(res.status, 403);
      assert.equal(res.body.role_denied, true);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('cross-requester reject requires the explicit confirm flag, and the audited identities are the real ones', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { login: 'rejecting-user', roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const id = '77777777-7777-7777-7777-777777777777';
      fakePlanner.on('GET', `/plan/${id}`, { status: 200, body: { plan_id: id, requester: 'Someone Else', requester_id: 'someone-else', status: 'shape_ready' } });

      const withoutConfirm = await request(baseUrl, `/api/plan/${id}/reject`, {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: {},
      });
      assert.equal(withoutConfirm.status, 400);
      assert.equal(withoutConfirm.body.cross_requester, true);
      assert.equal(fakePlanner.calls.filter((c) => c.method === 'POST').length, 0, 'no reject POST without the cross-requester ack');

      const withConfirm = await request(baseUrl, `/api/plan/${id}/reject`, {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: { cross_requester_confirm: true },
      });
      assert.equal(withConfirm.status, 200, JSON.stringify(withConfirm.body));
      const postCall = fakePlanner.calls.find((c) => c.method === 'POST');
      assert.equal(postCall.body.actor.id, 'gh:rejecting-user');
      assert.equal(postCall.body.cross_requester_confirm, undefined, 'the internal ack flag must not leak upstream unchanged into the planner body');
    } finally {
      await close();
    }
  });
});

describe('e2e: hostile input matrix', () => {
  test('oversized body (>64KB) is rejected with 413 before JSON parsing', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST',
        cookie,
        origin: 'https://dash.test',
        headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token },
        body: { description: 'x'.repeat(70 * 1024) },
      });
      assert.equal(res.status, 413);
      assert.equal(fakePlanner.calls.length, 0);
    } finally {
      await close();
    }
  });

  test('malformed JSON body -> 400, not a 500 crash', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const res = await fetch(`${baseUrl}/api/plans`, {
        method: 'POST',
        headers: {
          Cookie: cookie, Origin: 'https://dash.test', 'X-Mercury-CSRF': sessResp.body.csrf_token, 'Content-Type': 'application/json',
        },
        body: '{not valid json!!!',
      });
      assert.equal(res.status, 400);
    } finally {
      await close();
    }
  });

  test('prototype-pollution keys in the body do not pollute Object.prototype and the request completes cleanly', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg() });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer', 'planner'] });
      const sessResp = await request(baseUrl, '/api/session', { cookie });
      const evilBody = JSON.parse('{"description":"x","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}');
      const res = await request(baseUrl, '/api/plans', {
        method: 'POST', cookie, origin: 'https://dash.test', headers: { 'X-Mercury-CSRF': sessResp.body.csrf_token }, body: evilBody,
      });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted by __proto__ in a JSON body');
      assert.equal({}.polluted2, undefined, 'Object.prototype must not be polluted via constructor.prototype in a JSON body');
    } finally {
      await close();
    }
  });

  test('prototype-pollution-shaped cookie names do not corrupt cookie parsing', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const res = await request(baseUrl, '/api/session', { cookie: '__proto__=hello; constructor=world; a=1' });
      assert.equal(res.status, 401); // simply unauthenticated — must not throw/500
      assert.equal({}.hello, undefined);
    } finally {
      await close();
    }
  });

  test('static traversal probes never escape public/ (UI serves the shell + assets only)', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      // These must NEVER serve a file outside public/ — a 200 here would be a
      // source-disclosure hole. (Undefined-body requests use raw fetch since
      // request() assumes JSON; a leaked .mjs would not be JSON.)
      for (const p of ['/assets/../../../etc/passwd', '/assets/%2e%2e/server.mjs', '/assets/../server.mjs', '/assets/server.mjs']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${baseUrl}${p}`, { redirect: 'manual' });
        // eslint-disable-next-line no-await-in-loop
        const text = await res.text();
        assert.equal(res.status, 404, `${p} must not be served`);
        assert.ok(!text.includes('createServer'), `${p} must not leak source`);
      }
      // `/` now legitimately serves the static shell (no session/plan data).
      const home = await fetch(`${baseUrl}/`, { redirect: 'manual' });
      assert.equal(home.status, 200, '/ serves the SSR shell');
    } finally {
      await close();
    }
  });

  test('session fixation attempt: an attacker-preset cookie value is never adopted as a live session', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const res = await request(baseUrl, '/api/session', { cookie: `${SESSION_COOKIE_NAME}=attacker-chosen-id.deadbeef` });
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  test('planner-down (unreachable upstream) degrades to a generic 502, never a raw error/hostname', async () => {
    const { baseUrl, sessionStore, close } = await startTestServer({
      config: cfg({ plannerUrl: 'http://127.0.0.1:1' }), // port 1: nothing listens, connection refused
    });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer'] });
      const res = await request(baseUrl, '/api/plans', { cookie });
      assert.equal(res.status, 502);
      assert.deepEqual(Object.keys(res.body).sort(), ['error', 'request_id'].sort());
      assert.equal(res.body.error, 'planner unavailable');
      const dump = JSON.stringify(res.body);
      assert.ok(!/127\.0\.0\.1|ECONNREFUSED|Error:|at /.test(dump), `502 body leaked internal detail: ${dump}`);
    } finally {
      await close();
    }
  });

  test('an expired (past absolute TTL) session is rejected as unauthenticated, not silently revived', async () => {
    let clock = 1_000_000;
    const { baseUrl, sessionStore, close } = await startTestServer({ config: cfg(), now: () => clock });
    try {
      const { cookie } = mintSession(sessionStore, { roles: ['viewer'] });
      clock += 12 * 60 * 60 * 1000 + 1000; // past the 12h absolute ceiling
      const res = await request(baseUrl, '/api/plans', { cookie });
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  test('parallel logins by two different users mint fully independent sessions', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      const [a, b] = await Promise.all([
        loginAs(baseUrl, { login: 'user-a', id: 101 }),
        loginAs(baseUrl, { login: 'user-b', id: 102 }),
      ]);
      assert.notEqual(a.cookie, b.cookie);
      const [sa, sb] = await Promise.all([
        request(baseUrl, '/api/session', { cookie: a.cookie }),
        request(baseUrl, '/api/session', { cookie: b.cookie }),
      ]);
      assert.equal(sa.body.login, 'user-a');
      assert.equal(sb.body.login, 'user-b');
    } finally {
      await close();
    }
  });

  test('an invalid/unknown session cookie is rate-limited separately from valid-session traffic', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      let last;
      for (let i = 0; i < 35; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        last = await request(baseUrl, '/api/plans', { cookie: `${SESSION_COOKIE_NAME}=bogus.${i}` });
      }
      assert.equal(last.status, 429, 'the 30/min unknown-session bucket must eventually trip');
    } finally {
      await close();
    }
  });
});

describe('e2e: the UI shell is served (public, static, cacheable, CSP-hardened)', () => {
  test('GET / and every page path serve the client shell with CSP and no session', async () => {
    const { baseUrl, close } = await startTestServer({ config: cfg() });
    try {
      for (const p of ['/', '/plans', '/plans/new', '/operations', '/audit', '/settings']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${baseUrl}${p}`, { redirect: 'manual' });
        // eslint-disable-next-line no-await-in-loop
        const text = await res.text();
        assert.equal(res.status, 200, `${p} serves the shell`);
        assert.match(res.headers.get('content-type'), /text\/html/);
        assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match(text, /id="main"/);
      }
    } finally {
      await close();
    }
  });
});

describe('e2e: inbound server timeouts are explicit (§3.4 hard requirement)', () => {
  test('keepAliveTimeout/headersTimeout/requestTimeout are pinned, not left at Node\'s implicit defaults', async () => {
    const { server, close } = await startTestServer({ config: cfg() });
    try {
      assert.equal(server.keepAliveTimeout, 60_000);
      assert.equal(server.headersTimeout, 65_000);
      assert.equal(server.requestTimeout, 70_000);
      assert.ok(server.headersTimeout > server.keepAliveTimeout, 'headersTimeout must stay above keepAliveTimeout');
    } finally {
      await close();
    }
  });
});
