# Getting Started

This guide takes you from a clean clone to a verified Mercury demo, then explains the
v0.1.0 path for connecting a compatible organization. It has three stages:

1. **Run the demo** (zero config, five minutes) — prove the pipeline on your machine.
2. **Connect a compatible organization** — tracker, grounding repositories, model provider.
3. **Seed the coupling map** — the ground truth that makes Mercury coupling-aware.

Mercury's service boot fails closed for unsafe planner-API authentication and can enforce an
env-only Jira-token posture. The deterministic writer separately fails closed at its network
boundary when required live Jira credentials are missing, so an unconfigured instance cannot
write to anyone's tracker. Those guard rails are intentional.

Important v0.1.0 boundary: the demo is turnkey, but arbitrary organization vocabulary is not
yet runtime-configurable. The plan contracts and gate accept the fixed neutral seed repository
ids `web-app`, `api-service`, `worker-service`, and `shared-lib`, plus the
`cross-repo-lockstep` routing marker and coupling zones `none` and `shared-write`. R1/R2 will
derive those vocabularies from instance configuration. Until then, a live adopter must map
checkouts to the seed names or make a coordinated, instance-specific change across the
contracts, prompts, and gate.

Prerequisites: **Node 22+**, **Go 1.25+**, and **Git**. (Live mode also needs the agent CLI on
`PATH`.)

---

## Stage 1 — Run the demo (no keys or external services)

Mercury ships a deterministic **fake-mode demo** that replays known-good fixtures through the
production HTTP handlers and state machine. It exercises both real Go gates, both human
actions, persistence, and spend breakers. For anchor validation it creates temporary local Git
repositories with `origin/main` refs. The walkthrough itself opens only loopback HTTP and
makes no model, tracker, or remote-grounding calls. On a cold Go module cache, the Go toolchain
may download the repository's declared build dependencies before the checker starts.

```bash
make demo
```

The driver submits the sample ask over loopback HTTP, approves the shape, validates the
groomed plan against local `origin/main`, approves creation, and finishes with a fake tracker
result. It cleans up its temporary repositories after the run.

You can also run the gate directly:

```bash
go run ./cmd/treecheck -mode=skeleton < fixtures/e2e-sample/skeleton.json
```

---

## Stage 2 — Connect your organization

### 2a. Choose a model provider (bring your own key)

The default provider is Anthropic. Set your key in the environment:

```bash
export ANTHROPIC_API_KEY=...          # your key; never commit it
```

An opt-in metered provider path exists. Select it explicitly with
`MERCURY_LLM_PROVIDER=openrouter` and set `MERCURY_OPENROUTER_API_KEY`; setting the key alone
does not switch providers. A non-default provider should be calibrated (see the
[harness](../harness)) before you trust it on real plans.

### 2b. Point at your issue tracker (Jira Cloud)

For a real deployment, set all four values explicitly. The deterministic writer requires the
Cloud ID and token when it reaches a Jira network operation. The service itself may boot
without them because it never writes Jira; the project falls back to `PROJ` and the site URL
falls back to the placeholder shown below, neither of which is production configuration:

```bash
export MERCURY_JIRA_SITE_URL=https://your-domain.atlassian.net   # explicit live site; links: ${SITE}/browse
export MERCURY_JIRA_CLOUD_ID=<your-atlassian-cloud-id>           # REQUIRED, no default
export MERCURY_JIRA_PROJECT=PROJ                                 # explicit live project (PROJ is the fallback)
export MERCURY_JIRA_TOKEN=<jira-api-token>                       # required for network operations
```

Find your cloud ID at `https://<your-domain>.atlassian.net/_edgeProxy/tenantInfo` (or via the
Atlassian admin API). The Jira token is only used by the deterministic writer
(`tools/create-tree.mjs`); the planning agent never sees it. Keep it out of repo files and
chat.

### 2c. Point at your grounding repositories

Grounding is how Mercury verifies that a ticket's code anchors actually exist. In v0.1.0,
prepare read-only checkouts using the four fixed physical seed repository ids. The deployment
entrypoint uses the VCS org and clone list below; a local process reads the same names beneath
`MERCURY_REPOS_ROOT`. The plan/gate vocabulary also accepts `cross-repo-lockstep`, but that is
a human-routing marker, not a repository, and the deployment entrypoint never clones it
(legacy env entries containing it are ignored):

```bash
export MERCURY_GROUNDING_ORG=example-org
export MERCURY_GROUNDING_REPOS=web-app,api-service,worker-service,shared-lib
export MERCURY_REPOS_ROOT=../grounding        # where the checkouts live (container: /data/repos)
export GITHUB_TOKEN=<read-only-pat>           # to clone/fetch private repos
```

Anchors resolve against `origin/main` git objects, so **fetch before you plan** — the
single-container deploy does this automatically; locally, set `MERCURY_FETCH_BEFORE_PLAN=1` or
keep the checkouts current yourself.

