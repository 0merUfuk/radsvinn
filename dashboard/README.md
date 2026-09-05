# Radsvinn Dashboard — the web review surface

An optional public web surface for reviewing and approving Radsvinn plans, sitting in front of
the loopback-only planner API. It is a **backend-for-frontend (BFF)**: the browser only ever
talks to this server's same-origin `/api/*` surface; the planner's service token never reaches
the page. Authentication is **GitHub OAuth** scoped to your organization; authorization is
**role-based**, resolved from GitHub team membership.

Zero runtime npm dependencies — `node:http`, `node:crypto`, `node:fs` only, mirroring the
planner service's no-deps discipline. The client is a progressive-enhancement renderer built
from DOM text nodes (never `innerHTML`), so plan prose cannot inject markup.

For the whole system, see [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md); for setup, see
[../docs/GETTING-STARTED.md](../docs/GETTING-STARTED.md).

---

## What it does

The dashboard exposes the same two-gate plan lifecycle as the Slack bridge, over HTTP:

- **List and inspect plans** — the plan list, a plan's shape, its groomed tickets, gate
  results, and cost.
- **Act on a plan** through the two human gates — approve the shape, approve (create) the
  groomed tree, reject, retry a failed plan, and cancel a created tree.

Every mutating action is proxied to the planner only after it passes authentication, role
authorization, CSRF/Origin verification, rate limiting, and route-specific validation. A denied
request never reaches the planner.

---

## Request pipeline (every `/api/*` route)

The order is deliberate — each stage can reject before the next runs:

1. **Session** — the request must carry a valid signed session cookie (established by the
   GitHub OAuth login flow). No session → 401.
2. **RBAC** — the route's required role is checked against the session's roles, re-verifying org
   and team membership when the cached roles are stale or the route forces a fresh check. A role
   failure is a **403 with no upstream call** — the planner is never touched on a deny.
3. **CSRF / Origin** — mutations require a matching `Origin` and the `X-Mercury-CSRF` header;
   a mismatch is refused (and re-charged against the rate limit).
4. **Rate limiting** — per-session and per-IP token buckets. `POST /api/plans` (new plan — the
   route with LLM spend behind it) gets its own stricter per-session budget so it cannot be
   starved by, or starve, the lighter mutation routes.
5. **Route validation** — e.g. the create and cancel actions require a typed confirmation string
   that matches the plan id, so a destructive action can't be fired by a stray click.

Only then does the BFF call the planner over the private mesh with its service token.

---

## Roles

Roles are **server-side facts** resolved from GitHub org team membership at sign-in and
re-checked periodically — never a client-side switcher. Every active org member is at least a
`viewer`; higher roles come from team membership (and an optional numeric-id bootstrap
allowlist):

| Role | Granted by | Can |
|---|---|---|
| `viewer` | any active org member | read plans (the floor) |
| `planner` | `DASH_TEAM_PLANNERS` team | create a plan, reject, retry |
| `approver` | `DASH_TEAM_APPROVERS` team | approve the shape (gate 1) |
| `creator` | `DASH_TEAM_CREATORS` team | create the tree in the tracker (gate 2), cancel a tree |

`DASH_ROLE_BOOTSTRAP` (comma-separated numeric GitHub user ids) grants `approver` + `creator`
ahead of team resolution — useful for the first operator before the teams exist. Roles are
enforced by the route table on the server, not by a client flag, and the read-only role table is
shown in the Settings page.

---

## Configuration

