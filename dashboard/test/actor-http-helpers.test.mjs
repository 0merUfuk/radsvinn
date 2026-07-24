import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildActor, requesterIdentity } from '../lib/actor.mjs';
import {
  parseCookies, serializeCookie, clientIp, isUuid, id8,
} from '../lib/http-helpers.mjs';

describe('lib/actor buildActor', () => {
  test('builds the §5.2 canonical shape from a session record', () => {
    const actor = buildActor({ login: 'example-user', github_id: 1234567, display: 'Test Requester', roles: ['viewer', 'creator'] });
    assert.deepEqual(actor, {
      source: 'dashboard',
      id: 'gh:example-user',
      roles: ['viewer', 'creator'],
      github_id: 1234567,
      display: 'Test Requester',
    });
  });

  test('never trusts anything except the session — extra session fields do not leak unexpected keys', () => {
    const actor = buildActor({ login: 'a', roles: [], evil: 'should not appear' });
    assert.equal(Object.prototype.hasOwnProperty.call(actor, 'evil'), false);
  });

  test('truncates oversize id/display/roles defensively', () => {
    const actor = buildActor({
      login: 'x'.repeat(500),
      display: 'y'.repeat(500),
      roles: Array.from({ length: 50 }, (_, i) => `role${i}`),
    });
    assert.ok(actor.id.length <= 128);
    assert.ok(actor.display.length <= 256);
    assert.ok(actor.roles.length <= 16);
  });

  test('omits github_id/display when absent rather than sending null', () => {
    const actor = buildActor({ login: 'a', roles: ['viewer'] });
    assert.equal(Object.prototype.hasOwnProperty.call(actor, 'github_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(actor, 'display'), false);
  });

  test('requesterIdentity is the session login', () => {
    assert.equal(requesterIdentity({ login: 'example-user' }), 'example-user');
  });
});

describe('lib/http-helpers cookies', () => {
  test('parseCookies handles multiple cookies and URL-encoded values', () => {
    const parsed = parseCookies('a=1; b=hello%20world; c=');
    assert.deepEqual(parsed, { a: '1', b: 'hello world', c: '' });
  });

  test('parseCookies tolerates an absent header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('serializeCookie always sets Secure + HttpOnly + SameSite for __Host- names', () => {
    const cookie = serializeCookie('__Host-mercury_dash', 'abc', { maxAge: 3600 });
    assert.match(cookie, /^__Host-mercury_dash=abc;/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=3600/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('serializeCookie with maxAge<=0 expires the cookie', () => {
    const cookie = serializeCookie('__Host-mercury_dash', '', { maxAge: 0 });
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  });
});

describe('lib/http-helpers clientIp — rightmost-trusted-hop', () => {
  test('uses the rightmost XFF entry (the one Railway itself appends)', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(clientIp(req), '10.0.0.5');
  });

  test('a spoofed extra leftmost hop cannot influence the resolved ip', () => {
    const legit = { headers: { 'x-forwarded-for': '10.0.0.5' }, socket: { remoteAddress: '10.0.0.5' } };
    const spoofed = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.5' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(clientIp(legit), clientIp(spoofed), 'the trusted (rightmost) hop is identical in both cases');
  });

  test('falls back to the socket address when XFF is absent', () => {
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  });

  test('falls back to "unknown" when nothing is available', () => {
    assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown');
  });
});

describe('lib/http-helpers isUuid/id8', () => {
  test('isUuid', () => {
    assert.equal(isUuid('0d9c1234-aaaa-bbbb-cccc-000000000000'), true);
    assert.equal(isUuid('not-a-uuid'), false);
    assert.equal(isUuid(undefined), false);
  });
  test('id8 slices the first 8 chars', () => {
    assert.equal(id8('0d9c1234-aaaa-bbbb-cccc-000000000000'), '0d9c1234');
    assert.equal(id8(undefined), '');
  });
});
