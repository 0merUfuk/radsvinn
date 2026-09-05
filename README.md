# Radsvinn

**A coupling-aware AI planner that turns a plain-language request into a validated ticket tree — without ever letting the LLM write your tracker.**

Radsvinn reads your work request ("add prompt-text search to the history view"), grounds
itself in your actual codebase, and produces a well-formed tree of Jira tickets: an epic,
its stories, their sub-tasks — each with a why, a definition of done, acceptance criteria,
and verified code anchors. It knows which changes are *coupled* (a database column three
services write to; a producer that must ship before its consumer) and orders the tree so
the work is safe to execute.

The LLM proposes. A deterministic gate validates. A human approves. Only then does a
no-LLM tool write to your tracker. That separation is the whole point.

---

## Why Radsvinn is different

Most "AI ticket writers" hand an LLM your request and trust whatever it emits. Radsvinn
wraps a single planning agent in a **deterministic control plane** and brackets it with
**two human approval gates**:

- **Grounded** — the planner reads and greps your real repositories (read-only) and
  resolves every code anchor against `origin/main` git objects, not a working tree.
- **Coupling-aware** — a per-instance *coupling map* encodes your hazardous multi-writer
  zones (e.g. a shared ledger column) and cross-service ordering edges. The planner routes
  around them; a compiled Go gate checks that it did.
- **Gated** — the LLM's output is checked by a deterministic validator (structure,
  hierarchy, ordering, sizing, coupling-zone routing, anchor existence) and then shown to a
  human *twice*: once to approve the shape, once to approve the fully-groomed tickets.
- **The LLM never writes the tracker** — creation is a deterministic tool that takes the
  human-approved plan and makes the Jira calls. No model output reaches your board unreviewed.

The result is a planner you can trust with real work, because every place trust matters is
**code and a human**, not a model's promise.

---

## How it works

On a first-pass success, one plan flows through **two model phases** and **two human
gates**. Either model phase can regenerate against a deterministic-gate complaint, with
bounded retries, so a run may make more than two model calls:

```
POST /plan
  │  Break-Down: fresh agent session reads your ask + coupling map,
  │              greps the grounding repos, proposes a skeleton tree
  ▼  deterministic SKELETON gate (structure/hierarchy/sizing)
shape_ready
  │  ── HUMAN GATE 1: approve / edit / reject the SHAPE ──
  ▼
grooming: agent resumes, writes the 5 fields per ticket + verified anchors
  ▼  deterministic PLAN gate (fields, single-repo, anchors resolve
  │                           against origin/main, coupling-zone routing, sizing)
plan_ready  (+ advisory duplicate search)
  │  ── HUMAN GATE 2: approve the GROOMED TREE ──
  ▼
creating: no-LLM writer creates the tree in your tracker, then verifies it
  ▼
created
```

Request-driven phase starts and terminal human actions are persisted through a synchronous
compare-and-swap before the response, so racing clicks cannot double-fire a phase or resurrect
a rejected plan. Background workers persist their own progress and terminal state updates.
Daily soft/hard **spend breakers** run before every model call. The per-plan cap is checked
before every Groom call and, once spend exists, before each Phase-1 regeneration; Create has
no model call and no spend check. If a deterministic gate fails, the planner regenerates
against the machine's specific complaint (bounded retries) rather than shipping a bad tree.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full component and data-flow map.

---

## Quickstart

**A real plan tree in five minutes, with zero organization configuration**

Radsvinn ships a deterministic **fake-mode demo** that replays known-good fixtures through
the production HTTP handlers and state machine. It exercises both real Go gates, both human
actions, persistence, and spend breakers. For anchor validation it creates temporary local
Git repositories with `origin/main` refs. The walkthrough itself opens only loopback HTTP and
makes no model, tracker, or remote-grounding calls. On a cold Go module cache, the Go toolchain
may download the repository's declared build dependencies before the checker starts.

**Prerequisites:** Node 22+, Go 1.25+, and Git.

```bash
make demo
```

