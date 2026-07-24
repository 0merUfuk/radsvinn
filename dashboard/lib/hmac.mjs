// lib/hmac.mjs — the one HMAC-signing primitive shared by sessions.mjs
// (session cookie ids) and oauth.mjs (the pre-auth state cookie, §3.1/§3.2).
// Centralized so both call sites get the same timing-safe-compare discipline
// for free instead of two hand-rolled copies drifting apart.

import crypto from 'node:crypto';

export function hmacHex(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

// Constant-time string compare. Unequal lengths still run a same-cost
// comparison (against itself) so a length mismatch isn't a timing oracle.
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function signValue(value, secret) {
  return `${value}.${hmacHex(value, secret)}`;
}

// Returns the original value if the trailing HMAC verifies, else null.
export function verifySignedValue(signedValue, secret) {
  if (typeof signedValue !== 'string') return null;
  const dot = signedValue.lastIndexOf('.');
  if (dot <= 0 || dot === signedValue.length - 1) return null;
  const value = signedValue.slice(0, dot);
  const sig = signedValue.slice(dot + 1);
  const expected = hmacHex(value, secret);
  if (!timingSafeEqualStr(sig, expected)) return null;
  return value;
}
