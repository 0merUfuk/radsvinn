// lib/sessions.mjs — server-side in-memory session store (§3.2).
//
// [RESOLUTION] chose a server-side store over stateless signed cookies: it's
// revocable before expiry, roles aren't frozen for the cookie lifetime, and
// the GitHub user token never has to ride in the cookie. One `Map`, single
// Railway instance (numReplicas: 1 is a contract, not an accident) — a
// redeploy logs everyone out, which is accepted (§3.2).
//
// Cookie carries only `<sessionId>.<HMAC-SHA256(sessionId, secret)>` so a
// forged id is rejected by signature BEFORE a store lookup ever happens.

import crypto from 'node:crypto';
import { signValue, verifySignedValue } from './hmac.mjs';

export const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
export const IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2h
export const ROLE_CACHE_TTL_MS = 15 * 60 * 1000; // 15min (§4.3)

export const SESSION_COOKIE_NAME = '__Host-mercury_dash';

export function signSessionId(id, secret) {
  return signValue(id, secret);
}

// Returns the sessionId if the signature verifies, else null. Malformed
// input (missing dot, empty parts) is rejected before touching HMAC.
export function verifySessionCookieValue(cookieValue, secret) {
  return verifySignedValue(cookieValue, secret);
}

export function createSessionStore({
  secret,
  now = () => Date.now(),
  randomBytes = (n) => crypto.randomBytes(n),
  absoluteTtlMs = ABSOLUTE_TTL_MS,
  idleTtlMs = IDLE_TTL_MS,
} = {}) {
  if (!secret) throw new Error('createSessionStore requires a secret');
  const store = new Map();

  function isExpired(record, t) {
    if (t - record.created_at > absoluteTtlMs) return true;
    if (t - record.last_seen_at > idleTtlMs) return true;
    return false;
  }

  return {
    // Mints a brand-new session (always — §3.2's fixation defense: never
    // reuse an id across an OAuth completion). Returns both the raw id (for
    // the cookie) and the record (for immediate use in the same request).
    create({ githubId, login, roles, ghToken, display }) {
      const t = now();
      const id = randomBytes(32).toString('hex');
      const record = {
        id,
        github_id: githubId,
        login,
        display: display || login,
        roles: [...roles],
        gh_token: ghToken,
        csrf_token: randomBytes(24).toString('base64url'),
        created_at: t,
        last_seen_at: t,
        roles_verified_at: t,
      };
      store.set(id, record);
      return { id, cookieValue: signSessionId(id, secret), record };
    },

    // Pure read: returns the record if present and unexpired, else
    // undefined. Deletes (and returns undefined for) an expired record so a
    // half-alive entry is never handed back. Does NOT slide the idle
    // window — callers that treat this as "the session was used" call
    // recordActivity() explicitly (kept separate so tests can assert
    // expiry without a read accidentally reviving the session).
    get(id) {
      const record = store.get(id);
      if (!record) return undefined;
      if (isExpired(record, now())) {
        store.delete(id);
        return undefined;
      }
      return record;
    },

    recordActivity(id) {
      const record = store.get(id);
      if (record) record.last_seen_at = now();
    },

    updateRoles(id, roles) {
      const record = store.get(id);
      if (record) {
        record.roles = [...roles];
        record.roles_verified_at = now();
      }
    },

    destroy(id) {
      store.delete(id);
    },

    // Sweeper: drop every expired record. Cheap O(n) over an in-memory Map
    // sized to concurrently-logged-in humans — never more than a handful.
    sweep() {
      const t = now();
      let removed = 0;
      for (const [id, record] of store) {
        if (isExpired(record, t)) {
          store.delete(id);
          removed += 1;
        }
      }
      return removed;
    },

    size() {
      return store.size;
    },
  };
}
