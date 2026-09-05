# Radsvinn Operations

*Version 1.2 · 2026-07-24*

Commands and environment for running Radsvinn locally and in production. For the architecture
and safety model, see [docs/ARCHITECTURE.md](ARCHITECTURE.md). For the from-zero setup, see
[docs/GETTING-STARTED.md](GETTING-STARTED.md).

---

## Quick commands

```bash
# Demo the planner against the fake engine (zero keys; no app-level network calls,
# though a cold Go module cache may download dependencies)
make demo

# Run all tests (Go + service + dashboard)
make test

# Run the deterministic gate on the bundled skeleton fixture
make gate

# Full CI-style check: demo + tests + deterministic gate + public scan
make check

# Health collation (git status, HEAD, worktrees, Go build)
make status
```

---

## Environment variables

`RADSVINN_` is canonical; deprecated aliases and retained on-disk/wire contracts
are documented in [IDENTITY-MIGRATION.md](IDENTITY-MIGRATION.md).

### Planner service

| Variable | Purpose | Default / required |
|---|---|---|
| `RADSVINN_ENGINE` | Planner implementation selector: `fake` uses deterministic fixtures; every other value uses the real agent | real agent when unset; set `fake` for tests/demo |
| `RADSVINN_SKIP_PLAN_ANCHORS` | Skip the entire plan gate | unset for `make demo` and live use; `1` only for reduced direct-server tests without grounding checkouts |
| `RADSVINN_PORT` | HTTP listen port | `8090` |
| `RADSVINN_BIND` | HTTP bind address | `127.0.0.1` (loopback — the bridge is the only client) |
| `RADSVINN_SERVICE_TOKEN` | Bearer token between bridge and server | required for live; boot fails closed without it on non-loopback |
| `RADSVINN_SERVICE_TOKEN_DASHBOARD` | Separate bearer for the dashboard BFF | required if the dashboard is deployed |
| `RADSVINN_REQUIRE_AUTH` | Require a real token regardless of bind | baked `=1` in the container image |
| `RADSVINN_REQUIRE_ENV_ONLY_TOKEN` | Refuse to boot if the file-fallback Jira token exists | baked `=1` in the container image |
| `RADSVINN_LLM_PROVIDER` | Model provider used by the real agent: `anthropic` or `openrouter` | `anthropic` |
| `RADSVINN_AGENT_MODEL` / `_DECOMPOSE` / `_GROOM` | Per-seat Claude model | `opus` |
| `RADSVINN_AGENT_EFFORT` / `_DECOMPOSE` / `_GROOM` | Per-seat effort level | `xhigh` |
| `RADSVINN_PLAN_BUDGET_USD` | Per-plan spend cap | `10` |
| `RADSVINN_DAILY_SOFT_USD` | Daily soft cap (warns once per boot) | `50` |
| `RADSVINN_DAILY_HARD_USD` | Daily hard cap (blocks new LLM work) | `100` |
| `RADSVINN_RESULTS_DIR` | Plan state + spend ledgers root | `results` (container: `/data/results`) |
| `RADSVINN_REPOS_ROOT` | Grounding repos root | `../grounding` (container: `/data/repos`) |
| `RADSVINN_FETCH_BEFORE_PLAN` | fetch-before-plan: fetch + reset grounding repos before each plan | baked `=1` in the container |
| `RADSVINN_COUPLING_MAP` | Coupling-map path shared by planner prompt and plan gate | `coupling-map.yaml` |

### Tracker writer

| Variable | Purpose | Default / required |
|---|---|---|
| `RADSVINN_JIRA_TOKEN` | Jira API token — read by `tools/create-tree.mjs` only, stripped from the agent env | required for live; env-only on servers |
| `RADSVINN_JIRA_CLOUD_ID` | Atlassian Cloud ID — the tracker write target | required for live; **no baked default** |
| `RADSVINN_JIRA_PROJECT` | Jira project key | `PROJ` |
| `RADSVINN_JIRA_SITE_URL` | Jira site URL for browse links | placeholder fallback (`https://your-domain.atlassian.net`); set it for useful live links |

### Grounding

