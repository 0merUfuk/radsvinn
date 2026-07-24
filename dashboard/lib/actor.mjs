// lib/actor.mjs — builds the `actor` object forwarded to the planner on
// every mutation (§5.2's canonical schema). Constructed EXCLUSIVELY from the
// server-side session record — never from any request field, header, or
// cookie the browser controls (§5.2, §7.1's "New plan" requester row).

const MAX_ID_CHARS = 128;
const MAX_DISPLAY_CHARS = 256;
const MAX_ROLES = 16;

export function buildActor(session) {
  const id = `gh:${session.login}`.slice(0, MAX_ID_CHARS);
  const display = session.display ? String(session.display).slice(0, MAX_DISPLAY_CHARS) : undefined;
  const roles = Array.isArray(session.roles) ? session.roles.slice(0, MAX_ROLES) : [];
  const actor = {
    source: 'dashboard',
    id,
    roles,
  };
  if (typeof session.github_id === 'number') actor.github_id = session.github_id;
  if (display) actor.display = display;
  return actor;
}

// The stable identity key used for the §4.2 cross-requester Reject
// confirmation and the registry's `Mine` chip — matches what buildActor's
// requester_id stamping uses at plan-creation time (lib/rbac / server.mjs).
export function requesterIdentity(session) {
  return session.login;
}
