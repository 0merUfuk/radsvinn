# Roadmap

Where Radsvinn is headed. Radsvinn today is a strong, safety-first planning engine: two LLM
planning phases on a first-pass success (bounded gate-driven regeneration may add calls),
bracketed by two human gates, a deterministic Go gate, a no-LLM tracker writer, spend
breakers, request-driven compare-and-swap transitions, and crash-safe resume. The work ahead
falls into two tracks an operator can run in parallel or choose between:

- **Track A — keep the tool healthy:** reliability, safety, and observability of the running
  planner. No generalization required.
- **Track B — generalize into a product:** the configuration spine, adapters, docs, and the
  coupling-map generator that let a stranger stand Radsvinn up against their own organization.

Several early items serve both. Horizons are **NOW → NEXT → LATER**, dependency-ordered.

---

## Shipped (the floor this roadmap stands on)

These are already in the repo and proven by the test suite. Listed here so the forward-looking
tracks do not re-claim them as TODO — a stranger reading this should be able to trust that
"shipped" means the code does it today.

| Capability | Where it lives |
|---|---|
| **Grounding Full/Light control** — opt-in `grounding_hint`, `# GROUNDING` directive, `--max-turns` cap on decompose (flat) and groom (plan-size-scaled), surfaced at the shape gate; asymmetric default (light is never the silent default, mutation-proven) | `service/engine.mjs` (`GROUNDING_DIRECTIVES`, `lightMaxTurns`, `lightGroomMaxTurns`); `service/test/grounding-hint.test.mjs` |
| **Denied-tool turn tax killed** — `# TOOLS` directive in service-mode phase1+groom messages; coupling map injected into phase1 under `# COUPLING MAP` (read-once cached, graceful-missing) | `service/engine.mjs` (`serviceToolsDirective`, `couplingMapBlock`); `service/test/service-mode-prompt.test.mjs` |
| **Phase-timing observability** — `{durationMs, numTurns, model}` in engine result; `[radsvinn] phase=…` structured log line per completed phase | `service/server.mjs` (`logPhaseTiming`); `service/engine.mjs` (runPhase return) |
| **Per-seat model/effort split** — `RADSVINN_AGENT_MODEL_DECOMPOSE`/`_GROOM`, `_EFFORT_DECOMPOSE`/`_GROOM`, fallback to shared then built-in defaults, omitted-kind → GROOM (fail-strong) | `service/engine.mjs` (`seatConfig`); `service/test/sandbox-env.test.mjs` |
| **Cloud deployment** — surface persistence (Window A/B), Railway container layer (supervisor, fail-closed API-auth/token-file boot posture, spend mutex, child-environment credential stripping), fetch-before-plan, `deploy/entrypoint.mjs` + `Dockerfile` + `railway.json` | `service/slack.mjs`, `service/supervise.mjs`, `service/grounding.mjs`, `service/breakers.mjs`, `deploy/` |
| **Product-feedback r1** — wizard scope+language+grounding radios, attach-to-epic (GET-verify-before-write, `attached_epic` outside `created[]`), `proseToADF` structured Jira rendering, Unicode-aware duplicate search, project-agnostic Jira-key shape at tool + Go gate | `service/slack.mjs`, `tools/create-tree.mjs`, `service/server.mjs` (`searchTerms`), `internal/checks/precheck.go` (`jiraKeyRE`) |
| **Self-explaining gate failures** — sizing×scope collision copy removed (leaf cap demoted to advisory WARN); `firstFailingComplaint` leads with the actual hard complaint, skips WARNs | `service/server.mjs` (`describeSkeletonGateFailure`, `describePlanGateFailure`); `service/test/gate-failure-message.test.mjs` |
| **Dashboard BFF** — GitHub OAuth (PKCE), RBAC (viewer/planner/approver/creator), CSRF (4 layers), rate limits, session store, planner client with micro-cache | `dashboard/` |
| **Bounded regeneration** — gate-failed artifacts re-generated against the deterministic complaint, max 2 per phase, persisted across restarts | `service/server.mjs` (`runPhase1Worker`, `runGroomWorker`) |
| **Empty coupling-map legality** — a map with zero no-go zones is accepted as an explicit degraded state; it provides no coupling-zone enforcement until an operator adds coupling knowledge | `internal/checks/precheck.go` (`loadNoGoZones`, `checkZoneRouting`); `internal/checks/adversarial_gate_test.go` |

