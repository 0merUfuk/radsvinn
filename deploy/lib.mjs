// deploy/lib.mjs — the credential-hygiene seam shared by the boot-time
// grounding sync (deploy/entrypoint.mjs) and fetch-before-plan's per-plan fetch
// (service/grounding.mjs). Zero dependencies. The token-masking and git-auth
// shapes exist ONCE, with
// their own unit tests (service/test/deploy-lib.test.mjs), instead of
// drifting apart as two inline copies.

// The deployed planner's four required physical grounding checkouts. An
// operator may extend this set through RADSVINN_GROUNDING_REPOS, but may never
// subtract it: a known repo disappearing from a legacy explicit env list would
// otherwise make plans look healthy while its read-only checkout is absent.
//
// `cross-repo-lockstep` is the fifth value accepted by the v0.1.0 plan/gate
// vocabulary, but it is a routing marker, not a GitHub repository. It must
// never become a clone target. Legacy env values that include it are accepted
// and filtered below so existing deployments keep booting safely.
export const DEFAULT_GROUNDING_REPOS = Object.freeze([
  'web-app',
  'api-service',
  'worker-service',
  'shared-lib',
]);

const GITHUB_REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PLAN_ONLY_ROUTING_MARKER = 'cross-repo-lockstep';

// This deliberately contains neither the invalid value nor any other process
// environment. The entrypoint logs it directly, so config errors are visible
// at boot without turning a malformed variable into an accidental log sink.
export const INVALID_GROUNDING_REPOS_MESSAGE = 'invalid RADSVINN_GROUNDING_REPOS configuration; expected comma-separated GitHub repository slugs';

// groundingRepos parses additive physical deployment extensions without
// leaving the entrypoint with a second required list. Defaults always come
// first; a Set keeps the order stable while de-duplicating values repeated by
// a legacy env list or an operator-supplied extension. The plan-only lockstep
// marker is deliberately ignored after validation for backward compatibility.
export function groundingRepos(raw) {
  if (raw === undefined) return [...DEFAULT_GROUNDING_REPOS];

  const extensions = String(raw).split(',').map((repo) => repo.trim());
  if (extensions.some((repo) => !GITHUB_REPO_SLUG.test(repo) || repo === '.' || repo === '..')) {
    throw new Error(INVALID_GROUNDING_REPOS_MESSAGE);
  }
  const physicalExtensions = extensions.filter((repo) => repo !== PLAN_ONLY_ROUTING_MARKER);
  return [...new Set([...DEFAULT_GROUNDING_REPOS, ...physicalExtensions])];
}

// resolveGroundingRepos is the entrypoint-facing boundary. Do not hand an
// untrusted environment value to boot code (which will later use path.join and
// fs.rmSync); collapse every malformed value to the generic, safe-to-log error.
export function resolveGroundingRepos(raw) {
  try {
    return { repos: groundingRepos(raw) };
  } catch {
    return { error: INVALID_GROUNDING_REPOS_MESSAGE };
  }
}

/**
 * Masks GitHub token material out of arbitrary text (git stderr, error
 * messages) before it is logged or stored on a plan record:
 *
 *   - any `x-access-token:<anything>@` credential-in-URL fragment, and
 *   - the literal token value itself (belt and suspenders — a future git
 *     version could print the credential in a shape the regex misses).
 *
 * Safe on undefined/empty input and with no token configured.
 */
export function scrub(text, token) {
  let out = String(text || '').replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
  if (token) out = out.split(token).join('***');
  return out;
}

/**
 * Per-invocation git auth via ENVIRONMENT-based config: returns the three
 * `GIT_CONFIG_*` variables that make git rewrite `https://github.com/...`
 * remotes to carry the token — spread them into a git child's env.
 *
 * Environment, NOT argv (`-c url....insteadOf=...`), deliberately: on the
 * shared container /proc/<pid>/cmdline is world-readable, so at plan time a
 * concurrent LLM child process could read a token passed on a sibling git
 * process's command line — a sibling's environment is not readable that
 * way. And nothing persists: the rewrite exists only for the one
 * invocation; the repo's stored `origin` URL stays clean, so the volume
 * never holds the credential (it outlives token rotation).
 *
 * No token → `{}` (spreading it is a no-op and git runs unauthenticated).
 */
export function gitAuthEnv(token) {
  if (!token) return {};
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  };
}