### 2d. Boot live

```bash
export MERCURY_SERVICE_TOKEN=<random-bearer>   # every /plan* route now requires it
node service/server.mjs
```

Then drive it over HTTP exactly as in the demo (with `Authorization: Bearer <token>`), or wire
up the Slack bridge (below).

---

## Stage 3 — Provide your coupling map

The coupling map (`coupling-map.yaml`, or `MERCURY_COUPLING_MAP=<path>`) is the ground truth
that makes Mercury coupling-aware. It describes your system's hazards so the planner routes
around them and the gate can check that it did.

**An explicitly empty map is legal, but degraded.** With zero no-go zones, Mercury has no
coupling hazards to enforce; the gate cannot identify multi-writer risks or prove that a change
is safe. This is useful for initial local evaluation, but a human must review and populate the
map before trusting Mercury with live planning decisions.

```yaml
version: 1
no_go_zones: []      # legal degraded start: no coupling enforcement
```

**Populate the seed zone as you learn it.** A no-go zone marks a multi-writer hazard — for
example a column or table several services write, where an uncoordinated additive change is
unsafe. In v0.1.0 the only non-`none` plan value accepted by the contracts and gate is
`shared-write`:

```yaml
no_go_zones:
  - id: shared-write
    why: >
      The balance column is written by three services; an additive change here
      must land producer-before-consumer or it corrupts in-flight rows.
    members:
      - "shared-lib:db/models/account.ext"
```

Each `members` entry must be one `"repo:path"` string, not an anchor object. The path may
name a file or a directory prefix; the gate matches that exact path and its descendants on
path-segment boundaries. List every path that should force human routing.
Map entries may use only legal, non-`none` coupling-zone IDs. `none` is reserved for plan
items that do not declare a zone; it is not a valid `no_go_zones[].id`.

The gate reads zone *membership* from the map dynamically, but v0.1.0 does not derive the
legal repository and zone names from configuration. R1 adds the instance config spine; R2
uses it to de-freeze both vocabularies.

> Later, a guided generator will probe your repos for shared-write tables, cross-service calls,
> and hardcoded enums to propose candidate zones for you to ratify — see [ROADMAP.md](ROADMAP.md).
> Until then the map is hand-seeded from your own knowledge of the system.

---

## Environment reference

### Planner (`service/server.mjs`)

| Variable | Default | Meaning |
|---|---|---|
| `MERCURY_BIND` | `127.0.0.1` | Bind address (loopback in-container; the bridge is its only local client) |
| `MERCURY_PORT` | `8090` | Listen port |
| `MERCURY_ENGINE` | `real` | `fake` = deterministic fixture engine; anything else = the real agent |
| `MERCURY_SERVICE_TOKEN` | unset | If set, every `/plan*` route requires `Authorization: Bearer <token>`; `/healthz` stays open |
| `MERCURY_REQUIRE_AUTH` | unset | `1` makes a missing token FATAL at boot regardless of bind |
| `MERCURY_REQUIRE_ENV_ONLY_TOKEN` | unset | `1` makes a present local Jira-token file FATAL at boot (server posture) |
| `MERCURY_JIRA_SITE_URL` | `https://your-domain.atlassian.net` | Jira site for browse links; override the placeholder for live use |
| `MERCURY_JIRA_CLOUD_ID` | *(required, no default)* | Your Atlassian Cloud ID; Jira network operations fail clearly if unset |
| `MERCURY_JIRA_PROJECT` | `PROJ` | Jira project key the tree is created under |
| `MERCURY_JIRA_TOKEN` | *(env / secrets; local file fallback)* | Jira API token — required by and used only by the deterministic writer; use env-only posture on servers |
| `MERCURY_GROUNDING_ORG` | *(required, grounding)* | VCS org owning the grounding repos (example: `example-org`) |
| `MERCURY_GROUNDING_REPOS` | four physical seed repos | Additive physical clone list; the separate `cross-repo-lockstep` plan-routing marker is never cloned (legacy env entries are ignored) |
| `MERCURY_REPOS_ROOT` | *(local: a sibling dir)* | Where the grounding checkouts live; the container sets `/data/repos` |
| `MERCURY_FETCH_BEFORE_PLAN` | unset | `1` runs `git fetch origin main` in every grounding repo before Break-Down |
| `MERCURY_COUPLING_MAP` | `coupling-map.yaml` | Path to the coupling ground truth used by both Break-Down and the deterministic plan gate |
| `MERCURY_ENGINE` / `ANTHROPIC_API_KEY` | `real` / unset | Engine selector plus the default Anthropic-provider key; `MERCURY_ENGINE` does not select the LLM provider |
| `MERCURY_LLM_PROVIDER` / `MERCURY_OPENROUTER_API_KEY` | `anthropic` / unset | Provider selector plus OpenRouter key; the key alone does not switch providers |
| `MERCURY_AGENT_MODEL` / `MERCURY_AGENT_EFFORT` | `opus` / `xhigh` | Shared model/effort for both planning phases; `opus` is a floating CLI alias, not a pinned exact model ID |
| `MERCURY_AGENT_MODEL_DECOMPOSE` / `_GROOM` | unset | Per-seat model override (decompose may be cheaper; groom stays strongest) |
| `MERCURY_AGENT_PERMISSION_MODE` | `default` | Agent posture — keep `default` (the sandbox); do not weaken |
| `MERCURY_AGENT_ALLOWED_TOOLS` | `Read,Grep,Glob` | Agent tool allowlist — read-only; do not add `Bash`/`Write` |
| `MERCURY_LIGHT_MAX_TURNS` | `12` | `--max-turns` bound for light-grounding decompose calls |
| `MERCURY_PLAN_BUDGET_USD` | `10` | Per-plan spend cap; checked before every Groom call and before a paid Phase-1 regeneration, never Create |
| `MERCURY_DAILY_SOFT_USD` / `MERCURY_DAILY_HARD_USD` | `50` / `100` | Current UTC-day spend — warn / refuse; resets at UTC midnight |
| `MERCURY_RESULTS_DIR` | `results` | Where plan state + artifacts are written (gitignored) |
| `MERCURY_TREECHECK_BIN` | unset | Path to a prebuilt `treecheck`; falls back to `go run ./cmd/treecheck` |
| `MERCURY_SKIP_PLAN_ANCHORS` | unset | Keep unset for `make demo` and live use; `1` is only for reduced direct-server tests without grounding checkouts |

