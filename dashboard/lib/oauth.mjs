// lib/oauth.mjs — the GitHub OAuth App web flow (§3.1): login state mint,
// PKCE derivation, code exchange, identity + org/team membership checks,
// best-effort token revoke. Every GitHub call goes through `fetchImpl`
// (defaults to the global `fetch`) so tests can point it at a local fake
// GitHub server via DASH_GITHUB_API_BASE / DASH_GITHUB_OAUTH_BASE — the
// task's designated test seam. There is no auth-bypass flag of any kind.

import crypto from 'node:crypto';
import { hmacHex, signValue, verifySignedValue, timingSafeEqualStr } from './hmac.mjs';

export const OAUTH_STATE_COOKIE_NAME = '__Host-mercury_oauth';
export const OAUTH_STATE_TTL_SECONDS = 600; // 10min (§3.1)
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const TEAMS_PER_PAGE = 100;
const TEAMS_MAX_PAGES = 3;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintLoginState({ secret, randomBytes = (n) => crypto.randomBytes(n) }) {
  const state = randomBytes(32).toString('hex');
  return { state, cookieValue: signValue(state, secret) };
}

// Single-use by contract: the caller (server.mjs) clears the cookie
// unconditionally right after calling this, whatever the outcome.
export function verifyLoginState(cookieValue, queryState, secret) {
  const signedState = verifySignedValue(cookieValue, secret);
  if (signedState === null) return false;
  if (typeof queryState !== 'string' || queryState.length === 0) return false;
  return timingSafeEqualStr(signedState, queryState);
}

// PKCE is belt-and-suspenders (§3.1): the verifier is never stored
// client-side at all — it's re-derived from the already-HMAC-verified state,
// so the callback recomputes it instead of trusting a cookie/param for it.
// A hex HMAC-SHA256 digest (64 chars, [0-9a-f]) is valid PKCE alphabet+length
// (43-128 chars from [A-Za-z0-9-._~]).
export function derivePkceVerifier(state, secret) {
  return hmacHex(`pkce:${state}`, secret);
}

export function codeChallengeFromVerifier(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

export function buildAuthorizeUrl({ config, state, codeChallenge }) {
  const u = new URL('/login/oauth/authorize', config.githubOauthBase);
  u.searchParams.set('client_id', config.githubClientId);
  u.searchParams.set('redirect_uri', `${config.publicOrigin}/auth/callback`);
  u.searchParams.set('scope', 'read:org');
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Wraps fetchImpl so every GitHub call has one shape of transport failure
// (`transportOk: false`) instead of a thrown exception per call site.
async function safeFetch(url, opts, fetchImpl, timeoutMs) {
  try {
    const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    return { transportOk: true, res };
  } catch {
    return { transportOk: false };
  }
}

export async function exchangeCodeForToken({ config, code, verifier, fetchImpl = fetch, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS }) {
  const url = new URL('/login/oauth/access_token', config.githubOauthBase).toString();
  const body = JSON.stringify({
    client_id: config.githubClientId,
    client_secret: config.githubClientSecret,
    code,
    redirect_uri: `${config.publicOrigin}/auth/callback`,
    code_verifier: verifier,
  });
  const t = await safeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  }, fetchImpl, timeoutMs);
  if (!t.transportOk) return { ok: false, error: 'github unreachable' };
  let json;
  try {
    json = await t.res.json();
  } catch {
    return { ok: false, error: 'github returned a non-JSON token response' };
  }
  if (!t.res.ok || json.error || typeof json.access_token !== 'string' || json.access_token.length === 0) {
    return { ok: false, error: json.error_description || json.error || 'token exchange failed' };
  }
  const grantedScopes = String(json.scope || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!grantedScopes.includes('read:org')) {
    return { ok: false, error: 'granted scope missing read:org' };
  }
  return { ok: true, token: json.access_token, scope: grantedScopes };
}

export async function fetchUser({ config, token, fetchImpl = fetch, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS }) {
  const url = new URL('/user', config.githubApiBase).toString();
  const t = await safeFetch(url, { headers: githubHeaders(token) }, fetchImpl, timeoutMs);
  if (!t.transportOk) return { ok: false, transient: true };
  if (t.res.status === 401) return { ok: false, transient: false, reason: 'revoked' };
  if (!t.res.ok) return { ok: false, transient: true };
  let json;
  try {
    json = await t.res.json();
  } catch {
    return { ok: false, transient: true };
  }
  if (typeof json.login !== 'string' || typeof json.id !== 'number') return { ok: false, transient: true };
  return { ok: true, login: json.login, id: json.id };
}

