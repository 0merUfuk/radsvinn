// lib/csrf.mjs — the four independent CSRF/forgery layers (§3.3) that a
// mutation must pass, plus the OAuth `return_to` open-redirect guard (§3.1).
// Layer 1 (SameSite=Lax cookie) is enforced by the cookie attribute itself
// (lib/sessions.mjs / lib/http-helpers.mjs serializeCookie) — nothing to
// check here. Layers 2-4 live in this module.

import { timingSafeEqualStr } from './hmac.mjs';

// Layer 2: every mutation must carry Origin exactly equal to the configured
// public origin. A missing Origin is a hard 403 (a non-browser client has no
// business on cookie-authenticated routes) — this is deliberately NOT
// permissive-by-absence the way some CORS guides suggest, because these
// routes are same-origin cookie-authenticated, not a public CORS API.
export function verifyOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  return origin === publicOrigin;
}

// Layer 3: the per-session CSRF token, bootstrapped from GET /api/session
// and sent back as the X-Mercury-CSRF custom header (which also forces a
// CORS preflight this server never grants — it serves zero
// Access-Control-Allow-* headers, so no cross-origin caller can ever reach
// this comparison in the first place).
export function verifyCsrfHeader(req, session) {
  const header = req.headers['x-mercury-csrf'];
  if (typeof header !== 'string' || header.length === 0) return false;
  if (!session || !session.csrf_token) return false;
  return timingSafeEqualStr(header, session.csrf_token);
}

const CONFIRM_VERB = {
  create: 'create-jira-tree',
  cancel: 'cancel-jira-tree',
};

// Layer 4: the named, consequence-bearing confirm string on the two heavy
// actions. Requires the EXACT string incl. the plan's 8-char id prefix, so a
// blind-forged request must additionally know which plan it's attacking.
export function requiredConfirmString(action, planId) {
  const verb = CONFIRM_VERB[action];
  if (!verb) return null;
  return `${verb} ${String(planId || '').slice(0, 8)}`;
}

export function verifyConfirmString(action, planId, provided) {
  const expected = requiredConfirmString(action, planId);
  if (expected === null) return true; // action doesn't require one
  return typeof provided === 'string' && provided === expected;
}

// §3.1 point 4 — `return_to` must never become an open redirect. Rejects
// anything backslash-bearing or protocol-relative BEFORE even attempting to
// parse it, then requires the parsed origin to equal the canonical one.
// Falls closed to '/' on any doubt whatsoever.
export function validateReturnTo(rawValue, publicOrigin) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) return '/';
  if (rawValue.includes('\\')) return '/';
  if (rawValue.startsWith('//') || rawValue.startsWith('/\\')) return '/';
  if (!rawValue.startsWith('/')) return '/';
  try {
    const parsed = new URL(rawValue, publicOrigin);
    if (parsed.origin !== publicOrigin) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}
