# Radsvinn — Architecture

This document describes how Radsvinn is built: its components, process topology, data flow,
stores, and the safety spine that lets an LLM-driven planner be trusted with real work. It
is written for someone standing Radsvinn up against **their own** organization.

For setup, see [GETTING-STARTED.md](GETTING-STARTED.md). For the product overview, see the
[top-level README](../README.md).

---

## 1. What Radsvinn is

Radsvinn is a **planner**: it turns a plain-language work request into a coupling-aware
ticket tree. The product is one LLM planning agent wrapped in a **deterministic control
plane** — the LLM proposes structure and content; a compiled Go gate validates it; a no-LLM
tool writes the tracker. On a first-pass success, two human approve-gates bracket two LLM
planning phases; bounded gate-driven regeneration can add model calls.

The design principle: **every place trust matters is code or a human, never a model.**

---

## 2. Runtime & build

- **Node 22 (ESM)** for `service/`, `dashboard/`, and `harness/`. **Go 1.25** for
  `internal/checks/` + `cmd/treecheck` (the deterministic gate, compiled to a static binary).
- **Zero runtime npm dependencies** in `service/` and `dashboard/` by design — they use only
  the Node standard library (`node:http`, `node:crypto`, `node:test`, `node:fs`). The
  `harness/` (calibration instrument) has dev dependencies.
- **Two container images:** a root `Dockerfile` (multi-stage — Go builds `treecheck`, then a
  Node runtime with `git` and the pinned agent CLI; the entrypoint is the planner supervisor)
  and a `dashboard/Dockerfile` (single-stage Node).

---

The real engine selects `claude` (default) or `codex` with `RADSVINN_AGENT_RUNTIME`.
Both adapters use the shared orchestration, gates, and human approvals. Adapter tests
use synthetic events; they do not establish full live Codex plan validity. Provider
selection and the metering proxy apply to Claude; Codex owns its provider path and
reports unavailable currency telemetry as unknown.

## 3. Process topology

**Planner (one container):**

```
deploy/entrypoint.mjs            volume layout (/data), grounding-repo clone/fetch/reset
        │
        ▼
service/supervise.mjs            spawns the server, polls /healthz once, spawns the bridge;
        │                        restart backoff; crash-loop → fatal exit
        ├──────────────▶ service/server.mjs   planner HTTP API — binds 127.0.0.1,
        │                                       NO public ingress
        └──────────────▶ service/slack.mjs    Slack Socket-Mode bridge — OUTBOUND only,
                                                no inbound URL
```

**Dashboard (optional, deployed separately):**

```
dashboard/server.mjs   public GitHub-OAuth BFF
        │
        ▼
planner over the private mesh (the planner must bind a mesh-reachable address)
```

The planner API is never publicly exposed. Its only clients are the Slack bridge (same
container) and, optionally, the dashboard (over a private network). Both are thin clients
over the same HTTP contract.

---

## 4. Components

| Area | Role |
|---|---|
| `service/` (planner) | `server.mjs` — the state machine + fire-and-forget workers + HTTP surface; `engine.mjs` — the agent (`claude -p`) invocation and optional metered-provider integration; `breakers.mjs` — spend caps + durable telemetry lock; `state.mjs` — the file-backed plan store with synchronous compare-and-swap; `gates.mjs` — spawns `treecheck`; `grounding.mjs` — git fetch + anchor resolution; `slack.mjs` + `slack-blocks.mjs` — the bridge + Block Kit; `audit.mjs` — an append-only actor ledger; `supervise.mjs`. |
| `internal/checks/` + `cmd/treecheck/` (Go) | The deterministic structural / hierarchy / ordering / sizing / **coupling-zone** / anchor-existence gate. The only compiled component; logic in Go, tunables in `internal/checks/thresholds.yaml`. |
| `tools/create-tree.mjs` | The **only** tracker writer — deterministic, no LLM. Jira Cloud REST; cancel = transition, never delete. |
| `dashboard/` | GitHub-OAuth BFF (`lib/{oauth,sessions,csrf,rbac,ratelimit,actor,planner-client,pages,config,router}`) + a text-node-only client renderer. |
| `harness/` | The calibration instrument (`run-calibration`, `render-sheet`, `score-agreement`): judge ≠ generator, blind labeling, agreement statistics. Disposable — it measures the planner, it is not part of the runtime. |
| `prompts/*.md` | The `decomposer` / `groomer` / `judge-tree` / `judge-ticket` payloads — verbatim model prompts (no doc frontmatter by design). |
| `contracts/*.json` | `skeleton.schema.json`, `plan.schema.json` — strict, unknown fields disallowed. |
| `coupling-map.yaml` | The coupling **ground truth** for this instance — the multi-writer no-go zones, cross-service sync edges, and tier flags the planner routes around. |

