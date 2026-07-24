# Changelog

All notable changes to Mercury are documented here. This repo is the **org-neutral product
seed** (`github.com/0merUfuk/mercury`); the single-tenant transition narrative is intentionally
not in this repo (see [docs/HISTORY.md](docs/HISTORY.md)).

Format: one section per release, most recent first. Items grouped by **Added**, **Changed**,
**Fixed**, **Removed**. Dates are ISO.

---

## [Unreleased] — v0.1.0 release candidate

The generalized, org-neutral product seed. Seeded from the single-tenant planner HEAD, then
de-organization-ized and structurally extended with a dashboard BFF and an R1–R7 generalization
roadmap. The deterministic gates, fake lifecycle, offline tracker rendering, and dashboard
surfaces are covered by the test suite (Go + service + dashboard). External model providers,
real tracker writes, live Slack sockets, remote grounding, and production deployment remain
operator-configured/live verification surfaces. This section describes the current release
candidate; v0.1.0 is not released until the repository is tagged.

### Added

- **Dashboard BFF** (`dashboard/`) — GitHub OAuth (PKCE), RBAC (viewer / planner / approver /
  creator from GitHub team membership), CSRF in four layers, per-session + per-IP rate limits,
  session store, planner client with 2s micro-cache and concurrency cap, static SPA shell.
- **Fake-mode lifecycle demo** (`service/demo.mjs`, `make demo`) — submits the sample ask over
  the real loopback HTTP API, exercises both human approvals and both real Go gate modes against
  temporary local `origin/main` objects, then finishes with the fake tracker writer. It makes
  no model, tracker, or remote-grounding calls.
- **Cloud deployment layer** — `deploy/entrypoint.mjs` (volume layout, grounding-repo sync,
  credential-scrubbed logging), `deploy/lib.mjs` (secret scrubbing, env-based git auth),
  `Dockerfile` (multi-stage, static treecheck build, pinned claude CLI), `railway.json`,
  `service/supervise.mjs` (one container, two processes — planner + Slack bridge — health-gated
  bridge start, capped-backoff restarts, flap→exit, SIGTERM grace).
- **Surface persistence** — opaque `surface` descriptor + `announced_status`
  delivery cursor on the durable plan record; `POST /plan/{id}/surface`; the Slack bridge
  writes the surface at submit/placeholder/advancing-click and advances the cursor only after a
  delivered post; boot-resume re-attaches channels from the store. Kills Window A (bridge dies
  mid-plan) and Window B (plan reaches terminal while bridge is down).
- **Grounding Full/Light control** — opt-in `grounding_hint` wire field, `# GROUNDING`
  directive in phase1 + groom messages, `--max-turns` cap on decompose (flat) and groom
  (plan-size-scaled), surfaced at the shape gate. Asymmetric default: light is always opt-in,
  never silent (mutation-proven).
- **Denied-tool turn tax killed** — `# TOOLS` directive in service-mode phase1 + groom messages
  (tells the agent not to attempt `git fetch` / `Write` / `Bash`-treecheck, all denied in
  service mode); coupling map injected into phase1 under `# COUPLING MAP` (read-once cached,
  graceful-missing fallback).
- **Phase-timing observability** — `{durationMs, numTurns, model}` in engine result; structured
  `[mercury] phase=… model=… grounding=… turns=… duration_ms=… cost_usd=…` log line per
  completed planning call.
- **Per-seat model/effort split** — `MERCURY_AGENT_MODEL_DECOMPOSE` / `_GROOM`,
  `MERCURY_AGENT_EFFORT_DECOMPOSE` / `_GROOM`, fallback to shared `MERCURY_AGENT_MODEL` /
  `_EFFORT` then built-in defaults (`opus` / `xhigh`). Omitted-kind resolves as GROOM
  (fail-strong).
- **Attach-to-epic** — `plan.epic.existing_key` attaches the tree under a pre-existing board
  epic: GET-verify before any write (die loudly on missing/non-Epic/malformed key — never fall
  back to creating a fresh epic), no epic POST, L0s parent under the existing key,
  `attached_epic` outside `created[]` so cleanup can never cancel an epic Mercury did not
  create. Project-agnostic Jira-key shape enforced at both the tool boundary and the Go gate.
- **Product-feedback r1** — wizard scope + language + grounding radios (defensive extraction
  with stderr trace), `# SCOPE` hard directive, `proseToADF` structured Jira rendering
  (blank-line paragraphs, dash bullet lists, hard breaks, CRLF-normalized), Unicode-aware
  duplicate search (`\p{L}\p{N}` term builder, skeleton-epic-summary seed preference).
- **Bounded regeneration** — gate-failed planning artifacts re-generated against the
  deterministic gate's own complaint (never an LLM judge), max 2 per phase, persisted
  (`regen_counts.{phase1,groom}`) so a retry resumes at N, never a fresh 2× loop.
- **Audit ledger** — append-only JSONL (`service/audit.mjs`), `GET /audit` with keyset
  pagination; `appendAudit` never throws and never blocks a mutation on disk failure.
