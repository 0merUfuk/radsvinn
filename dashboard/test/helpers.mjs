// test/helpers.mjs — shared scaffolding for the dashboard's node:test suite.

import { createServer } from '../server.mjs';
import { SESSION_COOKIE_NAME } from '../lib/sessions.mjs';

export function baseTestConfig(overrides = {}) {
  return {
    port: 0,
    version: 'test',
    plannerUrl: 'http://127.0.0.1:1',
    plannerToken: 'planner-test-token',
    githubClientId: 'test-client-id',
    githubClientSecret: 'test-client-secret',
    sessionSecret: 'a'.repeat(32),
    publicOrigin: 'https://dash.test',
    githubOrg: 'example-org',
    teamPlanners: new Set(['mercury-planners']),
    teamApprovers: new Set(['mercury-approvers']),
    teamCreators: new Set(['mercury-creators']),
    roleBootstrapIds: new Set(),
    roleBootstrapRaw: '',
    mutationsEnabled: true,
    githubApiBase: 'http://127.0.0.1:1',
    githubOauthBase: 'http://127.0.0.1:1',
    nodeEnv: 'test',
    ...overrides,
  };
}

// Starts a real server on an ephemeral loopback port. Returns everything a
// test typically needs plus a `stop()` that tears the whole thing down.
export async function startTestServer(options = {}) {
  const built = createServer(options);
  await new Promise((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const { port } = built.server.address();
  return {
    ...built,
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await built.close();
    },
  };
}

// Mints a session directly in the store (bypassing the OAuth round trip) —
// the fast path for RBAC/CSRF/rate-limit matrix tests that don't need to
// re-prove login itself. Returns the Cookie header value + the raw record.
export function mintSession(sessionStore, overrides = {}) {
  const { id, cookieValue, record } = sessionStore.create({
    githubId: overrides.githubId ?? 1,
    login: overrides.login ?? 'octocat',
    display: overrides.display ?? 'Octocat',
    roles: overrides.roles ?? ['viewer'],
    ghToken: overrides.ghToken ?? 'gh-token-octocat',
  });
  return { id, cookie: `${SESSION_COOKIE_NAME}=${cookieValue}`, record };
}

// A thin fetch wrapper: manual redirects (so 3xx/Location are inspectable),
// a simple cookie-header passthrough (no jar — tests compose cookies
// explicitly, matching this suite's preference for explicit over magic).
export async function request(baseUrl, path, { method = 'GET', cookie, headers = {}, body, origin } = {}) {
  const finalHeaders = { ...headers };
  if (cookie) finalHeaders.Cookie = cookie;
  if (origin !== undefined) finalHeaders.Origin = origin;
  if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return {
    status: res.status,
    location: res.headers.get('location'),
    setCookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
    headers: res.headers,
    body: json,
  };
}

export function cookieValueFromSetCookie(setCookies, name) {
  for (const line of setCookies) {
    if (line.startsWith(`${name}=`)) {
      return line.split(';')[0].slice(name.length + 1);
    }
  }
  return undefined;
}
