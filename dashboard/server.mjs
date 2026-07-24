// server.mjs — the Mercury dashboard BFF entry point.
//
// `createServer(options)` wires every lib/*.mjs module together behind one
// node:http request handler and is the thing tests import directly (house
// pattern — mirrors ../service/server.mjs's `createServer(options)` shape).
// Running this file directly boots it for real, failing closed on missing
// configuration (see `boot()` at the bottom).
//
// Request pipeline for every /api/* route (the order is deliberate — see
// each comment inline):
//   1. session lookup                          (401 / 429 on no session)
//   2. rate limit gate                          (429)
//   3. Origin + CSRF header (mutations only)     (403, double-charges the
//      rate-limit bucket on failure — §3.4's forgery trip-wire)
//   4. RBAC (route table + role cache / forced fresh re-check, §4.3)
//      — this runs BEFORE the DASH_MUTATIONS=0 gate on purpose: the §9.4
//      runbook's step-4 RBAC probe asserts a viewer gets the ROLE-denial
//      body while mutations are STILL globally off (step 5 flips the
//      flag later), proving enforcement is the route table, not the flag.
//   5. route-specific validation (confirm strings, cross-requester reject)
//   6. DASH_MUTATIONS=0 gate (mutation kinds only) — the last gate before
//      the planner is ever called.
//   7. actor + upstream body construction, planner call, passthrough.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { loadConfig, validateConfig } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { securityHeadersFor, baseSecurityHeaders } from './lib/security-headers.mjs';
import {
  sendJson, sendRedirect, readJsonBody, parseCookies, serializeCookie,
  clientIp, isUuid, BodyTooLargeError,
} from './lib/http-helpers.mjs';
import {
  createSessionStore, SESSION_COOKIE_NAME, ROLE_CACHE_TTL_MS, ABSOLUTE_TTL_MS,
  verifySessionCookieValue,
} from './lib/sessions.mjs';
import {
  OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_TTL_SECONDS, mintLoginState, verifyLoginState,
  derivePkceVerifier, codeChallengeFromVerifier, buildAuthorizeUrl,
  exchangeCodeForToken, fetchUser, checkMembershipAndTeams, revokeToken,
} from './lib/oauth.mjs';
import { verifyOrigin, verifyCsrfHeader, verifyConfirmString, validateReturnTo } from './lib/csrf.mjs';
import { enforceRole, computeRoles, requiredRoleForKind, MUTATION_KINDS } from './lib/rbac.mjs';
import { createRateLimiter, LIMITS } from './lib/ratelimit.mjs';
import { createPlannerClient, toHttpOutcome } from './lib/planner-client.mjs';
import { buildActor } from './lib/actor.mjs';
import { matchRoute } from './lib/router.mjs';
import { renderShell, resolveAsset, readAsset } from './lib/pages.mjs';

const RETURN_TO_COOKIE_NAME = '__Host-mercury_return_to';
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION_CHARS = 8000;
const MUTATIONS_DISABLED_BODY = Object.freeze({ error: 'mutations are currently disabled', mutations_disabled: true });

const API_KINDS = new Set([
  'get_session', 'get_health', 'get_audit', 'list_plans', 'plans_summary', 'get_plan',
  'create_plan', 'reject', 'retry', 'approve-shape', 'create', 'cancel',
]);

function limitsForMutationKind(kind) {
  return kind === 'create_plan'
    ? { session: LIMITS.createPlan, ip: null }
    : { session: LIMITS.mutationPerSession, ip: LIMITS.mutationPerIp };
}

// BUG FOUND while adding regression coverage for the reject-ordering fix
// (not in the original review): `create_plan` gets its own, much stricter
// per-session budget (5/min — "LLM spend is behind this route", §3.4) while
// every other mutation shares a looser one (20/min). Both used to take from
// the literal SAME bucket key (`mut:s:${session.id}`) — since a token
// bucket is created once per key and later calls only reuse/refill it
// (never resetting to a NEW call's `capacity`), whichever kind hit the key
// FIRST silently capped every later call of the OTHER kind to its
// leftovers: one create_plan then a handful of reject/retry/approve-shape/
// create/cancel calls in the same session+minute would starve out around
// the 5-token mark instead of the intended 20 — a real, latent false-429
// availability bug, not merely a test artifact. Namespacing the session key
// by which budget applies gives each its own independent bucket, matching
// the two distinct rows in the §3.4 table.
function sessionMutationKey(kind, sessionId) {
  return kind === 'create_plan' ? `mut:s:create_plan:${sessionId}` : `mut:s:other:${sessionId}`;
}