- **OpenRouter metering proxy** (`service/openrouter-meter.mjs`) — provider-authoritative cost
  telemetry: a fresh loopback proxy per `claude -p` call, single-use capability (never the
  OpenRouter credential), reconciles every `X-Generation-Id` receipt. `CostTelemetryError` /
  `MeteredPhaseError` classes; any uncertainty hard-locks LLM spend.
- **Fetch before plan** — `service/grounding.mjs` refreshes `origin/main` in every grounding
  repo before phase 1; authenticated for private repos via env-based git config (token never in
  argv / `.git/config` / logs); degrades visibly at the shape gate.
- **Spend mutex** — daily-spend writes serialized through an in-process promise chain;
  50-way concurrency yields exact totals (single-instance; Postgres atomic UPDATE is the
  multi-instance fix).
- **Child-environment credential stripping** — the `claude` child env removes `MERCURY_JIRA_TOKEN`, `SLACK_*` (prefix),
  `MERCURY_SERVICE_TOKEN`, `GITHUB_TOKEN` / `GH_TOKEN`, `MERCURY_OPENROUTER_API_KEY`,
  `OPENROUTER_API_KEY`, and `RAILWAY_*` (prefix). This is a deny-set over the inherited
  environment, not a strict keep-set; `--add-dir` bounds the sandbox to the grounding root.
- **Fail-closed boot** — non-loopback bind or `MERCURY_REQUIRE_AUTH=1` without a real
  `MERCURY_SERVICE_TOKEN` refuses to start; `MERCURY_REQUIRE_ENV_ONLY_TOKEN=1` refuses to boot
  when the Jira token-file fallback exists.
- **Self-explaining gate failures** — `describeSkeletonGateFailure` / `describePlanGateFailure`
  return a human sentence (the actual hard complaint, WARNs skipped), never raw gate JSON to the
  user; raw JSON persisted on the plan and logged to stderr for operators.
- **Sizing-warn demotion** — the leaf-cost cap is advisory (WARN, non-blocking); only
  max-depth and unknown-repo hard-fail sizing. Removes the unsatisfiable-by-construction
  collision case.
- **Fail-closed gate output validation** — an exit-0 `treecheck` child must also emit the
  documented skeleton/plan verdict shape and complete baseline check set. Empty, malformed,
  partial, or contradictory output cannot green-light a plan.
- **Makefile** — `demo`, `test`, `gate`, `check`, and `status` targets. `gate` sends the bundled
  skeleton fixture to the documented checker CLI over stdin; `demo` exercises both real gate
  modes. `check` runs demo + test + gate, then `public-scan`, which scans releasable tracked
  and untracked files, excludes internal agent/task/handoff artifacts, and fails on a match or
  scan error. CI runs the same `public-scan` target in its public-hygiene job.
- **R1–R7 generalization roadmap** (`docs/ROADMAP.md`) — config spine → de-freeze vocabulary →
  neutralize prompts → coupling-map generator → adapter seams → branding → optional
  multi-tenant.

### Changed

- **Prompts de-organization-ized** — `prompts/decomposer.md`, `prompts/groomer.md`,
  `prompts/judge-ticket.md`, `prompts/judge-tree.md` stripped of source-org vocabulary;
  fixed plan repo/routing vocabulary (four physical seed repos: `web-app`, `api-service`,
  `worker-service`, `shared-lib`; plus the non-clone `cross-repo-lockstep` routing marker)
  and neutral example ticket keys (`PROJ-…`).
- **Grounding clone defaults corrected** — deployment syncs the four physical seed repos only;
  an explicit legacy `MERCURY_GROUNDING_REPOS` entry for the plan-only
  `cross-repo-lockstep` marker is accepted but filtered rather than cloned.
- **Coupling map neutralized** — `coupling-map.yaml` uses the placeholder repo set; no-go zones
  are example entries a new instance replaces.
- **Thresholds neutralized** — `internal/checks/thresholds.yaml` repo universe aligned with the
  placeholder set; `TestSupportedRepoUniverseStaysAligned` locks the schemas, the YAML, and the
  Go enums in lockstep.
- **`describeSkeletonGateFailure` simplified** — the sizing×scope collision branch removed
  (leaf cap is now advisory, so the collision case does not exist); the generic
  `firstFailingComplaint` path leads.

### Removed

- All source-organization identifiers (tracker project key, org name, cloud id, repo names,
  team slugs, Turkish-specific incident references) from product-facing documents and prompts.
  `make public-scan`, invoked by both `make check` and CI, enforces this going forward.
- The single-tenant owner FAQ (replaced by the org-neutral [docs/FAQ.md](docs/FAQ.md) in this
  release cycle).

### Test surface

- Go: `internal/checks/` contract, structural, adversarial, and sizing tests.
- Service: 34 `service/test/*.test.mjs` files covering HTTP e2e, retry guard, regen, cancel,
  audit, pagination, surface persistence, openrouter meter, sandbox env, token identity,
  fail-closed boot, supervise lifecycle, grounding, attach-epic, scope/grounding hints,
  gate-failure messages, gate-output validation, the fake lifecycle demo, and plans
  summary/read model.
- Dashboard: `dashboard/test/*.test.mjs` covering e2e, OAuth, RBAC, CSRF, rate limit, planner
  client, sessions, router, SSR.
- Harness: `harness/*.test.mjs` labeling and precheck utilities.
