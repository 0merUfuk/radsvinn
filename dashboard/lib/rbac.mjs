// lib/rbac.mjs — role capability sets (§4.1/§4.2) and the enforcement
// pipeline (§4.3): session lookup -> route->role check -> 403 with NO
// upstream call on deny; role-cache TTL handling; forced fresh re-check on
// the three consequence-bearing gates.

export const ROLES = Object.freeze(['viewer', 'planner', 'approver', 'creator']);

// Route "kind" -> required role. `null` means any authenticated session
// (viewer floor) may call it. This table — not the UI — is the control
// (§4.2/§4.3 point 1).
export const ROLE_FOR_KIND = Object.freeze({
  get_session: null,
  list_plans: null,
  plans_summary: null,
  get_plan: null,
  get_health: null,
  get_audit: null,

  create_plan: 'planner',
  reject: 'planner',
  retry: 'planner',
  'approve-shape': 'approver',
  create: 'creator',
  cancel: 'creator',
});

// §4.3 point 3 — regardless of cache age, these three synchronously
// re-verify org + team membership before the planner is ever called.
export const FORCE_RECHECK_KINDS = new Set(['approve-shape', 'create', 'cancel']);

// Every route that mutates planner state (used for the §3.4 rate-limit
// category split and the §4.3 point 2 "mutations fail closed on a stale
// cache" rule — a strict superset of FORCE_RECHECK_KINDS).
export const MUTATION_KINDS = new Set(['create_plan', 'reject', 'retry', 'approve-shape', 'create', 'cancel']);

export function requiredRoleForKind(kind) {
  return Object.prototype.hasOwnProperty.call(ROLE_FOR_KIND, kind) ? ROLE_FOR_KIND[kind] : undefined;
}

export function hasRole(roles, required) {
  if (!required) return true;
  return Array.isArray(roles) && roles.includes(required);
}

// §4.1 team -> role mapping. `viewer` is the floor for every active org
// member reaching this function at all (org membership itself is checked
// before roles are ever computed — see oauth.mjs's login flow).
export function computeRoles({ teamSlugs, githubId, config }) {
  const roles = new Set(['viewer']);
  const slugs = new Set(teamSlugs || []);
  if ([...config.teamPlanners].some((t) => slugs.has(t))) roles.add('planner');
  if ([...config.teamApprovers].some((t) => slugs.has(t))) roles.add('approver');
  if ([...config.teamCreators].some((t) => slugs.has(t))) roles.add('creator');
  // §2.4/§4.1 bootstrap: numeric-id allowlist granted approver+creator ahead
  // of team creation. Never bypasses the org-membership check itself — this
  // function is only reached once that has already passed.
  if (config.roleBootstrapIds && config.roleBootstrapIds.has(githubId)) {
    roles.add('approver');
    roles.add('creator');
  }
  return [...roles];
}

// The §4.3 orchestration. `recheckMembership` is injected (real
// implementation in server.mjs wires lib/oauth.mjs against the fake-or-real
// GitHub API) so this module stays pure/testable: it returns one of
//   { ok: true, teamSlugs }
//   { ok: false, transient: false }   -- definitive deny (org lost / revoked)
//   { ok: false, transient: true }    -- GitHub unreachable / errored
//
// Returns:
//   { outcome: 'allow', roles, rolesRefreshed }
//   { outcome: 'deny_role', roles, rolesRefreshed } -- 403, session survives
//   { outcome: 'deny_membership' }                  -- 401, session destroyed
//   { outcome: 'deny_unavailable' }                 -- 503, session survives
//
// `rolesRefreshed: true` tells the caller to persist `roles` +
// `roles_verified_at = now` on the session (lib/sessions.mjs
// `updateRoles`) — kept out of this function so it stays a pure decision
// (no store dependency), easing unit testing.
export async function enforceRole({ kind, session, config, now, recheckMembership }) {
  const required = requiredRoleForKind(kind);
  const forceFresh = FORCE_RECHECK_KINDS.has(kind);
  const isMutation = MUTATION_KINDS.has(kind);
  const stale = now - session.roles_verified_at > (config.roleCacheTtlMs ?? 15 * 60 * 1000);

  let roles = session.roles;
  let rolesRefreshed = false;

  if (forceFresh || stale) {
    const result = await recheckMembership(session);
    if (result.ok) {
      roles = computeRoles({ teamSlugs: result.teamSlugs, githubId: session.github_id, config });
      rolesRefreshed = true;
    } else if (!result.transient) {
      // Definitive deny: org membership gone / token revoked. Applies to
      // both the force-fresh gates and a stale-cache recheck alike.
      return { outcome: 'deny_membership' };
    } else {
      // Transient GitHub failure. [RESOLUTION] §4.3 point 2: reads may ride
      // the cache; mutations (incl. the three force-fresh gates, which are
      // themselves always mutations) fail closed until a recheck succeeds.
      if (forceFresh || isMutation) {
        return { outcome: 'deny_unavailable' };
      }
      roles = session.roles; // stale-but-accepted for a read
    }
  }

  if (!hasRole(roles, required)) {
    return { outcome: 'deny_role', roles, rolesRefreshed };
  }
  return { outcome: 'allow', roles, rolesRefreshed };
}
