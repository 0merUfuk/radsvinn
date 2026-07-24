import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyOrigin, verifyCsrfHeader, requiredConfirmString, verifyConfirmString, validateReturnTo,
} from '../lib/csrf.mjs';
import {
  computeRoles, enforceRole, hasRole, requiredRoleForKind, ROLE_FOR_KIND, FORCE_RECHECK_KINDS, MUTATION_KINDS,
} from '../lib/rbac.mjs';

const PUBLIC_ORIGIN = 'https://dash.test';

describe('lib/csrf', () => {
  test('verifyOrigin requires an exact match', () => {
    assert.equal(verifyOrigin({ headers: { origin: PUBLIC_ORIGIN } }, PUBLIC_ORIGIN), true);
    assert.equal(verifyOrigin({ headers: { origin: 'https://evil.test' } }, PUBLIC_ORIGIN), false);
    assert.equal(verifyOrigin({ headers: {} }, PUBLIC_ORIGIN), false, 'missing Origin must fail closed');
    assert.equal(verifyOrigin({ headers: { origin: '' } }, PUBLIC_ORIGIN), false);
  });

  test('verifyCsrfHeader compares against the session csrf_token', () => {
    const session = { csrf_token: 'tok-123' };
    assert.equal(verifyCsrfHeader({ headers: { 'x-mercury-csrf': 'tok-123' } }, session), true);
    assert.equal(verifyCsrfHeader({ headers: { 'x-mercury-csrf': 'wrong' } }, session), false);
    assert.equal(verifyCsrfHeader({ headers: {} }, session), false);
    assert.equal(verifyCsrfHeader({ headers: { 'x-mercury-csrf': 'tok-123' } }, undefined), false);
  });

  test('requiredConfirmString builds the exact create/cancel strings', () => {
    assert.equal(requiredConfirmString('create', '0d9c1234-aaaa-bbbb-cccc-000000000000'), 'create-jira-tree 0d9c1234');
    assert.equal(requiredConfirmString('cancel', '0d9c1234-aaaa-bbbb-cccc-000000000000'), 'cancel-jira-tree 0d9c1234');
    assert.equal(requiredConfirmString('reject', 'x'), null, 'reject has no confirm string');
  });

  test('verifyConfirmString requires an exact match', () => {
    const id = '0d9c1234-aaaa-bbbb-cccc-000000000000';
    assert.equal(verifyConfirmString('create', id, 'create-jira-tree 0d9c1234'), true);
    assert.equal(verifyConfirmString('create', id, 'create-jira-tree 0d9c123'), false);
    assert.equal(verifyConfirmString('create', id, undefined), false);
    assert.equal(verifyConfirmString('cancel', id, 'create-jira-tree 0d9c1234'), false, 'wrong verb must not pass');
  });

  test('validateReturnTo rejects protocol-relative and backslash tricks, requires same-origin', () => {
    assert.equal(validateReturnTo('/plans', PUBLIC_ORIGIN), '/plans');
    assert.equal(validateReturnTo('/plans?x=1#y', PUBLIC_ORIGIN), '/plans?x=1#y');
    assert.equal(validateReturnTo('//evil.test/x', PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo('/\\evil.test', PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo('https://evil.test/plans', PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo('javascript:alert(1)', PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo('plans', PUBLIC_ORIGIN), '/', 'must start with /');
    assert.equal(validateReturnTo('', PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo(undefined, PUBLIC_ORIGIN), '/');
    assert.equal(validateReturnTo('/a\\b', PUBLIC_ORIGIN), '/');
  });
});

const CONFIG = {
  teamPlanners: new Set(['mercury-planners']),
  teamApprovers: new Set(['mercury-approvers']),
  teamCreators: new Set(['mercury-creators']),
  roleBootstrapIds: new Set([999]),
  roleCacheTtlMs: 15 * 60 * 1000,
};

describe('lib/rbac computeRoles', () => {
  test('org member with no team gets only viewer', () => {
    assert.deepEqual(computeRoles({ teamSlugs: [], githubId: 1, config: CONFIG }), ['viewer']);
  });

  test('team membership adds exactly the mapped role', () => {
    assert.deepEqual(computeRoles({ teamSlugs: ['mercury-planners'], githubId: 1, config: CONFIG }), ['viewer', 'planner']);
  });

  test('creator does not imply approver and vice versa', () => {
    const roles = computeRoles({ teamSlugs: ['mercury-creators'], githubId: 1, config: CONFIG });
    assert.ok(roles.includes('creator'));
    assert.ok(!roles.includes('approver'));
  });

  test('bootstrap id grants approver+creator without any team', () => {
    const roles = computeRoles({ teamSlugs: [], githubId: 999, config: CONFIG });
    assert.deepEqual(new Set(roles), new Set(['viewer', 'approver', 'creator']));
  });

  test('bootstrap never substitutes for org membership (computeRoles is only reached post-membership-check)', () => {
    // computeRoles has no membership concept at all — this is a documentation
    // test asserting the function's contract, not a runtime check.
    const roles = computeRoles({ teamSlugs: [], githubId: 12345, config: CONFIG });
    assert.deepEqual(roles, ['viewer']);
  });
});

describe('lib/rbac route table', () => {
  test('every mutating kind requires a role; every read kind requires none', () => {
    for (const kind of Object.keys(ROLE_FOR_KIND)) {
      const required = requiredRoleForKind(kind);
      if (MUTATION_KINDS.has(kind)) assert.ok(required, `${kind} should require a role`);
      else assert.equal(required, null, `${kind} should be viewer-level`);
    }
  });

  test('hasRole', () => {
    assert.equal(hasRole(['viewer'], null), true);
    assert.equal(hasRole(['viewer'], 'planner'), false);
    assert.equal(hasRole(['viewer', 'planner'], 'planner'), true);
    assert.equal(hasRole(undefined, 'planner'), false);
  });

  test('FORCE_RECHECK_KINDS is exactly the three consequence-bearing gates', () => {
    assert.deepEqual([...FORCE_RECHECK_KINDS].sort(), ['approve-shape', 'cancel', 'create']);
  });
});

describe('lib/rbac enforceRole', () => {
  function session(overrides = {}) {
    return {
      github_id: 1, login: 'a', roles: ['viewer'], roles_verified_at: 1000, ...overrides,
    };
  }

  test('allows a read with no required role and no recheck when cache is fresh', async () => {
    let called = false;
    const result = await enforceRole({
      kind: 'get_plan', session: session(), config: CONFIG, now: 1000 + 60_000,
      recheckMembership: async () => { called = true; return { ok: true, teamSlugs: [] }; },
    });
    assert.equal(result.outcome, 'allow');
    assert.equal(called, false, 'a fresh cache must not trigger a recheck at all');
  });

  test('denies a mutation the session role does not have', async () => {
    const result = await enforceRole({
      kind: 'create_plan', session: session({ roles: ['viewer'] }), config: CONFIG, now: 1000 + 60_000,
      recheckMembership: async () => ({ ok: true, teamSlugs: [] }),
    });
    assert.equal(result.outcome, 'deny_role');
  });

  test('force-recheck kinds always call recheckMembership even with a fresh cache', async () => {
    let called = false;
    await enforceRole({
      kind: 'create', session: session({ roles: ['creator'] }), config: CONFIG, now: 1000 + 1,
      recheckMembership: async () => { called = true; return { ok: true, teamSlugs: ['mercury-creators'] }; },
    });
    assert.equal(called, true);
  });

  test('a stale cache triggers a recheck for a plain read too, but degrades to cached roles on transient failure', async () => {
    const staleNow = 1000 + CONFIG.roleCacheTtlMs + 1;
    let called = false;
    const result = await enforceRole({
      kind: 'get_plan', session: session({ roles: ['viewer'] }), config: CONFIG, now: staleNow,
      recheckMembership: async () => { called = true; return { ok: false, transient: true }; },
    });
    assert.equal(called, true);
    assert.equal(result.outcome, 'allow', 'reads ride the stale cache on a transient failure');
    assert.equal(result.rolesRefreshed, false);
  });

  test('a stale cache fails a MUTATION closed on transient failure (does not ride stale roles)', async () => {
    const staleNow = 1000 + CONFIG.roleCacheTtlMs + 1;
    const result = await enforceRole({
      kind: 'reject', session: session({ roles: ['planner'] }), config: CONFIG, now: staleNow,
      recheckMembership: async () => ({ ok: false, transient: true }),
    });
    assert.equal(result.outcome, 'deny_unavailable');
  });

  test('force-recheck kind fails closed (503-shaped) on transient GitHub failure, never falls back to cached roles', async () => {
    const result = await enforceRole({
      kind: 'create', session: session({ roles: ['creator'] }), config: CONFIG, now: 1000 + 1,
      recheckMembership: async () => ({ ok: false, transient: true }),
    });
    assert.equal(result.outcome, 'deny_unavailable');
  });

  test('a definitive membership loss denies regardless of force-recheck or staleness', async () => {
    const r1 = await enforceRole({
      kind: 'create', session: session({ roles: ['creator'] }), config: CONFIG, now: 1000 + 1,
      recheckMembership: async () => ({ ok: false, transient: false }),
    });
    assert.equal(r1.outcome, 'deny_membership');

    const staleNow = 1000 + CONFIG.roleCacheTtlMs + 1;
    const r2 = await enforceRole({
      kind: 'get_plan', session: session({ roles: ['viewer'] }), config: CONFIG, now: staleNow,
      recheckMembership: async () => ({ ok: false, transient: false }),
    });
    assert.equal(r2.outcome, 'deny_membership', 'even a READ must destroy the session on definitive membership loss');
  });

  test('a successful recheck refreshes roles and is reflected in the result', async () => {
    const result = await enforceRole({
      kind: 'create', session: session({ roles: ['viewer'] }), config: CONFIG, now: 1000 + 1,
      recheckMembership: async () => ({ ok: true, teamSlugs: ['mercury-creators'] }),
    });
    assert.equal(result.outcome, 'allow');
    assert.equal(result.rolesRefreshed, true);
    assert.ok(result.roles.includes('creator'));
  });
});