---

## 5. Data flow (one plan)

```
POST /plan  (or the Slack /plan modal wizard)
  │
  ▼ breaking_down
  │   engine.phase1: fresh agent session, coupling map injected into the prompt,
  │                  reads/greps the grounding repos → skeleton.json
  ▼
treecheck  -mode=skeleton   (deterministic structural gate)
  │
  ▼ shape_ready
  │   ── HUMAN GATE 1: approve / edit / reject the shape ──
  ▼ grooming
  │   engine.groom: --resume the same session → plan.json (the 5 fields per leaf)
  ▼
treecheck  -mode=plan   (fields, single-repo, anchors resolve against fresh
  │                       origin/main git objects, coupling-zone routing, sizing)
  ▼ plan_ready  (+ advisory duplicate search)
  │   ── HUMAN GATE 2: approve the groomed tree ──
  ▼ creating
  │   tools/create-tree.mjs --live   (deterministic tracker writes; then --verify)
  ▼ created
```

Properties that make this safe:

- **Two agent phases on a first-pass success** — a fresh session for Break-Down, one resume for
  Groom. Bounded gate-driven regeneration may add calls; the create step never touches an LLM.
- **Request-driven transitions use a synchronous compare-and-swap** — racing requests cannot
  double-fire a phase or resurrect a rejected plan. Workers persist their own progress and
  terminal state updates.
- **Gate failures trigger bounded regeneration** against the deterministic complaint (rather
  than shipping a bad tree), then escalate.
- **Spend breakers bound model work** — daily soft/hard checks run before every model call;
  the per-plan cap runs before every Groom call and, after spend exists, before Phase-1
  regeneration. Create has no model call and no spend check.
- **Cancel/retry are guarded** — retry resumes at the phase that failed and never re-creates
  an already-written tree; cancel transitions every issue to a terminal state, never deletes.

---

## 6. External integrations

Each of these is *one choice*, wired behind the service — not a hard requirement of the core:

- **Chat surface — Slack.** Socket Mode (an outbound WebSocket; no inbound URL), posting and
  updating messages and uploading the full plan as a file at the gate.
- **Model provider — the agent runtime.** The default is Anthropic (bring your own key). An
  opt-in metered provider path exists behind a loopback proxy, selected explicitly with
  `RADSVINN_LLM_PROVIDER=openrouter`; setting its key alone does not switch providers. A
  non-default provider must be calibrated before it is trusted on the shipped path.
- **Issue tracker — Jira Cloud REST**, via `tools/create-tree.mjs` only (create / link /
  comment / verify / cleanup). The tracker target (site, cloud ID, project) is configuration.
- **VCS grounding — Git remotes** (read-only). Grounding repos are cloned/fetched and anchors
  are resolved against `origin/main` objects.
- **Dashboard auth — GitHub OAuth** (org-membership + team → role).

---

## 7. Data stores

Radsvinn is **file-based** on a persistent volume (no SQL in this iteration):

- `results/service/plans/<id>.json` — plan state, written atomically (tmp + rename).
- `daily-spend-<date>.json` — the rolling daily breaker total.
- `audit/<date>.jsonl` — the append-only actor ledger.
- `agent/svc-<id>/` — per-plan artifacts (`skeleton.json`, `plan.json`, the created record).
- The agent session store (so a resume survives a redeploy).
- The grounding clones (`repos/<repo>`).

**In memory:** a plan `Map` (rebuilt from the plan files on boot), the spend mutex, and the
telemetry lock. On boot, any plan caught mid-phase when the process died reloads as `failed`
("interrupted by restart") — no zombie workers, no silent resume of a call that never
finished.

A relational store (for horizontal scale and true multi-tenancy) is a deliberate future
step, not a current dependency — see [ROADMAP.md](ROADMAP.md).

---