| Variable | Purpose | Default / required |
|---|---|---|
| `RADSVINN_GROUNDING_ORG` | GitHub org that owns the grounding repos | **required** — no baked default (a wrong default would clone a stranger's repos) |
| `RADSVINN_GROUNDING_REPOS` | Comma-separated additions to the four fixed physical seed repos | unset = four seed checkouts; an explicit empty/malformed value is rejected; additions cannot remove seeds. The plan-only `cross-repo-lockstep` routing marker is never cloned (legacy entries are ignored) |
| `GITHUB_TOKEN` | Read-only fetch credential for private grounding repos | required at runtime if repos are private; passed to git via env-based config, never argv |

### Slack bridge

| Variable | Purpose | Default / required |
|---|---|---|
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) — Socket Mode | required if the bridge is deployed |
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) — `chat:write`, `commands`, `files:write` | required if the bridge is deployed |
| `RADSVINN_SLACK_POLL_MS` | Bridge poll cadence for watched plans | `7000` |

### Dashboard BFF

| Variable | Purpose | Default / required |
|---|---|---|
| `RADSVINN_PLANNER_URL` | The planner service URL | required |
| `DASH_GITHUB_CLIENT_ID` / `_SECRET` | GitHub OAuth App credentials | required |
| `DASH_SESSION_SECRET` | Session HMAC secret (≥32 chars) | required |
| `DASH_PUBLIC_ORIGIN` | The dashboard's public HTTPS origin | required; must be `https://` in production |
| `DASH_GITHUB_ORG` | GitHub org whose membership authenticates users | required — deployment-specific |
| `DASH_TEAM_PLANNERS` / `_APPROVERS` / `_CREATORS` | GitHub team slugs → RBAC roles | `mercury-planners` / `mercury-approvers` / `mercury-creators` |
| `DASH_ROLE_BOOTSTRAP` | Numeric GitHub IDs to grant approver+creator ahead of team creation | optional |
| `DASH_MUTATIONS` | `0` disables all mutating routes (403) | unset = mutations live |

---

## Fake mode

`make demo` is the release-candidate walkthrough. It submits the sample ask over the real
loopback HTTP API, waits at both human gates, approves each one, runs both modes of the real Go
gate (including plan anchors against temporary local `origin/main` objects), and finishes with
the fake tracker writer. It exercises persistence, audit, and spend-breaker paths without model,
tracker, or remote-grounding calls.

```bash
make demo
```

For lower-level service development and tests, fake mode can also be selected directly:

```bash
RADSVINN_ENGINE=fake RADSVINN_SKIP_PLAN_ANCHORS=1 node service/server.mjs
RADSVINN_ENGINE=fake RADSVINN_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs
```

The direct server command skips the plan gate because it has no prepared grounding checkout;
it is not equivalent to the full `make demo` walkthrough.

---

## Container deployment (Railway)

One Docker image runs two supervised processes: the planner service
(`service/server.mjs`, bound to `127.0.0.1` — the bridge is its only client) and the Slack
Socket Mode bridge (`service/slack.mjs`, connecting **outbound** to Slack). There is **no
public ingress**: no Railway domain, no healthcheck path, no inbound port.

| Piece | Role |
|---|---|
| `Dockerfile` | Multi-stage build — static `treecheck` from Go, `node:22-slim` runtime with `git` + the `claude` CLI |
| `deploy/entrypoint.mjs` | First process — volume layout under `/data`, grounding-repo sync, hands off to the supervisor |
| `service/supervise.mjs` | Spawns server → waits for `/healthz` → spawns bridge; restarts crashed children with backoff; clean SIGTERM shutdown |
| `railway.json` | Dockerfile builder, `restartPolicyType: ON_FAILURE`, no healthcheck path (private bind) |

### Volume layout

The persistent volume at `/data` is **required** — the container dies at boot without it. The
entrypoint carves it into:

| Path | What lives here |
|---|---|
| `/data/results` | Plan state (one JSON per plan), spend ledgers, audit JSONL |
| `/data/home` | Becomes `$HOME` — the `claude` CLI session store persists here so `--resume` survives redeploys |
| `/data/repos` | Grounding checkouts (shallow, single-branch, full blobs) |

