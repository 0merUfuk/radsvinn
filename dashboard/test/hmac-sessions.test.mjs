import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hmacHex, timingSafeEqualStr, signValue, verifySignedValue } from '../lib/hmac.mjs';
import {
  createSessionStore, signSessionId, verifySessionCookieValue,
  ABSOLUTE_TTL_MS, IDLE_TTL_MS,
} from '../lib/sessions.mjs';

describe('lib/hmac', () => {
  test('signValue/verifySignedValue round-trip', () => {
    const signed = signValue('hello', 'secret-a');
    assert.equal(verifySignedValue(signed, 'secret-a'), 'hello');
  });

  test('verifySignedValue rejects a wrong secret', () => {
    const signed = signValue('hello', 'secret-a');
    assert.equal(verifySignedValue(signed, 'secret-b'), null);
  });

  test('verifySignedValue rejects a tampered value with the original signature', () => {
    const signed = signValue('hello', 'secret-a');
    const [, sig] = signed.split('.');
    assert.equal(verifySignedValue(`goodbye.${sig}`, 'secret-a'), null);
  });

  test('verifySignedValue rejects malformed input', () => {
    assert.equal(verifySignedValue('', 'secret-a'), null);
    assert.equal(verifySignedValue('no-dot-here', 'secret-a'), null);
    assert.equal(verifySignedValue('.leading-dot', 'secret-a'), null);
    assert.equal(verifySignedValue('trailing-dot.', 'secret-a'), null);
    assert.equal(verifySignedValue(null, 'secret-a'), null);
    assert.equal(verifySignedValue(undefined, 'secret-a'), null);
  });

  test('timingSafeEqualStr compares equal and unequal strings correctly, incl. different lengths', () => {
    assert.equal(timingSafeEqualStr('abc', 'abc'), true);
    assert.equal(timingSafeEqualStr('abc', 'abd'), false);
    assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
    assert.equal(timingSafeEqualStr('', ''), true);
  });

  test('hmacHex is deterministic for the same value+secret', () => {
    assert.equal(hmacHex('x', 's'), hmacHex('x', 's'));
    assert.notEqual(hmacHex('x', 's1'), hmacHex('x', 's2'));
  });
});

describe('lib/sessions', () => {
  test('create mints a fresh id each time and stores roles/token/csrf', () => {
    const store = createSessionStore({ secret: 'sekret' });
    const a = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 'tok-a' });
    const b = store.create({ githubId: 2, login: 'b', roles: ['viewer'], ghToken: 'tok-b' });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.cookieValue, b.cookieValue);
    assert.equal(store.get(a.id).login, 'a');
    assert.equal(store.get(a.id).gh_token, 'tok-a');
    assert.match(store.get(a.id).csrf_token, /^[A-Za-z0-9_-]+$/);
  });

  test('signSessionId/verifySessionCookieValue round-trip and reject forged ids', () => {
    const cookieValue = signSessionId('abc123', 'sekret');
    assert.equal(verifySessionCookieValue(cookieValue, 'sekret'), 'abc123');
    assert.equal(verifySessionCookieValue('abc123.deadbeef', 'sekret'), null);
    assert.equal(verifySessionCookieValue('totally-forged', 'sekret'), null);
  });

  test('get() returns undefined for an unknown id', () => {
    const store = createSessionStore({ secret: 'sekret' });
    assert.equal(store.get('nope'), undefined);
  });

  test('absolute TTL expiry: a session older than 12h is gone even if recently active', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ secret: 'sekret', now: () => clock });
    const { id } = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 't' });
    // Slide the idle window right up to (but not past) the absolute ceiling.
    clock += ABSOLUTE_TTL_MS - 1000;
    store.recordActivity(id);
    assert.ok(store.get(id), 'still alive just under the absolute TTL');
    clock += 2000; // now past the 12h absolute ceiling
    assert.equal(store.get(id), undefined, 'absolute TTL must expire the session regardless of activity');
  });

  test('idle TTL expiry: 2h with no activity expires the session even under the absolute ceiling', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ secret: 'sekret', now: () => clock });
    const { id } = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 't' });
    clock += IDLE_TTL_MS + 1000;
    assert.equal(store.get(id), undefined);
  });

  test('recordActivity slides the idle window forward', () => {
    let clock = 1_000_000;
    const store = createSessionStore({ secret: 'sekret', now: () => clock });
    const { id } = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 't' });
    clock += IDLE_TTL_MS - 1000;
    store.recordActivity(id); // touch before idle expiry
    clock += IDLE_TTL_MS - 1000; // would have expired from session creation, but not from the touch
    assert.ok(store.get(id), 'idle window should have slid forward from recordActivity');
  });

  test('destroy removes the session immediately', () => {
    const store = createSessionStore({ secret: 'sekret' });
    const { id } = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 't' });
    store.destroy(id);
    assert.equal(store.get(id), undefined);
  });

  test('updateRoles replaces roles and bumps roles_verified_at', () => {
    let clock = 1000;
    const store = createSessionStore({ secret: 'sekret', now: () => clock });
    const { id } = store.create({ githubId: 1, login: 'a', roles: ['viewer'], ghToken: 't' });
    clock = 5000;
    store.updateRoles(id, ['viewer', 'planner']);
    const rec = store.get(id);
    assert.deepEqual(rec.roles, ['viewer', 'planner']);
    assert.equal(rec.roles_verified_at, 5000);
  });

  test('sweep removes only expired sessions', () => {
    let clock = 0;
    const store = createSessionStore({ secret: 'sekret', now: () => clock });
    const fresh = store.create({ githubId: 1, login: 'fresh', roles: ['viewer'], ghToken: 't' });
    clock = IDLE_TTL_MS + 1000;
    const stale = store.create({ githubId: 2, login: 'stale-created-later', roles: ['viewer'], ghToken: 't' });
    // Advance further so ONLY the first (now idle-expired) session is swept.
    clock += 1; // fresh's last_seen_at=0 is now well past idle TTL; stale's last_seen_at is current
    const removed = store.sweep();
    assert.equal(removed, 1);
    assert.equal(store.get(fresh.id), undefined);
    assert.ok(store.get(stale.id));
  });
});