The walkthrough submits a sample ask, approves its shape, validates the groomed plan against
the local `origin/main` objects, approves creation, and finishes with a fake tracker result.
To understand the v0.1.0 live-mode boundary and connect a compatible organization, follow
[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

---

## Configuration surface

Upgrading an existing installation? Read the
[identity migration guide](docs/IDENTITY-MIGRATION.md) for alias precedence,
retained contracts, and rollback behavior.

Radsvinn is env-driven. Service boot fails closed for unsafe planner-API authentication and can
enforce an env-only Jira-token posture. Tracker credentials and the live target are consumed
and validated by the deterministic writer at its network-operation boundary: the Cloud ID and
token have no live fallback, while the project and site have clearly-example defaults that a
production deployment must override. The v0.1.0 planner contract still uses a fixed, neutral
seed vocabulary for repositories and coupling zones; runtime-derived vocabulary is planned in
R1/R2. The core knobs:

| Variable | Required? | Example | Meaning |
|---|---|---|---|
| `RADSVINN_JIRA_SITE_URL` | recommended (live) | `https://your-domain.atlassian.net` | Your Jira site; the placeholder fallback only produces placeholder browse links |
| `RADSVINN_JIRA_CLOUD_ID` | yes (live) | *(no default — fails clearly if unset)* | Your Atlassian Cloud ID; the tracker write target |
| `RADSVINN_JIRA_PROJECT` | no | `PROJ` | Jira project key the tree is created under |
| `RADSVINN_JIRA_TOKEN` | yes (live) | *(env / secrets; local file fallback only)* | Jira API token used by the writer — use env-only posture on servers |
| `RADSVINN_GROUNDING_ORG` | yes (grounding) | `example-org` | The VCS org that owns your grounding repositories |
| `RADSVINN_GROUNDING_REPOS` | no | `web-app,api-service,worker-service,shared-lib` | Additive physical deployment clone list; defaults to the four seed repos. The fifth accepted plan value, `cross-repo-lockstep`, is a routing marker and is never cloned (legacy env entries are ignored) |
| `RADSVINN_COUPLING_MAP` | no | `coupling-map.yaml` | Path used by both the planner prompt and deterministic plan gate (an empty map is legal but degraded: it provides no coupling-zone enforcement) |
| `RADSVINN_LLM_PROVIDER` | no | `anthropic` | Selects `anthropic` or `openrouter`; setting a provider key alone does not switch providers |
| `ANTHROPIC_API_KEY` | yes (Anthropic live) | *(env / secrets only)* | Default provider key (bring your own) |
| `RADSVINN_OPENROUTER_API_KEY` | yes (OpenRouter live) | *(env / secrets only)* | Required when `RADSVINN_LLM_PROVIDER=openrouter` |
| `RADSVINN_ENGINE` | no | `fake` | `fake` runs the demo engine; anything else uses the real agent |

The full env table (planner + Slack bridge + dashboard) lives in
[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) and in each service's own README.

---

## The safety model, stated plainly

These are invariants, not preferences — the reasons Radsvinn can be trusted with real work:

1. **The LLM never writes your tracker.** Creation is a deterministic tool operating on a
   human-approved plan. No model output reaches your board unreviewed.
2. **Two human gates** bracket the two model phases — approve the *shape*, then approve the
   *content*. The human is the correctness authority; the machine's job is to make sure the
   human sees exactly what they're approving.
3. **The deterministic gate is fail-closed.** Structure, ordering, sizing, coupling-zone
   routing, and anchor existence are checked by compiled Go, not by trusting the model. A
   hard failure blocks; verdict arithmetic is computed in code from unrounded totals.
4. **Anchors resolve against `origin/main` git objects**, never a local working tree — so a
   ticket can't cite code that isn't actually on the mainline.
5. **The planning agent is sandboxed** — read-only tools (`Read`, `Grep`, `Glob`), default
   permission mode, no shell. Untrusted request text can't escalate into command execution.
6. **Spend is bounded** — daily breakers run before every model call; the per-plan cap runs
   before every Groom call and before paid Phase-1 regeneration. Create is deterministic and
   has no model-spend check.
7. **Cancel, never delete.** Undoing a created tree transitions every issue to a terminal
   state (children before parents); nothing is destroyed.

---

## Repository layout

| Path | What |
|---|---|
| `service/` | The planner: HTTP API state machine, the agent-invocation engine, spend breakers, grounding (git fetch + anchor resolution), the Slack Socket-Mode bridge. See [service/README.md](service/README.md). |
| `internal/checks/` + `cmd/treecheck/` | The deterministic gate — structural / hierarchy / ordering / sizing / coupling-zone / anchor-existence validation. Logic in Go; tunables in `internal/checks/thresholds.yaml`. |
| `tools/create-tree.mjs` | The **only** tracker writer — deterministic, no LLM. Creates / links / verifies / cancels; cancel is a transition, never a delete. |
| `contracts/` | Wire contracts — the skeleton and plan JSON schemas. |
| `prompts/` | The decomposer / groomer / judge prompts — verbatim model payloads. |
| `coupling-map.yaml` | The coupling ground truth for this instance (per-instance; an empty map is legal). |
| `dashboard/` | An optional web review surface (GitHub-OAuth BFF over the planner API). See [dashboard/README.md](dashboard/README.md). |
| `harness/` | The calibration instrument — measures planner quality (judge ≠ generator, blind labeling, agreement stats). |
| `fixtures/` | Sample asks, dry-run envelopes, and golden artifacts for the fake engine. |
| `deploy/` | Single-container entrypoint + supervisor (volume layout, grounding-repo sync). |

---

## Documentation

- **[docs/FAQ.md](docs/FAQ.md)** — the whole product explained in one screen. Start here
  after the README.
- **[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)** — from-zero setup: the fake-mode
  demo, then connecting your tracker, your repositories, and your coupling map.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — components, process topology, data
  flow, data stores, and the safety spine.
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — what is shipped, what is next, and the
  generalization spine (R1–R7).
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — commands, environment, and the Railway
  deployment runbook.
- **[CHANGELOG.md](CHANGELOG.md)** — what shipped and when.

---

## License

[MIT](LICENSE) — © 2026 0merUfuk.
