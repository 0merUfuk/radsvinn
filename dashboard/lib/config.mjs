import { readEnv } from './env.mjs';
// lib/config.mjs — env parsing + boot validation for the dashboard BFF.
//
// House pattern (mirrors service/server.mjs's fail-closed boot gate): all env
// reads happen ONCE, synchronously, at boot into a plain object; nothing
// downstream re-reads process.env directly. Tests build a config object by
// hand (or via loadConfig(fakeEnv)) instead of mutating the real env.
//
// The public deployment contract is documented in docs/OPERATIONS.md.

const TRUE_STRINGS = new Set(['1', 'true', 'yes', 'on']);

function trimmed(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseNumericIdList(raw) {
  const out = new Set();
  for (const part of trimmed(raw).split(',')) {
    const p = part.trim();
    if (p.length === 0) continue;
    if (!/^\d+$/.test(p)) continue; // silently drop junk — logged as a validation problem below
    out.add(Number(p));
  }
  return out;
}

function csvSet(raw) {
  const out = new Set();
  for (const part of trimmed(raw).split(',')) {
    const p = part.trim();
    if (p.length > 0) out.add(p);
  }
  return out;
}

// The dashboard token value is trimmed; empty/whitespace means not configured
// at the planner's second bearer arm.
// For the dashboard itself the same token IS its only credential to the
// planner, so a blank value must fail the boot closed rather than silently
// disable auth to an internal-only service.
export function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.PORT) || 8080,
    version: trimmed(env.npm_package_version) || '0.1.0',

    plannerUrl: trimmed(readEnv('RADSVINN_PLANNER_URL', env)),
    plannerToken: trimmed(readEnv('RADSVINN_SERVICE_TOKEN_DASHBOARD', env)),

    githubClientId: trimmed(env.DASH_GITHUB_CLIENT_ID),
    githubClientSecret: trimmed(env.DASH_GITHUB_CLIENT_SECRET),
    sessionSecret: trimmed(env.DASH_SESSION_SECRET),
    publicOrigin: trimmed(env.DASH_PUBLIC_ORIGIN).replace(/\/+$/, ''),
    // No baked-in org default — the GitHub org whose membership authenticates
    // users is deployment-specific and REQUIRED (validateConfig flags a blank
    // value). An accidental default would silently gate a stranger's dashboard
    // against the wrong org.
    githubOrg: trimmed(env.DASH_GITHUB_ORG),

    teamPlanners: csvSet(env.DASH_TEAM_PLANNERS || 'mercury-planners'),
    teamApprovers: csvSet(env.DASH_TEAM_APPROVERS || 'mercury-approvers'),
    teamCreators: csvSet(env.DASH_TEAM_CREATORS || 'mercury-creators'),
    roleBootstrapIds: parseNumericIdList(env.DASH_ROLE_BOOTSTRAP),
    roleBootstrapRaw: trimmed(env.DASH_ROLE_BOOTSTRAP),

    // DASH_MUTATIONS=0 is the only disabling value; unset/anything-else
    // means mutations are live. The runbook flips this explicitly either way.
    mutationsEnabled: trimmed(env.DASH_MUTATIONS) !== '0',

    // Test seam only — never an auth bypass; it lets
    // tests point outbound GitHub calls at a local fake server.
    githubApiBase: trimmed(env.DASH_GITHUB_API_BASE) || 'https://api.github.com',
    githubOauthBase: trimmed(env.DASH_GITHUB_OAUTH_BASE) || 'https://github.com',

    nodeEnv: trimmed(env.NODE_ENV) || 'production',
  };
  return cfg;
}

// Returns an array of human-readable fatal problems; empty = safe to boot.
// Kept separate from loadConfig so tests can construct a partial config
// without tripping process.exit — only the real boot path in server.mjs
// calls this and exits on a non-empty result.
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.plannerUrl) problems.push('RADSVINN_PLANNER_URL is required');
  if (!cfg.plannerToken) problems.push('RADSVINN_SERVICE_TOKEN_DASHBOARD is required (blank/missing cannot authenticate to the planner)');
  if (!cfg.githubClientId) problems.push('DASH_GITHUB_CLIENT_ID is required');
  if (!cfg.githubClientSecret) problems.push('DASH_GITHUB_CLIENT_SECRET is required');
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
    problems.push('DASH_SESSION_SECRET is required and must be >= 32 characters (openssl rand -hex 32)');
  }
  if (!cfg.publicOrigin) problems.push('DASH_PUBLIC_ORIGIN is required');
  else {
    try {
      const u = new URL(cfg.publicOrigin);
      if (u.protocol !== 'https:' && cfg.nodeEnv === 'production') {
        problems.push('DASH_PUBLIC_ORIGIN must be https:// in production');
      }
    } catch {
      problems.push('DASH_PUBLIC_ORIGIN must be a valid absolute URL');
    }
  }
  if (!cfg.githubOrg) problems.push('DASH_GITHUB_ORG is required');
  if (cfg.roleBootstrapRaw && cfg.roleBootstrapIds.size === 0) {
    problems.push('DASH_ROLE_BOOTSTRAP is set but contains no valid numeric GitHub ids');
  }
  return problems;
}

export function isTrue(v) {
  return TRUE_STRINGS.has(trimmed(v).toLowerCase());
}