// 200+state:"active" is the only success path. 404/403/anything-but-active
// all deny — deliberately the SAME denial page/log line for "not a member"
// and "invite pending" (no enumeration oracle, §3.1).
export async function fetchOrgMembership({ config, token, fetchImpl = fetch, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS }) {
  const url = new URL(`/user/memberships/orgs/${encodeURIComponent(config.githubOrg)}`, config.githubApiBase).toString();
  const t = await safeFetch(url, { headers: githubHeaders(token) }, fetchImpl, timeoutMs);
  if (!t.transportOk) return { ok: false, transient: true };
  if (t.res.status === 401) return { ok: false, transient: false, reason: 'revoked' };
  if (t.res.status === 404 || t.res.status === 403) return { ok: false, transient: false, reason: 'not_member' };
  if (!t.res.ok) return { ok: false, transient: true };
  let json;
  try {
    json = await t.res.json();
  } catch {
    return { ok: false, transient: true };
  }
  if (json.state !== 'active') {
    return { ok: false, transient: false, reason: json.state === 'pending' ? 'pending' : 'not_member' };
  }
  return { ok: true };
}

// Paginated, capped at 3 pages (§3.1) — a human is in at most a handful of
// teams; this bound exists to stop a pathological account from turning a
// login into unbounded GitHub calls, not to serve a real user's full list.
export async function fetchUserTeams({
  config, token, fetchImpl = fetch, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
  perPage = TEAMS_PER_PAGE, maxPages = TEAMS_MAX_PAGES,
}) {
  const slugs = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL('/user/teams', config.githubApiBase);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    // eslint-disable-next-line no-await-in-loop -- pagination is inherently sequential
    const t = await safeFetch(url.toString(), { headers: githubHeaders(token) }, fetchImpl, timeoutMs);
    if (!t.transportOk) return { ok: false, transient: true };
    if (t.res.status === 401) return { ok: false, transient: false, reason: 'revoked' };
    if (!t.res.ok) return { ok: false, transient: true };
    let json;
    try {
      // eslint-disable-next-line no-await-in-loop
      json = await t.res.json();
    } catch {
      return { ok: false, transient: true };
    }
    if (!Array.isArray(json)) return { ok: false, transient: true };
    for (const team of json) {
      if (team && team.organization && team.organization.login === config.githubOrg && typeof team.slug === 'string') {
        slugs.push(team.slug);
      }
    }
    if (json.length < perPage) break;
  }
  return { ok: true, teamSlugs: slugs };
}

// The one combined check used both at login and at every role re-verify
// (§4.3) — shaped exactly to what lib/rbac.mjs's `enforceRole` expects.
export async function checkMembershipAndTeams({ config, token, fetchImpl = fetch }) {
  const membership = await fetchOrgMembership({ config, token, fetchImpl });
  if (!membership.ok) return { ok: false, transient: membership.transient, reason: membership.reason };
  const teams = await fetchUserTeams({ config, token, fetchImpl });
  if (!teams.ok) return { ok: false, transient: teams.transient, reason: teams.reason };
  return { ok: true, teamSlugs: teams.teamSlugs };
}

// Best-effort revoke on deny/logout/expiry (§3.1). Never throws; failure is
// logged and ignored — a stuck GitHub-side grant is not this server's crisis
// to escalate to the human waiting on a redirect.
export async function revokeToken({ config, token, fetchImpl = fetch, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS, logger }) {
  if (!token) return;
  try {
    const url = new URL(`/applications/${encodeURIComponent(config.githubClientId)}/token`, config.githubApiBase).toString();
    const basic = Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString('base64');
    const t = await safeFetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ access_token: token }),
    }, fetchImpl, timeoutMs);
    if (!t.transportOk || !t.res.ok) {
      if (logger) logger.warn('github token revoke failed (best-effort, ignored)');
    }
  } catch {
    if (logger) logger.warn('github token revoke threw (best-effort, ignored)');
  }
}
