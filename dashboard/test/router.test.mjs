import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchRoute } from '../lib/router.mjs';

const ID = '0d9c1234-aaaa-bbbb-cccc-000000000000';
const seg = (p) => p.split('/').filter(Boolean);

describe('lib/router matchRoute', () => {
  test('healthz', () => {
    assert.deepEqual(matchRoute('GET', seg('/healthz')), { kind: 'healthz' });
    assert.deepEqual(matchRoute('POST', seg('/healthz')), { kind: '__method_not_allowed' });
  });

  test('auth routes', () => {
    assert.deepEqual(matchRoute('GET', seg('/auth/login')), { kind: 'auth_login' });
    assert.deepEqual(matchRoute('POST', seg('/auth/login')), { kind: '__method_not_allowed' });
    assert.deepEqual(matchRoute('GET', seg('/auth/callback')), { kind: 'auth_callback' });
    assert.deepEqual(matchRoute('POST', seg('/auth/logout')), { kind: 'auth_logout' });
    assert.deepEqual(matchRoute('GET', seg('/auth/logout')), { kind: '__method_not_allowed' });
    assert.deepEqual(matchRoute('GET', seg('/auth/nope')), { kind: '__not_found' });
  });

  test('session/health/audit', () => {
    assert.deepEqual(matchRoute('GET', seg('/api/session')), { kind: 'get_session' });
    assert.deepEqual(matchRoute('GET', seg('/api/health')), { kind: 'get_health' });
    assert.deepEqual(matchRoute('GET', seg('/api/audit')), { kind: 'get_audit' });
    assert.deepEqual(matchRoute('POST', seg('/api/audit')), { kind: '__method_not_allowed' });
  });

  test('plans list/create/summary', () => {
    assert.deepEqual(matchRoute('GET', seg('/api/plans')), { kind: 'list_plans' });
    assert.deepEqual(matchRoute('POST', seg('/api/plans')), { kind: 'create_plan' });
    assert.deepEqual(matchRoute('DELETE', seg('/api/plans')), { kind: '__method_not_allowed' });
    assert.deepEqual(matchRoute('GET', seg('/api/plans/summary')), { kind: 'plans_summary' });
    assert.deepEqual(matchRoute('POST', seg('/api/plans/summary')), { kind: '__method_not_allowed' });
    assert.deepEqual(matchRoute('POST', seg('/api/plan')), { kind: '__not_found' }, 'bare singular /api/plan is not a route');
  });

  test('plan detail accepts both singular and plural aliases', () => {
    assert.deepEqual(matchRoute('GET', seg(`/api/plan/${ID}`)), { kind: 'get_plan', planId: ID });
    assert.deepEqual(matchRoute('GET', seg(`/api/plans/${ID}`)), { kind: 'get_plan', planId: ID });
    assert.deepEqual(matchRoute('POST', seg(`/api/plan/${ID}`)), { kind: '__method_not_allowed' });
  });

  test('malformed plan id 404s rather than matching', () => {
    assert.deepEqual(matchRoute('GET', seg('/api/plan/not-a-uuid')), { kind: '__not_found' });
    assert.deepEqual(matchRoute('GET', seg('/api/plans/not-a-uuid')), { kind: '__not_found' });
  });

  test('mutation actions on both aliases', () => {
    for (const prefix of ['plan', 'plans']) {
      for (const action of ['approve-shape', 'create', 'reject', 'retry', 'cancel']) {
        assert.deepEqual(
          matchRoute('POST', seg(`/api/${prefix}/${ID}/${action}`)),
          { kind: action, planId: ID },
          `${prefix}/${action}`,
        );
        assert.deepEqual(
          matchRoute('GET', seg(`/api/${prefix}/${ID}/${action}`)),
          { kind: '__method_not_allowed' },
        );
      }
    }
  });

  test('unknown action segment 404s', () => {
    assert.deepEqual(matchRoute('POST', seg(`/api/plan/${ID}/nope`)), { kind: '__not_found' });
  });

  test('unrelated paths 404; page/asset paths route to the UI', () => {
    // `/` and the fixed page set now serve the SSR shell (UI added in this PR).
    assert.deepEqual(matchRoute('GET', seg('/')), { kind: 'page' });
    assert.deepEqual(matchRoute('GET', seg('/plans')), { kind: 'page' });
    assert.deepEqual(matchRoute('GET', seg('/settings')), { kind: 'page' });
    assert.deepEqual(matchRoute('GET', seg('/assets/app.css')), { kind: 'asset' });
    // Genuinely unrelated paths still 404.
    assert.deepEqual(matchRoute('GET', seg('/whatever')), { kind: '__not_found' });
    assert.deepEqual(matchRoute('GET', seg('/plans/not-a-uuid')), { kind: '__not_found' });
    assert.deepEqual(matchRoute('GET', seg('/api')), { kind: '__not_found' });
    assert.deepEqual(matchRoute('GET', seg('/api/unknown')), { kind: '__not_found' });
  });
});