### Provisioning (Railway CLI)

```bash
# 0. one-time
railway login

# 1. create or link the project, from this repo's root
railway init          # new project — or: railway link

# 2. the persistent volume
railway volume add --mount-path /data

# 3. secrets — via STDIN, so no literal token enters shell history or ps output.
#    For each: paste the secret, press Enter, then Ctrl-D.
railway variable set ANTHROPIC_API_KEY --stdin
railway variable set SLACK_APP_TOKEN --stdin
railway variable set SLACK_BOT_TOKEN --stdin
railway variable set RADSVINN_JIRA_TOKEN --stdin
railway variable set RADSVINN_JIRA_CLOUD_ID --stdin
railway variable set RADSVINN_GROUNDING_ORG --stdin
railway variable set RADSVINN_GROUNDING_REPOS --stdin
railway variable set GITHUB_TOKEN --stdin

# 4. live target values — set these explicitly; do not rely on the example fallbacks.
railway variable set RADSVINN_JIRA_PROJECT --stdin
railway variable set RADSVINN_JIRA_SITE_URL --stdin

# the service bearer is generated, never typed:
openssl rand -hex 32 | railway variable set RADSVINN_SERVICE_TOKEN --stdin

# 5. build + deploy (uses railway.json → Dockerfile)
railway up
```

> **Do not** add a Railway domain or a healthcheck path to this service. The server binds
> `127.0.0.1` inside the container and `/healthz` is intentionally unreachable from outside.
> The bridge reaches Slack outbound; nothing needs to reach in.

The optional dashboard is the exception to that loopback-only recipe. If it runs as a separate
service, expose the planner only on the provider's private mesh: set planner `RADSVINN_BIND` to
a mesh-reachable bind address, keep the planner without a public domain, and point dashboard
`RADSVINN_PLANNER_URL` at the private service URL. Configure a bridge bearer in planner
`RADSVINN_SERVICE_TOKEN`, a different dashboard bearer in planner
`RADSVINN_SERVICE_TOKEN_DASHBOARD`, and give the dashboard that same second value as
`RADSVINN_SERVICE_TOKEN_DASHBOARD`. The two bearer values must be distinct so dashboard calls
receive dashboard actor and confirmation enforcement; the planner refuses to start when the
two configured values are identical.

### First-boot checklist

Watch `railway logs` for, in order:

1. `[radsvinn-entrypoint] volume ready: …` — `/data` is mounted and writable.
2. `[radsvinn-entrypoint] grounding repo <name>: cloned` — once per repo (first boot only;
   later boots log `fetched origin/main and reset the checkout to it`). A clone failure here
   is **fatal** — check `GITHUB_TOKEN` scope/expiry and `RADSVINN_GROUNDING_ORG`.
3. `[radsvinn-supervise] server started` then
   `[radsvinn-supervise] server healthy — starting bridge`.
4. `[radsvinn] planner service listening on http://127.0.0.1:8090 (engine=real)`.
5. `[radsvinn-slack] Socket Mode connection established`.
6. **`/plan` smoke**: run `/plan <a small task>` in the Slack channel → the wizard opens →
   submit → "Preparing…" appears → the proposed shape posts → **Reject** it (no real Jira
   write). Watch for the `⚠ grounding fetch failed` context warning — it should **not** be
   there on a healthy boot.

### Redeploy / rollback

- **Redeploy** (new code): `railway up` from the repo root. `/data` persists — plans, spend
  ledgers, `claude` sessions, and grounding repos survive. In-flight plans are honestly swept
  to `failed` (`error: "interrupted by restart"`) by crash-resume, and the bridge re-announces
  from the durable cursor.
- **Restart only** (same image): `railway redeploy`.
- **Rollback**: Railway dashboard → the service → *Deployments* → previous deployment →
  *Rollback*. The volume is not rolled back — plan state is forward-compatible by design.

### Logs

- Live tail: `railway logs`.
- Everything operational goes to **stderr** (`[radsvinn-entrypoint]`, `[radsvinn-supervise]`,
  `[radsvinn-slack]` prefixes); the server's listening line is stdout. Railway captures both
  container streams — nothing is written to log files.