Fail-closed boot: `dashboard/lib/config.mjs` reads every variable once at startup and
`validateConfig` refuses to boot on a missing or unsafe value. There are **no baked
organization defaults** — you supply your own GitHub org.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port (this is the public container) |
| `RADSVINN_PLANNER_URL` | *(required)* | Base URL of the planner over your private mesh |
| `RADSVINN_SERVICE_TOKEN_DASHBOARD` | *(required)* | Bearer token to the planner; a blank value fails boot (it cannot authenticate) |
| `DASH_GITHUB_CLIENT_ID` | *(required)* | Your GitHub OAuth app client id |
| `DASH_GITHUB_CLIENT_SECRET` | *(required)* | Your GitHub OAuth app client secret |
| `DASH_SESSION_SECRET` | *(required, ≥ 32 chars)* | Session signing secret — `openssl rand -hex 32` |
| `DASH_PUBLIC_ORIGIN` | *(required)* | The dashboard's public origin; must be `https://` when `NODE_ENV=production` |
| `DASH_GITHUB_ORG` | *(required)* | GitHub org whose membership authenticates users (example: `example-org`) |
| `DASH_TEAM_PLANNERS` | `mercury-planners` | GitHub team slug → **planner** role |
| `DASH_TEAM_APPROVERS` | `mercury-approvers` | GitHub team slug → **approver** role |
| `DASH_TEAM_CREATORS` | `mercury-creators` | GitHub team slug → **creator** role |
| `DASH_ROLE_BOOTSTRAP` | unset | Comma-separated numeric GitHub user ids granted `approver` + `creator` |
| `DASH_MUTATIONS` | enabled | `0` is the only disabling value (read-only surface); anything else keeps mutations live |
| `DASH_GITHUB_API_BASE` | `https://api.github.com` | Test seam — point outbound GitHub API calls at a fake in tests; never an auth bypass |
| `DASH_GITHUB_OAUTH_BASE` | `https://github.com` | Test seam — the OAuth authorize/token host |
| `NODE_ENV` | `production` | `production` enforces the `https://` origin rule |

The three `DASH_TEAM_*` slugs retain legacy team names for authorization compatibility — create those teams in your
org, or point the variables at teams you already have. The GitHub OAuth app's callback URL must
be `${DASH_PUBLIC_ORIGIN}` + the OAuth callback path.

---

## Boot

```bash
# with the planner reachable at RADSVINN_PLANNER_URL over the private mesh
node dashboard/server.mjs
# validateConfig prints every missing/unsafe var and exits non-zero if any remain
```

`dashboard/dev-boot.mjs` is a convenience wrapper for local development. In production the
dashboard runs as its own container (its own `Dockerfile`); when deploying from a monorepo, set
the platform's root/working directory to `dashboard/`.

---

## State and scaling

Sessions and rate-limit buckets are **in-memory** — so the dashboard must run as a **single
replica** (`numReplicas: 1`). A durable session/rate store (and horizontal scale) is a future
step, tracked in [../docs/ROADMAP.md](../docs/ROADMAP.md). The planner behind it holds all plan
state; the dashboard keeps nothing durable of its own.

---

## Security posture

- **The planner token never reaches the browser.** The BFF holds it and makes the upstream call
  server-side; the client only sees the same-origin `/api/*` surface.
- **Roles are enforced by the route table**, re-checked against live GitHub membership on a TTL
  (and forced fresh on the sensitive routes) — not by any client-supplied flag. Turning off the
  `DASH_MUTATIONS` flag is defense-in-depth on top of RBAC, not a substitute for it.
- **CSRF + Origin** are verified on every mutation; the confirm-string routes (create, cancel)
  additionally require the operator to type the plan id.
- **Security headers** and a bundle **secret-scan** (a CI check that no secret is inlined into
  the served client bundle) harden the served surface.
- **The client renderer is XSS-safe by construction** — it builds the DOM from text nodes, so
  untrusted plan prose is always rendered as text, never markup.

---

## Testing

The dashboard suite runs entirely offline against fakes — a fake GitHub (OAuth + org/team
membership) and a fake planner — so no real OAuth app, org, or planner is needed:

```bash
node --test dashboard/test/*.test.mjs
```

`dashboard/test/config.test.mjs` covers env parsing + fail-closed validation;
`dashboard/test/server-e2e.test.mjs` drives the full request pipeline (session → RBAC →
CSRF/rate-limit → route validation → proxied planner call) against the fakes; helper fakes live
in `dashboard/test/helpers.mjs`.
