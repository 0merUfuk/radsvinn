# Service: Dashboard

| Field | Value |
|---|---|
| Path | `dashboard/` |
| Language | Node.js |
| Status | DEV |
| Interfaces | BFF over planner API, GitHub OAuth |
| Next steps | Prove with real OAuth + real Jira before promoting |

## Context

Standalone BFF + browser UI. Read-only-first rollout, then one real Create-in-Jira with human gate.

## Known issues

- `bootShell()` needs explicit error state on non-200/non-401.
- Cross-tenant identity leak fixed in generalized seed; verify on deployment.