export function createServer(options = {}) {
  const config = options.config || loadConfig();
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || ((n) => crypto.randomBytes(n));
  const fetchImpl = options.fetchImpl || fetch;
  const logger = options.logger || createLogger();

  const sessionStore = options.sessionStore || createSessionStore({ secret: config.sessionSecret, now, randomBytes });
  const rateLimiter = options.rateLimiter || createRateLimiter({ now });
  const plannerClient = options.plannerClient || createPlannerClient({
    baseUrl: config.plannerUrl, token: config.plannerToken, fetchImpl, now,
  });

  const rbacConfig = { ...config, roleCacheTtlMs: ROLE_CACHE_TTL_MS };

  async function recheckMembership(session) {
    return checkMembershipAndTeams({ config, token: session.gh_token, fetchImpl });
  }

  function loadSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE_NAME];
    if (!raw) return undefined;
    const id = verifySessionCookieValue(raw, config.sessionSecret);
    if (!id) return undefined;
    return sessionStore.get(id);
  }

  function chargeMutationLimitAgain(kind, session, ip) {
    const limits = limitsForMutationKind(kind);
    rateLimiter.take(sessionMutationKey(kind, session.id), limits.session);
    if (limits.ip) rateLimiter.take(`mut:ip:${ip}`, limits.ip);
  }

  async function parseMutationBody(req, respond) {
    try {
      return { ok: true, body: await readJsonBody(req) };
    } catch (err) {
      respond(err instanceof BodyTooLargeError ? 413 : 400, { error: err.message });
      return { ok: false };
    }
  }

  // ---------------------------------------------------------------------
  // Request handler
  // ---------------------------------------------------------------------

  async function handleRequest(req, res) {
    const t0 = Date.now();
    const ip = clientIp(req);

    let url;
    try {
      url = new URL(req.url, 'http://internal.invalid');
    } catch {
      sendJson(res, 400, { error: 'bad request' }, securityHeadersFor());
      return;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const route = matchRoute(req.method, segments);

    let actorLogin;
    let action = route.kind;
    let respStatus;
    let respRequestId;

    function respond(status, body, headers = {}) {
      respStatus = status;
      if (body && typeof body === 'object' && typeof body.request_id === 'string') respRequestId = body.request_id;
      sendJson(res, status, body, { ...securityHeadersFor({ noStore: true }), ...headers });
    }
    function respondPublic(status, body, headers = {}) {
      respStatus = status;
      sendJson(res, status, body, { ...securityHeadersFor({ noStore: false }), ...headers });
    }
    function redirect(status, location, headers = {}) {
      respStatus = status;
      sendRedirect(res, status, location, { ...securityHeadersFor({ noStore: true }), ...headers });
    }

    try {
      // -- non-API special-cased routes ----------------------------------
      if (route.kind === '__not_found') return respond(404, { error: 'not found' });
      if (route.kind === '__method_not_allowed') return respond(405, { error: 'method not allowed' });

      if (route.kind === 'healthz') {
        return respondPublic(200, { ok: true, version: config.version });
      }

      // -- static UI: the SSR shell + assets (both public, no session) ----
      // The shell is a static string with NO interpolated data, so it carries
      // no injection surface and needs no auth here; the client fetches
      // /api/session and bounces to /auth/login on a 401. Assets are
      // traversal-guarded in resolveAsset (resolved path must stay under
      // public/).
      if (route.kind === 'page') {
        respStatus = 200;
        const html = renderShell();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          // The shell is static and identical for everyone; short cache is
          // fine and it carries no session/plan data (no-store not needed).
          'Cache-Control': 'no-cache',
          ...baseSecurityHeaders(),
        });
        res.end(html);
        return undefined;
      }
      if (route.kind === 'asset') {
        const asset = resolveAsset(url.pathname);
        if (!asset) return respond(404, { error: 'not found' });
        respStatus = 200;
        // Fonts are content-hashed and immutable; css/js are re-fetched on
        // each deploy (short cache) so a UI fix ships without a stale bundle.
        const cache = asset.ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Length': asset.size,
          'Cache-Control': cache,
          ...baseSecurityHeaders(),
        });
        res.end(readAsset(asset.filePath));
        return undefined;
      }

      if (route.kind === 'auth_login') {
        if (!rateLimiter.take(`auth:${ip}`, LIMITS.authRoute).allowed) {
          return respond(429, { error: 'rate limit exceeded' });
        }
        const { state, cookieValue } = mintLoginState({ secret: config.sessionSecret, randomBytes });
        const verifier = derivePkceVerifier(state, config.sessionSecret);
        const codeChallenge = codeChallengeFromVerifier(verifier);
        const authorizeUrl = buildAuthorizeUrl({ config, state, codeChallenge });
        const cookies = [serializeCookie(OAUTH_STATE_COOKIE_NAME, cookieValue, { maxAge: OAUTH_STATE_TTL_SECONDS })];
        const rawReturnTo = url.searchParams.get('return_to');
        if (rawReturnTo) {
          const validated = validateReturnTo(rawReturnTo, config.publicOrigin);
          if (validated !== '/') {
            cookies.push(serializeCookie(RETURN_TO_COOKIE_NAME, validated, { maxAge: OAUTH_STATE_TTL_SECONDS }));
          }
        }
        return redirect(302, authorizeUrl, { 'Set-Cookie': cookies });
      }

      if (route.kind === 'auth_callback') {
        if (!rateLimiter.take(`auth:${ip}`, LIMITS.authRoute).allowed) {
          return respond(429, { error: 'rate limit exceeded' });
        }
        const cookies = parseCookies(req.headers.cookie);
        const stateCookieValue = cookies[OAUTH_STATE_COOKIE_NAME];
        const queryState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const clearCookies = [
          serializeCookie(OAUTH_STATE_COOKIE_NAME, '', { maxAge: 0 }),
          serializeCookie(RETURN_TO_COOKIE_NAME, '', { maxAge: 0 }),
        ];

        // Single-use, whatever happens next: verified once, cleared always.
        const stateOk = Boolean(stateCookieValue) && verifyLoginState(stateCookieValue, queryState, config.sessionSecret);
        if (!stateOk || !code) {
          logger.warn('oauth callback denied — state/code mismatch', { ip });
          return respond(403, { error: 'invalid or expired login attempt — please try signing in again' }, { 'Set-Cookie': clearCookies });
        }

        const verifier = derivePkceVerifier(queryState, config.sessionSecret);
        const tokenResult = await exchangeCodeForToken({ config, code, verifier, fetchImpl });
        if (!tokenResult.ok) {
          logger.warn('oauth callback denied — code exchange failed', { ip });
          return respond(403, { error: 'sign-in failed — please try again' }, { 'Set-Cookie': clearCookies });
        }

        const userResult = await fetchUser({ config, token: tokenResult.token, fetchImpl });
        if (!userResult.ok) {
          logger.warn('oauth callback denied — could not read GitHub identity', { ip });
          await revokeToken({ config, token: tokenResult.token, fetchImpl, logger });
          return respond(403, { error: 'sign-in failed — please try again' }, { 'Set-Cookie': clearCookies });
        }

        const membership = await checkMembershipAndTeams({ config, token: tokenResult.token, fetchImpl });
        if (!membership.ok) {
          // Deliberately the SAME message/log shape for not_member/pending —
          // no enumeration oracle (§3.1).
          logger.warn('oauth callback denied — not an active org member', { login: userResult.login });
          await revokeToken({ config, token: tokenResult.token, fetchImpl, logger });
          return respond(403, {
            error: `This dashboard is restricted to members of the ${config.githubOrg} organization. You are signed in to GitHub as ${userResult.login}, which is not an active member.`,
          }, { 'Set-Cookie': clearCookies });
        }

        const roles = computeRoles({ teamSlugs: membership.teamSlugs, githubId: userResult.id, config });
        const { cookieValue: sessionCookieValue } = sessionStore.create({
          githubId: userResult.id,
          login: userResult.login,
          display: userResult.name || userResult.login,
          roles,
          ghToken: tokenResult.token,
        });
        const sessionCookie = serializeCookie(SESSION_COOKIE_NAME, sessionCookieValue, {
          maxAge: Math.floor(ABSOLUTE_TTL_MS / 1000),
        });
        const returnTo = cookies[RETURN_TO_COOKIE_NAME]
          ? validateReturnTo(cookies[RETURN_TO_COOKIE_NAME], config.publicOrigin)
          : '/';

        actorLogin = userResult.login;
        action = 'session.login';
        logger.info('login', { login: userResult.login, roles: roles.join(',') });
        return redirect(302, returnTo, { 'Set-Cookie': [...clearCookies, sessionCookie] });
      }

      if (route.kind === 'auth_logout') {
        const s = loadSession(req);
        if (!s) return respond(401, { error: 'authentication required' });
        actorLogin = s.login;
        sessionStore.recordActivity(s.id);

        // Logout is CSRF-protected like every mutation (§3.2).
        if (!verifyOrigin(req, config.publicOrigin)) {
          logger.warn('csrf/origin failure', { ip, login: s.login, route: 'auth_logout' });
          return respond(403, { error: 'origin check failed' });
        }
        if (!verifyCsrfHeader(req, s)) {
          logger.warn('csrf/origin failure', { ip, login: s.login, route: 'auth_logout' });
          return respond(403, { error: 'csrf token mismatch — reload the page' });
        }

        sessionStore.destroy(s.id);
        await revokeToken({ config, token: s.gh_token, fetchImpl, logger });
        return redirect(303, '/', { 'Set-Cookie': [serializeCookie(SESSION_COOKIE_NAME, '', { maxAge: 0 })] });
      }

      // -- everything else is /api/* -------------------------------------
      if (!API_KINDS.has(route.kind)) return respond(404, { error: 'not found' });

      const s = loadSession(req);
      if (!s) {
        if (!rateLimiter.take(`unknownsession:${ip}`, LIMITS.unknownSession).allowed) {
          return respond(429, { error: 'rate limit exceeded' });
        }
        return respond(401, { error: 'authentication required' });
      }
      actorLogin = s.login;
      sessionStore.recordActivity(s.id);

      const isMutation = MUTATION_KINDS.has(route.kind);

      // Rate limit gate (normal single charge).
      if (isMutation) {
        const limits = limitsForMutationKind(route.kind);
        const sessOk = rateLimiter.take(sessionMutationKey(route.kind, s.id), limits.session).allowed;
        const ipOk = limits.ip ? rateLimiter.take(`mut:ip:${ip}`, limits.ip).allowed : true;
        if (!sessOk || !ipOk) return respond(429, { error: 'rate limit exceeded' });
      } else if (!rateLimiter.take(`read:s:${s.id}`, LIMITS.reads).allowed) {
        return respond(429, { error: 'rate limit exceeded' });
      }

      // Origin + CSRF header (mutations only) — failures double-charge the
      // bucket just consumed above (§3.4's forgery trip-wire).
      if (isMutation) {
        if (!verifyOrigin(req, config.publicOrigin)) {
          chargeMutationLimitAgain(route.kind, s, ip);
          logger.warn('csrf/origin failure — missing/mismatched Origin', { ip, login: s.login, route: route.kind });
          return respond(403, { error: 'origin check failed' });
        }
        if (!verifyCsrfHeader(req, s)) {
          chargeMutationLimitAgain(route.kind, s, ip);
          logger.warn('csrf/origin failure — missing/mismatched CSRF header', { ip, login: s.login, route: route.kind });
          return respond(403, { error: 'csrf token mismatch — reload the page' });
        }
      }

      // RBAC (§4.3) — deliberately before the DASH_MUTATIONS=0 gate below.
      const rbacResult = await enforceRole({
        kind: route.kind, session: s, config: rbacConfig, now: now(), recheckMembership,
      });
      if (rbacResult.outcome === 'deny_membership') {
        sessionStore.destroy(s.id);
        await revokeToken({ config, token: s.gh_token, fetchImpl, logger });
        return respond(401, { error: 'session ended — organization membership is no longer active' }, {
          'Set-Cookie': [serializeCookie(SESSION_COOKIE_NAME, '', { maxAge: 0 })],
        });
      }
      if (rbacResult.outcome === 'deny_unavailable') {
        return respond(503, { error: 'role re-verification unavailable — try again' });
      }
      if (rbacResult.rolesRefreshed) sessionStore.updateRoles(s.id, rbacResult.roles);
      if (rbacResult.outcome === 'deny_role') {
        return respond(403, { error: `requires ${requiredRoleForKind(route.kind)} role`, role_denied: true });
      }
      const effectiveRoles = rbacResult.roles;

      switch (route.kind) {
        case 'get_session': {
          return respond(200, {
            login: s.login,
            display: s.display,
            github_id: s.github_id,
            roles: effectiveRoles,
            csrf: s.csrf_token,
            csrf_token: s.csrf_token,
            since: new Date(s.created_at).toISOString(),
          });
        }

        case 'get_health': {
          const result = await plannerClient.get('/healthz');
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'get_audit': {
          const planIdParam = url.searchParams.get('plan_id');
          if (planIdParam && !isUuid(planIdParam)) return respond(400, { error: 'plan_id must be a UUID' });
          const qs = new URLSearchParams();
          if (planIdParam) qs.set('plan_id', planIdParam);
          for (const key of ['cursor', 'limit']) {
            const v = url.searchParams.get(key);
            if (v !== null) qs.set(key, v);
          }
          const qsStr = qs.toString();
          const result = await plannerClient.get(`/audit${qsStr ? `?${qsStr}` : ''}`);
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'list_plans': {
          const qs = new URLSearchParams();
          for (const key of ['status', 'limit', 'cursor']) {
            const v = url.searchParams.get(key);
            if (v !== null) qs.set(key, v);
          }
          const qsStr = qs.toString();
          const result = await plannerClient.get(`/plans${qsStr ? `?${qsStr}` : ''}`);
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'plans_summary': {
          const result = await plannerClient.get('/plans/summary');
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'get_plan': {
          const result = await plannerClient.get(`/plan/${route.planId}`);
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'create_plan': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          const { body } = parsed;
          if (typeof body.description === 'string' && body.description.length > MAX_DESCRIPTION_CHARS) {
            return respond(400, { error: `description must be <= ${MAX_DESCRIPTION_CHARS} characters` });
          }
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          action = 'plan.submit';
          // Body-merge ordering (Review notes §3 / hard constraint): spread
          // the browser body FIRST, then stamp requester/requester_id/
          // surface/actor LAST so nothing browser-supplied can survive.
          const upstreamBody = {
            ...body,
            requester: s.display,
            requester_id: s.login,
            surface: { type: 'dashboard' },
            actor: buildActor({ ...s, roles: effectiveRoles }),
          };
          const result = await plannerClient.post('/plan', upstreamBody);
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'reject': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          const { body } = parsed;
          // Mutations gate FIRST (hard constraint: mutations blocked
          // wholesale with the distinct mutations_disabled body) — this must
          // run before the plan-detail GET below so a disabled deploy never
          // makes a live upstream call, and never leaks that call's raw
          // status/body to the browser instead of the uniform 403.
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          // §4.2's compensation for the widened reject-any-plan scope: a
          // cross-requester reject needs an explicit inline ack. Reading the
          // plan here is the one extra round trip this route needs (cheap —
          // the micro-cache almost certainly already has this entry warm
          // from the detail view the reject button lives on).
          const detail = toHttpOutcome(await plannerClient.get(`/plan/${route.planId}`), crypto.randomUUID());
          if (detail.status !== 200) return respond(detail.status, detail.body);
          const plan = detail.body;
          if (plan.requester_id && plan.requester_id !== s.login && body.cross_requester_confirm !== true) {
            return respond(400, {
              error: `this plan was requested by ${plan.requester || plan.requester_id} — confirm to reject it anyway`,
              cross_requester: true,
            });
          }
          action = 'plan.reject';
          const { cross_requester_confirm, ...rest } = body;
          const upstreamBody = { ...rest, actor: buildActor({ ...s, roles: effectiveRoles }) };
          const result = await plannerClient.post(`/plan/${route.planId}/reject`, upstreamBody, { planId: route.planId });
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'retry': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          action = 'plan.retry';
          const upstreamBody = { ...parsed.body, actor: buildActor({ ...s, roles: effectiveRoles }) };
          const result = await plannerClient.post(`/plan/${route.planId}/retry`, upstreamBody, { planId: route.planId });
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'approve-shape': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          action = 'plan.approve_shape';
          const upstreamBody = { ...parsed.body, actor: buildActor({ ...s, roles: effectiveRoles }) };
          const result = await plannerClient.post(`/plan/${route.planId}/approve-shape`, upstreamBody, { planId: route.planId });
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'create': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          const { body } = parsed;
          if (!verifyConfirmString('create', route.planId, body.confirm)) {
            return respond(400, { error: 'confirmation string mismatch — type the plan id to confirm' });
          }
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          action = 'plan.create_tree';
          const upstreamBody = { ...body, actor: buildActor({ ...s, roles: effectiveRoles }) };
          const result = await plannerClient.post(`/plan/${route.planId}/create`, upstreamBody, { planId: route.planId });
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        case 'cancel': {
          const parsed = await parseMutationBody(req, respond);
          if (!parsed.ok) return undefined;
          const { body } = parsed;
          if (!verifyConfirmString('cancel', route.planId, body.confirm)) {
            return respond(400, { error: 'confirmation string mismatch — type the plan id to confirm' });
          }
          if (!config.mutationsEnabled) return respond(403, MUTATIONS_DISABLED_BODY);
          action = 'plan.cancel';
          const upstreamBody = { ...body, actor: buildActor({ ...s, roles: effectiveRoles }) };
          const result = await plannerClient.post(`/plan/${route.planId}/cancel`, upstreamBody, { planId: route.planId });
          const outcome = toHttpOutcome(result, crypto.randomUUID());
          return respond(outcome.status, outcome.body);
        }

        default:
          return respond(404, { error: 'not found' });
      }
    } catch (err) {
      logger.error('unhandled request error', { error: err && err.message });
      if (!res.headersSent) respond(500, { error: 'internal error' });
    } finally {
      logger.logRequest({
        method: req.method,
        path: url.pathname,
        status: respStatus,
        durationMs: Date.now() - t0,
        actorLogin,
        action,
        requestId: respRequestId,
      });
    }
    return undefined;
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error('request handler crashed', { error: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }, securityHeadersFor());
    });
  });

  // Explicit inbound timeouts (§3.4 hard requirement) — Node's built-in
  // defaults are safe but implicit; pin them so the contract is visible and
  // testable rather than an accident of the runtime version. headersTimeout
  // is kept above keepAliveTimeout per Node's own documented pattern (a
  // connection reused right at the keep-alive boundary still gets a moment
  // of margin before header-parsing would also time out); requestTimeout
  // bounds total request-receive time as a slow-loris defense.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.requestTimeout = 70_000;

  const sweepInterval = setInterval(() => {
    sessionStore.sweep();
    rateLimiter.sweep(10 * 60 * 1000);
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref();

  function close() {
    clearInterval(sweepInterval);
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { server, config, sessionStore, rateLimiter, plannerClient, close };
}

function boot() {
  const config = loadConfig();
  const problems = validateConfig(config);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[mercury-dashboard] FATAL: ${p}`);
    console.error('[mercury-dashboard] FATAL: refusing to boot with invalid configuration.');
    process.exit(1);
  }
  if (config.roleBootstrapIds.size > 0) {
    console.error(`[mercury-dashboard] WARN: DASH_ROLE_BOOTSTRAP is granting approver+creator to numeric ids [${[...config.roleBootstrapIds].join(',')}] ahead of team creation — clear this variable once mercury-approvers/mercury-creators exist.`);
  }
  if (!config.mutationsEnabled) {
    console.error('[mercury-dashboard] WARN: DASH_MUTATIONS=0 — every mutating /api/* route will 403.');
  }
  const { server } = createServer({ config });
  server.listen(config.port, '::', () => {
    console.log(`[mercury-dashboard] listening on [::]:${config.port} -> planner ${config.plannerUrl}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  boot();
}
