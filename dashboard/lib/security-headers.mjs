// lib/security-headers.mjs — the fixed header set for every response (§3.3).
//
// CSP is the threat lens's stricter variant (adopted over `default-src
// 'self'`): default-src 'none' with each directive opened only where used.
// HSTS + X-Frame-Options + frame-ancestors close the clickjacking surface
// (§8.2 R2 carried mitigation). Cache-Control: no-store applies to every
// authenticated response (auth/api pages + any future SSR page carrying plan
// or session data) so nothing survives in a shared machine's disk cache.

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Applied to every response this server sends (§3.3's CSP is stated as "on
// every page"; the unauthenticated /healthz gets the same base hardening —
// it just doesn't need the no-store/no-cache pair since it never carries
// session or plan data).
export function baseSecurityHeaders() {
  return {
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

// Every /auth/* and /api/* response, and every SSR page carrying plan or
// session data (§3.3) — never cached, never served stale from disk.
export function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  };
}

export function securityHeadersFor({ noStore = true } = {}) {
  return {
    ...baseSecurityHeaders(),
    ...(noStore ? noStoreHeaders() : {}),
  };
}
