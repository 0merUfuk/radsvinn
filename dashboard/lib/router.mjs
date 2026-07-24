// lib/router.mjs — pure path/method matching (house pattern: mirrors
// service/server.mjs's matchRoute — no IO, easy to reason about in
// isolation). `kind` values line up 1:1 with lib/rbac.mjs's ROLE_FOR_KIND
// keys so the two tables never drift apart silently.
//
// Deviation note: the design doc's §4.2 role table spells the plan-detail
// route `GET /api/plans/{id}` (plural); the task's own API-surface list and
// the reference client (`/api/plan/${planId}/...`) both use the
// singular form. Both are accepted here as aliases of the exact same
// handlers — cheap to support, and it removes any integration risk for
// whichever form the client calls.

import { isUuid } from './http-helpers.mjs';
import { isPagePath } from './pages.mjs';

const PLAN_ACTIONS = new Set(['approve-shape', 'create', 'reject', 'retry', 'cancel']);

export function matchRoute(method, segments) {
  if (segments.length === 1 && segments[0] === 'healthz') {
    return method === 'GET' ? { kind: 'healthz' } : { kind: '__method_not_allowed' };
  }

  // Static assets (/assets/**) and the SSR page shell (/, /plans, …) — both
  // public and both GET-only. Neither carries session/plan data (the shell
  // is a static string), so neither needs auth here; the client fetches
  // /api/session and bounces to /auth/login on a 401.
  if (segments.length >= 1 && segments[0] === 'assets') {
    return method === 'GET' ? { kind: 'asset' } : { kind: '__method_not_allowed' };
  }
  const pathname = `/${segments.join('/')}`;
  if (segments.length === 0 || isPagePath(pathname)) {
    return method === 'GET' ? { kind: 'page' } : { kind: '__method_not_allowed' };
  }

  if (segments.length >= 1 && segments[0] === 'auth') {
    if (segments.length === 2 && segments[1] === 'login') {
      return method === 'GET' ? { kind: 'auth_login' } : { kind: '__method_not_allowed' };
    }
    if (segments.length === 2 && segments[1] === 'callback') {
      return method === 'GET' ? { kind: 'auth_callback' } : { kind: '__method_not_allowed' };
    }
    if (segments.length === 2 && segments[1] === 'logout') {
      return method === 'POST' ? { kind: 'auth_logout' } : { kind: '__method_not_allowed' };
    }
    return { kind: '__not_found' };
  }

  if (segments[0] !== 'api') return { kind: '__not_found' };
  const rest = segments.slice(1);
  if (rest.length === 0) return { kind: '__not_found' };

  if (rest.length === 1 && rest[0] === 'session') {
    return method === 'GET' ? { kind: 'get_session' } : { kind: '__method_not_allowed' };
  }
  if (rest.length === 1 && rest[0] === 'health') {
    return method === 'GET' ? { kind: 'get_health' } : { kind: '__method_not_allowed' };
  }
  if (rest.length === 1 && rest[0] === 'audit') {
    return method === 'GET' ? { kind: 'get_audit' } : { kind: '__method_not_allowed' };
  }

  if (rest[0] !== 'plan' && rest[0] !== 'plans') return { kind: '__not_found' };

  if (rest.length === 1) {
    if (rest[0] !== 'plans') return { kind: '__not_found' }; // bare /api/plan is not a route
    if (method === 'GET') return { kind: 'list_plans' };
    if (method === 'POST') return { kind: 'create_plan' };
    return { kind: '__method_not_allowed' };
  }

  if (rest[0] === 'plans' && rest.length === 2 && rest[1] === 'summary') {
    return method === 'GET' ? { kind: 'plans_summary' } : { kind: '__method_not_allowed' };
  }

  const planId = rest[1];
  if (!isUuid(planId)) return { kind: '__not_found' };

  if (rest.length === 2) {
    return method === 'GET' ? { kind: 'get_plan', planId } : { kind: '__method_not_allowed' };
  }

  if (rest.length === 3 && PLAN_ACTIONS.has(rest[2])) {
    return method === 'POST' ? { kind: rest[2], planId } : { kind: '__method_not_allowed' };
  }

  return { kind: '__not_found' };
}

export { PLAN_ACTIONS };