### Slack bridge (`service/slack.mjs`, optional)

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_APP_TOKEN` | *(required)* | App-level token `xapp-…` for `apps.connections.open` |
| `SLACK_BOT_TOKEN` | *(required)* | Bot token `xoxb-…` for posting/updating messages |
| `MERCURY_SERVICE_URL` | `http://127.0.0.1:8090` | Base URL of the planner service this bridge drives |
| `MERCURY_SERVICE_TOKEN` | unset | Match the planner's token so the bridge's calls are authorized |
| `MERCURY_SLACK_POLL_MS` | `7000` | How often the bridge polls each watched plan |

The bot token needs `chat:write`, `commands`, and `files:write` (the last for uploading the
full plan at the gate). The bridge connects **outbound** — no public URL or inbound ingress.

### Dashboard (`dashboard/server.mjs`, optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port (public container) |
| `MERCURY_PLANNER_URL` | *(required)* | Base URL of the planner over your private mesh |
| `MERCURY_SERVICE_TOKEN_DASHBOARD` | *(required)* | Bearer token to the planner (blank fails boot) |
| `DASH_GITHUB_CLIENT_ID` / `DASH_GITHUB_CLIENT_SECRET` | *(required)* | Your GitHub OAuth app |
| `DASH_SESSION_SECRET` | *(required, ≥32 chars)* | Session signing secret (`openssl rand -hex 32`) |
| `DASH_PUBLIC_ORIGIN` | *(required)* | The dashboard's public origin (must be `https://` in production) |
| `DASH_GITHUB_ORG` | *(required)* | GitHub org whose membership authenticates users (example: `example-org`) |
| `DASH_TEAM_PLANNERS` | `mercury-planners` | GitHub team slug → **planner** role |
| `DASH_TEAM_APPROVERS` | `mercury-approvers` | GitHub team slug → **approver** role |
| `DASH_TEAM_CREATORS` | `mercury-creators` | GitHub team slug → **creator** role |
| `DASH_ROLE_BOOTSTRAP` | unset | Comma-separated numeric GitHub user ids granted a bootstrap role |
| `DASH_MUTATIONS` | enabled | `0` = read-only surface; anything else = mutations live |

The team slugs default to Mercury-branded names — create those teams in your org, or point the
three `DASH_TEAM_*` vars at teams you already have.

---

## Secret hygiene

- **Never** put tokens (`MERCURY_JIRA_TOKEN`, `ANTHROPIC_API_KEY`, GitHub secrets, Slack
  tokens) in repo files, commits, or chat. Use the runtime environment or a secrets manager.
- On a server, the Jira credential must be **env-only**; a local convenience file is rejected
  at boot when `MERCURY_REQUIRE_ENV_ONLY_TOKEN=1` (set by the container).
- The service token gates the planner API; the dashboard uses its own distinct bearer to reach
  the planner. The planner refuses to start if both configured values are identical. Rotate
  them independently.

---

## Where to go next

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together and why it is safe.
- [ROADMAP.md](ROADMAP.md) — what is coming: reliability, adapters, the coupling-map generator.
- [service/README.md](../service/README.md) — the planner API in depth.
- [dashboard/README.md](../dashboard/README.md) — the web review surface.