## 8. Configuration & secrets

Config is **env-var driven**. Service boot fails closed for unsafe planner-API authentication
and, when enabled, a local Jira-token fallback on a server. Tracker credentials and targets
are instead validated by the deterministic writer at its network-operation boundary: Cloud ID
and token are required for live operations, while `PROJ` and
`https://your-domain.atlassian.net` are clearly-example project/site fallbacks that production
deployments must override. There are no baked source-organization targets.

- **Planner:** the model provider key, the tracker target (`RADSVINN_JIRA_SITE_URL`,
  `RADSVINN_JIRA_CLOUD_ID`, `RADSVINN_JIRA_PROJECT`), the Jira token, the grounding source
  (`RADSVINN_GROUNDING_ORG`, additive `RADSVINN_GROUNDING_REPOS` extensions, the repos root), the
  coupling-map path, spend caps, the bind/port, the agent model/effort seats, and the service
  token.
- **Dashboard:** the GitHub OAuth app, the session secret, the public origin, the GitHub org
  and the team → role slugs, and its distinct dashboard bearer to the planner.

**Secrets never live in repo files.** Tokens come from the runtime environment (or, for local
convenience only, an operator file outside the repo). On a server the Jira credential must be
env-only; `RADSVINN_REQUIRE_ENV_ONLY_TOKEN=1` enforces that file-fallback posture at boot. The
writer fails closed on missing live credentials when it reaches a Jira network operation. The
full tables are in [GETTING-STARTED.md](GETTING-STARTED.md).

---

## 9. The coupling map — the instance's ground truth

The coupling map (`coupling-map.yaml`, path overridable via `RADSVINN_COUPLING_MAP`) is where
Radsvinn's real domain value lives. It is a hand-seeded (later, generated) description of your
system's hazards:

- **No-go zones** — multi-writer hazard areas (for example, a `shared-write` zone: a column
  or table several services write, where an uncoordinated additive change is unsafe). Each
  zone lists concrete file anchors and a `why`.
- **Sync edges** — cross-service ordering constraints (a producer that must ship before its
  consumer; a migration before its reader).
- **Tier flags** — hints about how tightly coupled a change class is.

The Go gate reads zone *membership* dynamically from this map and checks that the planner
routed the work correctly. An **empty map is legal but degraded** — with zero declared zones,
the gate has no coupling knowledge to enforce. A new organization can use that state to
exercise the planner, but must populate and maintain the map before relying on coupling-aware
routing.

In v0.1.0, however, the accepted repo and zone vocabulary is still the fixed neutral seed:
`web-app`, `api-service`, `worker-service`, and `shared-lib` are repository ids;
`cross-repo-lockstep` is the routing marker for work that must stay as one human-owned item;
and `none` / `shared-write` are the zones. The JSON schemas, Go contract enums, and threshold
config enforce that vocabulary. Deriving it from an instance profile and coupling map is
future R1/R2 work, not current behavior.

---

## 10. Tests, CI, and observability

- **CI** runs the Go checks, the harness tests, the service tests (against the fake engine),
  the dashboard tests (against fake GitHub + fake planner, with a bundle secret-scan), and an
  offline dry-run surface check. The real agent, real tracker, metered provider, the live
  Slack socket, and dashboard OAuth are exercised by opt-in / live checks, not the default CI.
- **Observability** is structured stderr today (`[radsvinn] phase=… cost_usd=…` lines);
  `/healthz` is loopback/mesh-only. A metrics/alerting floor is on the roadmap.
- **Rollback** is redeploy-the-previous-image; the persistent volume carries state across
  deploys.

---

## 11. Deployment shape

The whole planner runs as **one container**: the entrypoint prepares the volume and syncs
grounding repos, then the supervisor runs the loopback-bound planner API and the outbound
Slack bridge. The compiled gate is baked into the image. The optional dashboard runs as a
second, public container that reaches the planner over a private network. All credentials are
runtime env vars; planner API auth and Jira token-file posture have boot gates, while the
writer validates Jira credentials and target configuration at the network boundary.

The current posture is **one clean single-tenant deployment per organization** — nothing is
hardcoded to a specific org, but one deployment serves one org's tracker, repos, and coupling
map. Multi-tenancy is an explicit, opt-in future step (see [ROADMAP.md](ROADMAP.md)).