- Wizard/language extraction, reconnects, poller warnings, surface-write refusals, and
  `[radsvinn] phase=…` timing lines are all stderr lines designed to make production incidents
  diagnosable from logs alone.

---

## Security posture

- **No public ingress.** The planner API binds `127.0.0.1`; no domain, no healthcheck, no
  exposed port. The Slack bridge connects outbound (Socket Mode). The only outbound
  destinations are Slack, the selected model provider, Jira, and GitHub (grounding fetches).
- **Fail-closed boot.** `RADSVINN_REQUIRE_AUTH=1` (baked in the image): a missing/empty
  `RADSVINN_SERVICE_TOKEN` is fatal before the server listens. `/healthz` stays open
  (unauthenticated) for the supervisor; every `/plan*` route requires the bearer.
- **Env-only credentials.** `RADSVINN_REQUIRE_ENV_ONLY_TOKEN=1` makes a file-fallback Jira
  token fatal at boot. `GITHUB_TOKEN` is passed to git via **environment-based config**
  (`GIT_CONFIG_*` — never argv, never persisted into `.git/config` on the volume); git error
  output is scrubbed of token material before logging.
- **Sandboxed agent.** The planning agent runs `--permission-mode default` with
  `Read,Grep,Glob` only, plus `--add-dir /data/repos`. `sandboxedEnv` copies the inherited
  environment and removes a deny-set of known-sensitive credentials: Slack tokens, both planner
  service bearers, the Jira token, `GITHUB_TOKEN`/`GH_TOKEN`, provider source keys, and `RAILWAY_*`.
  Other inherited variables remain; conversion to a strict keep-set is future hardening. The
  only step that writes to Jira is control-plane (`create-tree.mjs`) — no LLM touches it.
- **Budgets.** Daily soft/hard breakers run before every model call. The per-plan cap runs
  before every Groom call and, once spend exists, before Phase-1 regeneration. Create has no
  model call and deliberately has no spend check. The daily ledger lives on the volume and
  survives restarts; cost is tracked in integer nanodollars.

---

## Production deployment checklist

1. All required env vars set; `RADSVINN_ENGINE` is unset or a real-mode value, not `fake`.
   Choose Anthropic or OpenRouter separately with `RADSVINN_LLM_PROVIDER`.
2. `RADSVINN_JIRA_CLOUD_ID` and `RADSVINN_GROUNDING_ORG` set to **your** values — neither has a
   baked live default.
3. `RADSVINN_JIRA_PROJECT` and `RADSVINN_JIRA_SITE_URL` explicitly set to the real project and
   site. The source falls back to `PROJ` and an example placeholder site; those are local
   conveniences, not production configuration.
4. `coupling-map.yaml` loaded, populated, and versioned for your instance. An empty map is
   legal only as a degraded starting state and provides no coupling-zone enforcement.
5. Two human gates enabled in the planner (shape + create).
6. `go test ./...` and service/dashboard tests green (`make test`).
7. Slack bridge pointed at the correct workspace; dashboard BFF (if deployed) pointed at the
   correct GitHub org.
8. `RADSVINN_SKIP_PLAN_ANCHORS` is **unset** — production anchors must actually be checked.

---

## Readiness signals

- `GET /healthz` returns 200 with `version`, `engine`, `daily_spend_usd`, and
  `cost_telemetry_locked`. This is the supervisor's health probe and the only unauthenticated
  route.
- `[radsvinn] phase=…` stderr lines per completed planning call carry `model`, `grounding`,
  `turns`, `duration_ms`, `cost_usd` — the observability floor for cost/latency decisions.

---

## Emergency rollback

1. Re-deploy the previous container image (Railway dashboard → Deployments → Rollback).
2. If rolling back the LLM provider: set `RADSVINN_LLM_PROVIDER` to the previous value and
   `railway redeploy`.
3. **Do not delete Jira tickets** — transition them to `Cancelled` via the Slack Cancel button
   or `node tools/create-tree.mjs --cleanup <record> --live`. Cancel is a transition, never a
   delete.
4. In-flight plans caught mid-phase by the rollback are honestly swept to `failed`
  (`error: "interrupted by restart"`) on the next boot — no zombie workers.