---

## The generalization refactors (Track B backbone)

These seven refactors are the spine of making Radsvinn organization-independent. Each unblocks
the next; the first three are the keystone — nothing downstream is clean until the vocabulary
is de-welded from any one organization.

| # | Refactor | Depends on | What it does |
|---|---|---|---|
| **R1** | **Config spine.** One instance profile — org, tracker (site, cloud id, project, subtask type), VCS (org, repos, root), zone vocabulary, brand, RBAC teams — read and validated once at boot. Secrets stay in env. | — | The substrate. Every other refactor reads from it; the frozen enums are generated from it. |
| **R2** | **De-freeze the vocabulary + fix the leaks.** Generate the repo-universe and coupling-zone enums from R1; the gate derives legal zones from the map it already parses. Project-agnostic issue-key pattern. No hardcoded tracker site or cloud id anywhere in output. | R1 | Removes the trap where a new org's repos/zones/keys are rejected at the schema/gate boundary, and stops any cross-tenant link leaking into output. |
| **R3** | **Neutralize the planning prompts.** Strip domain-specific business rules out of the base prompts; inject a per-instance **domain profile** and drive semantics from the coupling map's own `why` fields. Base prompts keep only generic seam rules (producer-before-consumer, migration-before-reader). | R1, R2 | The subtlest weld — today a domain-specific base prompt silently mis-plans other domains. |
| **R4** | **Coupling map as a per-instance artifact.** Empty-map legality is already shipped. Remaining work is (b) a guided **generator** that greps for shared-write tables, cross-service calls, and hardcoded enums to propose candidate zones a human ratifies, and (c) a freshness diff on grounding fetch. | R1, R2, R3 | Turns the hand-seeded map into an operable per-instance artifact while preserving the legal, degraded empty starting point. |
| **R5** | **Integration adapter seams.** An `IssueTracker` interface (Jira as implementation #1, absorbing the browse-URL / subtask-id / project logic), then `Surface` (Slack #1) and `GroundingSource` (Git/GitHub #1). Thin seams first, no behavior change. | R1 | Makes the tracker, chat surface, and VCS each *one choice*, not the only choice. |
| **R6** | **Branding + zero-to-boot + public docs.** Brand strings behind a theme config; clearly-example placeholder defaults; a documented degraded getting-started path; product README + architecture doc; domain-neutral fixtures. | R1, R2 | The white-label finish, describing a genuinely generic product. |
| **R7** | **(Optional) True multi-tenancy.** A tenant id per plan; per-tenant config, map, tracker, breakers, and audit. Explicitly last and opt-in — configurable single-tenant (R1–R6) is most of the value. | R1, R5, relational store | Do not start before R1–R6 land and demand pulls for it. |

---

## NOW — bound the cliffs, plant the product flag

Cheap, high-leverage, mostly standalone. Ordered by open-source reception leverage (a stranger
landing on the repo should hit the highest-trust work first).

**Product flag (Track B):**

- **The front door** — a product README, a five-minute fake-mode demo, `LICENSE` /
  `CONTRIBUTING` / `CODEOWNERS`, and a root task-runner from a clean clone. *(README and
  fake-mode demo are shipped; `CODEOWNERS` and a root `CONTRIBUTING.md` symlink/copy are the
  remaining cheap pieces.)*
- **Kill cross-tenant identity leaks** — one config-derived browse URL; fail-closed the tracker
  cloud id (no baked default); expose the tracker target in the read model so every surface
  shows the *right* project at the approval moment. *(This seed already removes the baked
  organization defaults; the config-derived browse URL is the R1 follow-through.)*
- **Write down the go-to-market shape** — design-partner-first on a self-hostable open-core
  base; make bring-your-own-model-key the default; explicitly defer multi-tenant scaffolding.

**Reliability & safety (Track A):**

- **Bounded worker pool / admission control** — an in-process semaphore in front of the agent
  spawns (cap N concurrent, 429-or-enqueue the excess, expose depth in `/healthz`). The single
  highest-severity fix: without it, a burst of overlapping plans can OOM one container and
  sweep every in-flight plan to `failed`.
- **Default `--max-turns` on full-grounding calls + a mid-call spend ceiling** — the light-mode
  cap is shipped; bound the *full*-grounding latency and cost tail.
- **Skeleton ⊆ plan coverage gate** — a deterministic check that the groomed plan still covers
  every item the human approved in the shape, so tickets can never silently vanish.
- **Security hardening** — convert the agent child env from a **deny-set** to a **keep-set**
  (today `sandboxedEnv` strips known-dangerous keys; a keep-set of only the Anthropic credential
  is the stronger posture); a fail-closed boot guard on agent posture; a loud consent signal
  when a non-default model provider is live.
- **Provenance in `/healthz`** — pin concrete model ids instead of floating aliases; today
  `healthz` returns `version` and `engine` but not the resolved model/provider.
- **Data capture** — a per-phase metrics ledger (provider, model, grounding, turns, duration,
  cost, gate result) and a real reject-reason taxonomy — the inputs every later metric needs.

---

## NEXT — build the substrate, prove the surfaces

**Track B foundation (the hinge):** the config spine (R1) → de-freeze the vocabulary (R2) →
neutralize the prompts (R3). Empty coupling-map legality is already shipped; the R4 generator
and freshness work remain future work. In parallel: split the engine and extract the
`IssueTracker` adapter (R5); a type gate (`--checkJs` in CI) as the compile-time net for the
refactor itself; expose the tracker target in the read model.

**Track A nets & observability:**

- **Real-engine / real-I/O smoke** — replay recorded envelopes through the shipped engine parse
  path and drive the writer against a fetch stub; one opt-in live end-to-end; freeze the
  argv + output contract. Today the deployed money-spending, tracker-writing path has no
  automated coverage.
- **CI image build + boot smoke** of both images; branch protection; a staging environment and
  cut release tags (a real rollback target).
- **Observability floor** — `/metrics` counters, alerting on lock/cap crossings and repeated
  worker failure, a liveness probe distinct from `/healthz`, and a rollup (funnel, gate pass
  rate, regen rate, reject rate, cost percentiles).
- **A prompt-injection + grounding-egress test harness** against the real engine, gated in CI.

**Quality & product features:**

- **Calibrate the shipped invocation** and commit a golden baseline + a CI verdict-diff
  tripwire — output quality has never been measured on the path that ships.
- **Attach the quality judge** as a non-blocking advisory score surfaced at the human gate.
- A backlog-cleanup ("groom my existing tickets") feature; team-readiness (per-user attribution
  and ownership gating on the mutating actions); prove-and-ship the dashboard against real OAuth
  and real tracker; a de-branded architecture doc and domain-neutral fixtures.

---

## LATER — scale, moat, and the optional multi-tenant unlock

- **The guided coupling-map generator (R4b/c)** — read-only probes that turn the coupling moat
  from a consulting engagement into a product step. The highest-value deep cut, correctly last
  of the coupling chain.
- **Horizontal scale (dependency-ordered):** a relational store (state, spend, telemetry, audit
  → conditional updates / atomic increments / queries), then a durable job queue and a separate
  worker fleet. The only thing that lifts the single-box ceiling.
- **Product API & integrations:** a second tracker adapter (via the `IssueTracker` seam); a
  versioned public API with published schema, signed webhooks, and per-consumer keys; a billing
  meter on the already-accurate per-plan cost.
- **Buyer-grade & multi-tenant (only if demand pulls):** least-privilege per-tenant credentials;
  enterprise auth / audit export / residency; and **true multi-tenancy (R7)** — opt-in, gated on
  multiple partners pulling for it.
- **The executor (a future iteration):** turning approved tickets into draft PRs — hard-gated
  behind its own preconditions (the advisory judge and the coupling-map generator) and not
  started before that gate clears.

---

## The trap to avoid

The most expensive mistake available is building **multi-tenant SaaS scaffolding** (tenant ids,
a relational store, billing, SSO) *before* a design partner has pulled for it. Radsvinn's
nature — deep private-repo and tracker access, a hand-built coupling topology, real per-plan
cost — points at **design-partner-first on a self-hostable open-core base**, not frictionless
self-serve. Configurable single-tenant (R1–R6) is most of the value; earn multi-tenancy with
demand.
