# Mercury Planner Service — `POST /plan`

The `POST /plan` HTTP API that the Slack bridge and the Dashboard both sit on top of as thin
clients. It wraps the planning pipeline (the agent prompts in `prompts/*.md`) behind three
short HTTP calls bracketing two human approval gates.

Zero npm dependencies — `node:http`, `node:test`, `node:crypto`, `node:fs` only, matching this
repo's no-deps discipline.

---

## Release-candidate walkthrough

Start with the full fake-mode demo:

```bash
make demo
```

It drives the real loopback HTTP lifecycle through both human actions and both compiled Go
gates, including anchor checks against temporary local `origin/main` objects. It uses
deterministic fixtures and a fake tracker, so it needs no keys and makes no external model,
tracker, or remote-grounding calls. It opens only loopback HTTP; on a cold module cache, the
Go toolchain may download declared build dependencies before the checker starts.

---

## Direct service boot

```bash
node service/server.mjs
# [mercury] planner service listening on http://127.0.0.1:8090 (engine=real)
```

For lower-level development, this reduced fake-mode command skips the entire plan gate because
it does not prepare grounding checkouts. It is not equivalent to `make demo`:

```bash
MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node service/server.mjs
```

**Fail-closed boot:** when run directly, the server refuses to boot (`FATAL` on stderr, exit
1, before listening) if the effective bind is **not loopback** (`127.0.0.1`/`localhost`/`::1`)
while `MERCURY_SERVICE_TOKEN` is missing or empty — a non-loopback listen with no real token is
an unauthenticated planner API. Loopback binds keep the old behavior (an empty token still only
warns). `MERCURY_REQUIRE_AUTH=1` is the belt-and-suspenders (the container sets it): a real
token is required regardless of bind — in-container the server binds `127.0.0.1` (the bridge is
its only client), and this gate is what protects anyone who later flips the bind.
`MERCURY_REQUIRE_ENV_ONLY_TOKEN=1` (also set by the container) additionally makes boot fatal
when the local `~/.config/mercury/jira-token` file fallback exists — on a server the Jira
credential must be env-only (the file is a laptop convenience).

For the one-container deployment (supervisor, entrypoint, volume layout) see
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §11 and the `deploy/` directory.

---

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MERCURY_BIND` | `127.0.0.1` | Bind address |
| `MERCURY_PORT` | `8090` | Listen port |
| `MERCURY_ENGINE` | `real` | `fake` uses the deterministic fixture engine; anything else uses the real `claude` engine |
| `MERCURY_SERVICE_TOKEN` | unset | If set, every `/plan*` route requires `Authorization: Bearer <token>` (401 otherwise). `/healthz` is always open |
| `MERCURY_RESULTS_DIR` | `results` (relative to the repo root) | Absolute paths are used as-is — tests point this at a fresh tmp dir per run |
| `MERCURY_TREECHECK_BIN` | unset | Path to a prebuilt `treecheck` binary; falls back to `go run ./cmd/treecheck` |
| `MERCURY_SKIP_PLAN_ANCHORS` | unset | Keep unset for `make demo` and live use; `1` skips the entire plan gate and is only for reduced direct-server tests without grounding checkouts |
| `MERCURY_PLAN_BUDGET_USD` | `10` | Per-plan cost cap; checked before every Groom call and before a paid Phase-1 regeneration, never Create |
| `MERCURY_DAILY_SOFT_USD` | `50` | Current UTC-day spend — logs one warning per boot past this |
| `MERCURY_DAILY_HARD_USD` | `100` | Current UTC-day spend — refuses any new engine call past this |
| `MERCURY_LLM_PROVIDER` | `anthropic` | Real-engine provider selector: `anthropic` or `openrouter`; setting a provider key alone does not switch providers |
| `ANTHROPIC_API_KEY` | unset | Default-provider key (bring your own) |
| `MERCURY_OPENROUTER_API_KEY` | unset | Required when `MERCURY_LLM_PROVIDER=openrouter` |
| `MERCURY_AGENT_PERMISSION_MODE` | `default` | Real engine only — see "Security posture" below before changing |
| `MERCURY_AGENT_ALLOWED_TOOLS` | `Read,Grep,Glob` | Real engine only — comma-separated `--allowedTools` list; see below |
| `MERCURY_AGENT_MODEL` / `MERCURY_AGENT_EFFORT` | `opus` / `xhigh` | Real engine only — the shared model/effort for both planning phases |
| `MERCURY_AGENT_MODEL_DECOMPOSE` / `MERCURY_AGENT_MODEL_GROOM` | unset | Per-seat model override — beats the shared knob. Decompose may run a cheaper/faster model (a bad shape costs ~the phase-1 spend and one Reject click — the human gate is its safety net); groom should keep the strongest (it writes the verified anchors + coupling-zone routing the create gate approves). A non-default-provider model must be calibrated before it is trusted (see the harness) |
| `MERCURY_AGENT_EFFORT_DECOMPOSE` / `MERCURY_AGENT_EFFORT_GROOM` | unset | Per-seat effort override, same resolution ladder (seat → shared → default) |
| `MERCURY_LIGHT_MAX_TURNS` | `12` | Real engine only — the flat Phase-1 `--max-turns` cap when `grounding_hint` is `light` (see "Grounding depth" below). Non-integer/non-positive values fall back to the default |
| `MERCURY_LIGHT_GROOM_BASE_TURNS` / `MERCURY_LIGHT_GROOM_PER_ITEM_TURNS` | `6` / `4` | Real engine only — the light-mode Groom cap is `base + per-item × item count`. Invalid values fall back independently; `full` plans pass no cap in either phase |
| `MERCURY_COUPLING_MAP` | `coupling-map.yaml` (relative to the repo root) | One resolved path shared by real-engine prompt injection and the deterministic plan gate. Phase 1 receives the map verbatim under `# COUPLING MAP`; Groom resumes that session and does not re-inject it. Prompt loading is cached per path and degrades to a read-it-yourself note when missing/unreadable/oversized, while the later plan gate independently fails closed if it cannot load the configured map |
| `MERCURY_REQUIRE_AUTH` | unset | `1` makes a missing/empty `MERCURY_SERVICE_TOKEN` FATAL at direct boot regardless of bind (the container sets it) — see "Fail-closed boot" above |
| `MERCURY_REQUIRE_ENV_ONLY_TOKEN` | unset | `1` makes a present `~/.config/mercury/jira-token` file fallback FATAL at direct boot (the container sets it; env-only credential rule) |
| `MERCURY_REPOS_ROOT` | sibling checkout (container: `/data/repos`) | Where the grounding repos live — feeds the plan gate's `-repos-root`, the agent's `--add-dir`, and fetch-before-plan (`service/grounding.mjs`) |
| `MERCURY_FETCH_BEFORE_PLAN` | unset | `1` runs `git fetch origin main` in every grounding repo before phase 1. The result rides the plan as `grounding` (`{ok, detail?}`, via `GET /plan/{id}`); a failed fetch NEVER blocks the plan but renders `⚠ grounding fetch failed — anchors may validate against stale code` at the Slack shape gate |

The **tracker target** (`MERCURY_JIRA_SITE_URL`, `MERCURY_JIRA_CLOUD_ID`, `MERCURY_JIRA_PROJECT`,
`MERCURY_JIRA_TOKEN`) is consumed by the deterministic writer (`tools/create-tree.mjs`), not by
the planner server directly. The service can boot without it; the writer fails closed at a
Jira network operation if its Cloud ID or token is missing. Project and site fall back to
`PROJ` and `https://your-domain.atlassian.net`, respectively, so live deployments must set both
explicitly. See "Security posture" below and
[../docs/GETTING-STARTED.md](../docs/GETTING-STARTED.md) for the full table.

---

## Three HTTP calls, two model phases

```
POST /plan ───────────────────▶ 202 {plan_id, status:"breaking_down"}
                                  │  engine.phase1: fresh claude session,
                                  │  Break-Down, skeleton gate, present shape
                                  ▼  status:"shape_ready"
   ── HUMAN GATE 1: approve / edit / reject the SHAPE ──
POST /plan/{id}/approve-shape ─▶ 202 {status:"grooming"}
  {skeleton_edits?}                │  engine.groom: --resume, Groom, plan gate
                                  ▼  status:"plan_ready"
   ── HUMAN GATE 2: approve / reject the GROOMED TREE ──
POST /plan/{id}/create ────────▶ 202 {status:"creating"}
                                  │  engine.create: CONTROL-PLANE —
                                  │  create-tree.mjs --live --out, then
                                  │  --verify (no agent, no LLM)
                                  ▼  status:"created" {created}
```

On a first-pass success, the model runs in two phases: a fresh `--session-id` for Phase 1,
then one `--resume <session_id>` for Groom. A deterministic-gate failure can add bounded
resume calls in either phase. Create never touches an LLM — it is a deterministic
`create-tree.mjs` spawn (see "Security posture" below); the advisory `duplicate_search` runs
at `plan_ready` via `--search`. Request-driven phase starts and terminal human actions are
persisted through `state.transition` compare-and-swap before their HTTP responses, so racing
requests cannot double-fire a phase or resurrect a rejected plan. Workers persist their own
progress and terminal states with `state.update`.

### Phase-timing log

Every completed planning call (decompose and groom, both engines) emits one structured line to
**stderr** — so latency/cost decisions become evidence-based instead of guessed:

```text
[mercury] phase=decompose plan=1b7c9a2e model=sonnet grounding=light turns=9 duration_ms=48231 cost_usd=0.41
[mercury] phase=groom plan=1b7c9a2e model=opus grounding=light turns=6 duration_ms=93518 cost_usd=0.88
```

`phase` ∈ `decompose` \| `groom`; `plan` is the plan id's first 8 chars; `model` is the ACTUAL
resolved model the engine ran (per-seat ladder, never re-derived); `grounding` is the plan's
`grounding_hint` (`full` for legacy plans); `turns` is the agentic-loop turn count from the
CLI's `--output-format json` result (`?` when not reported); `duration_ms` prefers the CLI's
own `duration_ms` and falls back to the service's wall-clock measurement of the spawn;
`cost_usd` is the accounting charge recorded for the call: direct Anthropic mode uses the
Claude CLI's reported `total_cost_usd`, while OpenRouter mode accepts only reconciled provider
receipts from Mercury's metering proxy. The fake engine returns deterministic accounting stubs
(`model=fake turns=1 duration_ms=0`) so breaker and persistence tests stay byte-reproducible;
those stubs do not represent provider or model spend.

---

## Endpoints

| Method + path | Body | Returns |
|---|---|---|
| `POST /plan` | `{description, requester, role_lens?, mode?, output_language?, scope_hint?, grounding_hint?, surface?}` | `202 {plan_id, status}` |
| `GET /plan/{id}` | — | `{plan_id, status, created_at, updated_at, cost_usd, output_language, scope_hint, grounding_hint, skeleton?, skeleton_gate?, plan?, plan_gate?, duplicate_search?, agent_summary?, created?, error?, surface?, announced_status?, grounding?}` |
| `GET /plans` | — | `{plans:[{plan_id, status, description, updated_at, surface?, announced_status?}]}` — sorted by `updated_at` desc, capped at 50; `description` truncated to 80 chars. Feeds a thin client's own boot-resume (e.g. `service/slack.mjs`) — the two surface fields are what let a restarted client re-attach a plan's reply-to and delivery cursor |
| `POST /plan/{id}/approve-shape` | `{skeleton_edits?}` | `202 {status:"grooming"}` / `409` / `422` |
| `POST /plan/{id}/create` | — | `202 {status:"creating"}` / `409` |
| `POST /plan/{id}/reject` | `{reason?, stage?}` | `200 {status:"rejected"}` / `409` |
| `POST /plan/{id}/retry` | — | `202 {status}` / `409` — from `failed` **or `budget_blocked`** (the daily cap is a routine transient: workers re-check both breakers on entry, so a still-capped retry re-blocks cleanly). Resumes at the phase that failed (breaking_down → grooming → creating), judged by which run-dir artifact is missing **and by whether that artifact's deterministic gate actually passed** — a gate-failed or gate-missing artifact re-runs its phase (which re-gates), never rides into create. Reuses the persisted `output_language`/session/skeleton. **Guarded**: a failed plan that already holds a created record is *verified*, never re-created — a fully-created tree whose post-create `--verify` hiccuped heals to `created` on a green re-read; a partially-created tree stays `failed` with `--cleanup` guidance and a `created.partial:true` marker (a partial record verifying green only proves readability, never completeness) |
| `POST /plan/{id}/cancel` | — | `202 {status:"cancelling"}` / `409` — the undo for a tree already written to the real board. Legal from `created`, or from `failed` when the plan holds a created record (the surfaced partial tree). Control-plane sweep (`create-tree.mjs --cleanup <record> --live`): every recorded issue is transitioned to a terminal state (cancelled/closed where available), children before parents, locale-aware — **never deleted**. Ends `cancelled` (the sweep ran with zero hard failures; marker gains `cancelled:true`, sweep output in `agent_summary`) or `failed` with re-click guidance — a failed sweep (cleanup exits 1 on hard per-issue failures) and a sweep that could not run at all (spawn failure/timeout) both carry the same guidance and runnable `--cleanup` command; the marker survives, so cancel can simply be clicked/POSTed again. No record on file → `409 {error:"no created record to cancel"}` |
| `POST /plan/{id}/surface` | `{surface?, announced_status?}` | `200 {ok:true}` / `400` / `404` — surface persistence. Stores/refreshes the client-owned reply-to descriptor and/or advances the delivery cursor. At least one field required. A plain `state.update`, never a CAS — it never touches `status`, and last-writer-wins is correct for the single client that owns these fields |
| `GET /healthz` | — | `{ok, version, engine, daily_spend_usd, cost_telemetry_locked, cost_telemetry_status?}` (always open, no auth). `cost_telemetry_status:"locked"` is present only while the telemetry lock is active |

**`output_language`** ∈ `en` (default) · `tr` · `both` (English then Turkish). Governs all
prose the agent emits; technical jargon, identifiers, and code anchors always stay English. The
input ask may be Turkish or English regardless of this setting. The Slack wizard offers only
`en` · `tr`; `both` stays valid here for direct API callers.

**`surface`** / **`announced_status`** (the orphan-bug fix) — two CLIENT-owned fields on the
plan record, persisted by the existing file store and returned by `GET /plan/{id}` + `GET
/plans` (absent on legacy plans — JSON drops undefined). `surface` is an **opaque** reply-to
descriptor written by the surface client at `POST /plan` time (or later via `POST
/plan/{id}/surface`): the service validates only structure — a plain JSON object, ≤ 1024 bytes
serialized (400 otherwise) — and stores it **verbatim**, never interpreting the contents
(surface-agnosticism; the Slack bridge writes `{type:"slack", channel, message_ts?}`, a future
dashboard writes its own shape). `announced_status` is the **delivery cursor**: the last status
the surface client successfully announced to its humans, validated against the full status set
(including `cancelling`/`cancelled` and the transient statuses — the bridge plants a
`breaking_down` cursor when its placeholder posts). Together they kill both restart-loss
windows: the descriptor lets a restarted client re-attach the reply-to (Window A), and the
cursor lets it announce any status the plan reached while the client was down — including a
terminal one (Window B). See "Boot-resume" under the Slack bridge below.

**`scope_hint`** ∈ `auto` (default) · `single` · `small` · `epic` — the requester's own sizing
decision (the epic-overwork fix). `auto` lets the decomposer judge; anything else is injected as
a HARD `# SCOPE` directive into the phase-1 message (`engine.mjs` `phase1Message`, documented in
`prompts/decomposer.md` §Scope directive) that OVERRIDES the agent's size judgment: `single` =
one-node skeleton (epic null, no breakdown), `small` = 2–5 items with no epic, `epic` = full
epic breakdown. Persisted on the plan, echoed by `GET /plan/{id}`, and surfaced at the Slack
shape gate (`scope: …` in the context line, non-`auto` only) so the approver checks the shape
honored it — the deterministic skeleton gate is deliberately untouched (one-node skeletons were
already legal; obedience is checked by the human at the gate, never a new machine gate).

**`grounding_hint`** ∈ `full` (default) · `light` — **Grounding depth** (the repo-reading-tax
fix). Every decompose pays for the agent's Read/Grep exploration across the grounding repos in
tool-loop turns, which drives BOTH cost and latency — a trivial ask ("rotate an API key") paid
nearly the same as a deep one because grounding depth was fixed. `light` is the requester's
OPT-IN way to say "this task doesn't need deep code grounding": it injects a `# GROUNDING`
directive into the phase-1 message (`engine.mjs` — minimize exploration, lean on the coupling
map and the ask, read at most a few files to confirm the most important anchors, fewer
`code_anchors` acceptable) AND adds deterministic `--max-turns` bounds to both model phases:
Phase 1 uses the flat `MERCURY_LIGHT_MAX_TURNS` cap (default 12), while Groom uses the
plan-size-scaled `MERCURY_LIGHT_GROOM_BASE_TURNS + MERCURY_LIGHT_GROOM_PER_ITEM_TURNS × item
count` cap (defaults 6 + 4 × item count). **The default is `full`,
deliberately — the failure mode is asymmetric**: over-grounding a simple ask wastes a few
dollars and minutes, but under-grounding a task that needed it silently degrades ticket quality
at the gate the human trusts most. Light is therefore never a silent default: it must be chosen
per-plan (wizard radio or API field), and a light plan is visibly marked `grounding: light` in
the Slack shape-gate context line so the approver never rubber-stamps an under-grounded ticket
thinking its anchors were deeply verified. `full` and absent are byte-identical to pre-feature
behavior (no directive, no cap, no gate note). Persisted on the plan and echoed by
`GET /plan/{id}`.

Validation: `description` non-empty, ≤ 8000 chars; `requester` non-empty; `role_lens` in
`business` \| `tech` (default `business`); `scope_hint` in `auto` \| `single` \| `small` \|
`epic` (default `auto`); `grounding_hint` in `full` \| `light` (default `full`); `mode` any
non-empty string when provided (default `front_door`).

State machine: `breaking_down → shape_ready → grooming → plan_ready → creating → created`;
`shape_ready | plan_ready → rejected`; `created | failed`-with-created-record `→ cancelling →
cancelled | failed` (the undo); any in-flight status `→ failed` on an async error; any pre-call
breaker check `→ budget_blocked` (terminal). Any request implying an illegal transition gets
`409 {error, status}`.

`plan_id` path segments are validated against a UUID shape (404 if malformed or unknown).
Unknown routes → 404. Wrong method on a known route → 405. Request bodies over 64KB → 413. Every
response is `application/json`.

---

## Reduced curl walkthrough (fake engine)

This lower-level path deliberately sets `MERCURY_SKIP_PLAN_ANCHORS=1`; it demonstrates the HTTP
contract but does not run the plan gate. Use `make demo` for the complete release-candidate
walkthrough.

```bash
MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node service/server.mjs &

curl -s -X POST localhost:8090/plan \
  -H 'Content-Type: application/json' \
  -d '{"description":"Add prompt-text search to generation history","requester":"you"}'
# {"plan_id":"<uuid>","status":"breaking_down"}

curl -s localhost:8090/plan/<uuid>
# poll until status is "shape_ready"

curl -s -X POST localhost:8090/plan/<uuid>/approve-shape -H 'Content-Type: application/json' -d '{}'
# {"status":"grooming"}

curl -s localhost:8090/plan/<uuid>
# poll until status is "plan_ready"

curl -s -X POST localhost:8090/plan/<uuid>/create -H 'Content-Type: application/json' -d '{}'
# {"status":"creating"}

curl -s localhost:8090/plan/<uuid>
# poll until status is "created" — cost_usd is 1.7 in fake accounting
# (0.8 + 0.9 canned charges; no provider spend; Create is 0)

curl -s localhost:8090/healthz
# {"ok":true,"version":"0.1.0","engine":"fake","daily_spend_usd":1.7,"cost_telemetry_locked":false}
```

---

## Fake-mode note

The fake engine never spawns `claude`, calls a model or tracker, or reads their tokens. It copies
the bundled deterministic offline fixtures at `fixtures/e2e-sample/{skeleton,plan}.json` into
the plan's run directory and returns canned accounting charges (`0.8 / 0.9 / 0` for
phase1/groom/create; no provider spend). The surrounding service still honors its grounding
configuration, so a direct fake-server run with `MERCURY_FETCH_BEFORE_PLAN=1` may perform git
network I/O. Use `make demo` for the isolated walkthrough: it prepares local temporary
grounding and makes no application calls to external services (the Go toolchain may still
resolve declared build dependencies on a cold cache). CI's `offline-fixtures` job
independently checks the same fixture surface. Fake mode still exercises the service's real
directory, state, gate, and breaker paths; only external model/tracker calls are replaced.

---

## State / file layout

```text
${MERCURY_RESULTS_DIR:-results}/
├── agent/
│   └── svc-<plan_id>/
│       ├── skeleton.json
│       ├── plan.json
│       └── created-record.json        # create-tree --live record (both engines)
└── service/
    ├── plans/
    │   └── <plan_id>.json              # one file per plan, atomic writes
    └── daily-spend-<YYYY-MM-DD>.json   # rolling daily breaker total
```

The created-record's shape: `{cloudId, project, created[], links[], ts}` — plus, when the
plan's epic carries `existing_key` (attach mode: the tree is parented under an epic ALREADY on
the board instead of creating a new one), `attached_epic: {temp_id, key, summary}`.
`attached_epic` sits deliberately OUTSIDE `created[]`: cleanup/cancel sweep `created[]` only, so
an epic Mercury did not create is never transitioned; `--verify` still reads the attached key
back, labeled `[attached]`.

The plan record additionally carries the two client-owned surface fields when a surface client
has written them: `surface` (the opaque reply-to descriptor, stored verbatim) and
`announced_status` (the delivery cursor) — see the endpoint notes above.

`results/` is already gitignored. On boot, `state.mjs` replays every plan file; any plan caught
in `breaking_down` / `grooming` / `creating` / `cancelling` (a worker was actively running when
the process died) reloads as `failed` with `error: "interrupted by restart"` — no zombie
workers, no silent resume of a call that never finished. The sweep rewrites only
status/error/updated_at: `surface` and `announced_status` ride the reload untouched, so a bridge
that also restarted can still see the swept `failed` is past its cursor and deliver the ⚠️ +
Retry. An interrupted *cancel* stays safe through that reload: the plan's created marker
survives, so the failed message re-offers the Cancel button (the `--cleanup` sweep is
re-clickable) and Retry routes through the verify-only guard — neither can re-create.

---

## Security posture of the real engine (read before enabling it)

The real engine is invoked with `--permission-mode default` and a read-only tool allowlist —
**not** `bypassPermissions`. `description` is untrusted external input (Slack/Dashboard/direct
API callers); running it through a Bash-capable agent under `bypassPermissions` is exactly the
prompt-injection → arbitrary-command → credential-exfiltration chain the sandbox is defending
against.

**What this build actually does** (`MERCURY_AGENT_PERMISSION_MODE` /
`MERCURY_AGENT_ALLOWED_TOOLS`, defaulting to `default` / `Read,Grep,Glob`, applied uniformly to
both model phases):

- Phase 1 and Phase 2 (decompose/groom) run with the model unable to execute Bash. Their
  user-message templates additionally ask the model to always echo the complete skeleton/plan
  JSON in a fenced code block in its final response; the SERVICE (not the agent) extracts that
  JSON and writes it to `runDir`, then runs the `treecheck` gate itself (`gates.mjs`) — so the
  restricted tool posture doesn't break the pipeline, it just stops depending on the agent's own
  Write/Bash calls succeeding.
- **Phase 3 (create) involves no agent and no LLM at all.** By create time the service holds
  gate-verified `plan.json`/`skeleton.json`; `engine.create` spawns `node
  tools/create-tree.mjs --plan <runDir>/plan.json --scope full --live` and then `--verify
  <record>` deterministically (argv arrays, no shell). When the groomed plan's epic carries
  `existing_key` (the duplicate-epic fix), the tool ATTACHES the tree under that existing board
  epic: the key is GET-verified first (must exist, must be an Epic — a typo'd key dies before
  any write), no epic is created, and the record carries `attached_epic` outside `created[]`
  (see the file-layout note). The tool loads the Jira token itself (env or
  `~/.config/mercury/jira-token`) along with the tracker target
  (`MERCURY_JIRA_SITE_URL`/`MERCURY_JIRA_CLOUD_ID`/`MERCURY_JIRA_PROJECT`); the service never
  touches a credential, and no untrusted text goes anywhere near an LLM in the only step that
  writes to the tracker.
- The same control-plane path powers the advisory `duplicate_search` attached at `plan_ready`
  (`create-tree.mjs --search`, degrades to `ok:false` without a token — never blocks the human
  gate). The search seed is the skeleton's epic summary when present (the concise,
  on-board-comparable title; ask-prefix fallback for one-node skeletons), and `searchTerms()` is
  Unicode-letter aware — a Turkish ask searches as Turkish instead of being stripped to ASCII
  fragments.
- Both env vars are real, load-bearing overrides, not vestigial ones — they govern the two
  PLANNING calls only.

Automated tests cover the real path's prompt composition, CLI argument construction, artifact
extraction, credential stripping, provider resolution, and OpenRouter metering through unit
seams and local fakes. They deliberately do not launch the external agent CLI or contact a
model provider, tracker, Slack socket, or remote grounding host. Real mode is an
operator-configured deployment path and requires live smoke checks against that operator's
services.

---

## Tests

```bash
MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs
```

No live-service calls, no `claude`, no tokens. HTTP lifecycle tests boot a real server on an
ephemeral loopback port against a fresh tmp results directory (`os.tmpdir()`) and tear it down
afterward. Most direct HTTP lifecycle tests skip the plan gate via
`MERCURY_SKIP_PLAN_ANCHORS=1`; their skeleton gate is the REAL
`go run ./cmd/treecheck -mode=skeleton` (no Go mocking). The demo and dedicated
gate/regeneration tests prepare grounding inputs and exercise real plan mode.

---

## Slack bridge

`service/slack.mjs` is a thin Slack client over this API — Socket Mode, zero npm dependencies
(Node 22+'s native `WebSocket` + `fetch` only), connecting **outbound** to Slack. No public URL
/ inbound ingress is needed to run it, including locally.

The flow: a teammate runs `/plan` (optionally with text) in Slack → the bridge acks the command
and opens a **modal wizard** (`views.open`) with an **Output language** radio (English · Türkçe),
a **How big is this?** scope radio (Let Mercury judge · One ticket · A few tickets (2-5) · Large
— the requester owns the epic-ization decision, see `scope_hint` above), a **Code grounding**
radio (Full — read the code (default) · Light — skip deep code reading; see `grounding_hint`
above — Full stays the initial option because Light must be an explicit per-plan choice), and a
multiline description field (pre-filled if the slash command carried text) → on submit it calls
`POST /plan` with the chosen `output_language` + `scope_hint` + `grounding_hint` → polls `GET
/plan/{id}` → once the shape is ready it posts the skeleton tree with **Approve — write
tickets** / **Reject** buttons → a click calls `/plan/{id}/approve-shape` → once groomed it
posts the actual ticket content per item with **Create in tracker** / **Reject** buttons → a
click calls `/plan/{id}/create` → the created ticket links land in the same channel. Every
button click updates the ORIGINAL Slack message in place (replacing the buttons with a "✔
Approve by @user" context line) rather than posting a new one.

All three wizard selectors are **radio_buttons** so selections stay visible and use Slack's
documented `selected_option.value` payload shape. The leg is defensive end-to-end: extraction
logs the raw value to stderr on every submit (`wizard language
extracted: …` / `wizard scope extracted: …` / `wizard grounding extracted: …`), and a block
missing from `view.state.values` is logged loudly and falls back (`en` / `auto` / `full`)
instead of throwing. The chosen `lang:` (and a non-`auto` `scope:`, and a `grounding: light`)
render in the shape message's context line, so a mismatch is visible at the FIRST gate, when
regenerating is still cheap — and a shallow-grounded plan is never approved looking like a
deeply verified one.

Attach mode is visible at every human surface: a skeleton whose epic carries `existing_key`
renders `↷ attaches to existing <KEY>` on the shape message's header, the full-plan text file
appends `(attaches to existing <KEY>)` to its `EPIC:` line, and the ✅ created message renders
`↷ attached under <KEY>` with a browse link (the created marker carries `attached_epic`, lifted
from the record). The create-time GET only proves the key EXISTS and is an Epic — a
hallucinated-but-valid key is exactly what these renders let the approver catch.

The modal carries the slash command's channel + requester through `private_metadata` (a modal
has no channel of its own). The description may be written in Turkish or English regardless of
the output-language choice.

**The create gate renders ticket CONTENT** — the human approve-gate is the pipeline's ONLY
correctness check, so the approver must see what they are approving, not counts. Two adaptive
tiers, chosen by computed budget against Slack's hard limits (50 blocks/message, 3000
chars/section):

- **Rich** (≤ 8 items and every rendered per-item section ≤ 2900 chars): one section per item
  with the why, definition of done, acceptance criteria (up to 6, then an honest "…and N more"),
  technical-analysis prose, and every code-anchor path in backticks (paths are never truncated;
  more than 8 lists 8 + "…and N more"). Cut prose fields end in `…`; a missing field renders a
  visible `(none)`.
- **Compact** (anything bigger): one line per item — type, summary, the first ~100 chars of the
  why, and the AC/anchors/zones/effort counts — plus a context pointer at the attached file.

**Zero-anchor flag:** on a multi-item plan, an item declaring zero code anchors is flagged at
the gate (rich tier: a full `⚠ 0 anchors — no-go-zone routing not machine-checkable` line;
compact tier: a `⚠` marker on the item's line; the attached file carries the same flag) — zero
anchors is the omission that gives the deterministic zone-routing check nothing to match,
letting coupling-sensitive work render a plausible `zones: none`. The deterministic gate itself
emits the same non-blocking FLAG complaint (`internal/checks` `zone_routing`, visible in
`plan_gate.raw` via `GET /plan/{id}`); it is a flag, not a failure. One-node plans are exempt by
design.

All plan-derived text is mrkdwn-escaped (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`) at the gate
surfaces, so `<tags>` and `&` in ticket prose render literally and a hostile ask cannot smuggle
channel pings or forged links into the message.

Both tiers are additionally measured against Slack's serialized-blocks hard limit (~100K chars
of `blocks` JSON — separate from the 50-block and 3000-char caps): an over-budget rich payload
falls back to compact rendering, and an over-budget compact payload drops whole item sections
from the end, folding every dropped item into the honest "…and N more item(s)" count. The
skeleton (shape) message's fenced tree carries the same discipline — over ~2800 post-escape
chars it drops whole lines with an in-fence `… (+N more lines — full shape via GET /plan/{id})`
marker.

Either way, the bridge then uploads the **full, untruncated plan text** as a `.txt` file into
the gate message's own thread (`mercury-plan-<id8>.txt`, via Slack's external-upload flow:
`files.getUploadURLExternal` → raw bytes → `files.completeUploadExternal`). The gate message
always posts first and is never blocked by the upload; if the upload fails (missing scope,
network), the bridge logs to stderr and posts a ⚠️ thread reply pointing at `GET /plan/{id}`
instead (a `missing_scope` failure additionally names the `files:write` scope and that an admin
must add it). If the gate message itself fails to post (e.g. rejected blocks), a minimal
plain-text fallback pointer posts to the channel so the plan is never silently invisible.

> **Note**: the gate uploads a human-readable text rendering of the plan rather than the raw
> `plan.json` — strictly more legible at the gate, and the raw JSON stays available via `GET
> /plan/{id}`.

**Honest gate lines:** both approval surfaces state exactly what was — and was not —
machine-checked. The shape message's context reads `structure ✅ · correctness NOT auto-checked
— you are the reviewer` (structure is all treecheck ever verified at the skeleton stage); the
groomed message renders `structure ✅ · anchors resolve ✅` only for a present, non-skipped,
passing plan-gate result. The `MERCURY_SKIP_PLAN_ANCHORS=1` skip covers the *whole* plan gate
(structure included), so a skipped gate renders `plan gate skipped — not checked`, and a missing
gate result fails closed to `plan gate: no result — not checked` — no ✅ of any kind prints when
nothing was checked. The `correctness NOT auto-checked — you are the reviewer` tail survives in
every variant.

> **Important**: the file-upload leg requires the Slack app's bot token to carry the
> **`files:write`** OAuth scope (on top of the existing `chat:write` / `commands`). Without it
> the gate still posts and works — the bridge degrades visibly with a ⚠️ thread reply naming
> `missing_scope` and pointing at `GET /plan/{id}` for the full content.

**Retry**: a `failed` or `budget_blocked` plan posts a **🔄 Retry** button. Clicking it calls
`POST /plan/{id}/retry`, which also accepts a `budget_blocked` plan (workers re-check the
breakers on entry, so a still-capped retry re-blocks honestly). It resumes at the phase that
failed (no re-doing completed work) — the recovery for a transient failure like a provider
balance running out mid-groom.

Retry is **guarded against duplicating an already-created tree**: if the failed plan already
holds a created record (create-tree wrote real issues before the failure), retry never re-runs
the create — it re-verifies the existing record instead. A fully-created tree whose post-create
`--verify` hiccuped (network blip on the read-back) heals to `created` on a green re-read. A
*partially*-created tree (create-tree died mid-tree and persisted its partial record) stays
`failed` — a partial record verifying green only proves the recorded issues are readable, not
that the tree is complete — with the exact `node tools/create-tree.mjs --cleanup <record>
--live` command in the error text so a human can cancel the fragments. Only a record proving
zero **acknowledged** writes (or no record at all) lets retry re-enter the create phase —
create-tree journals the record write-ahead: every acknowledged issue and link write lands in
the record the moment its response arrives (verifier *comments* are not journaled — they need no
cleanup), so a response lost after the tracker committed server-side can leave at most the
single in-flight issue unrecorded (irreducible client-side). Worth knowing before cancelling: a
create that failed only at the verifier-comment step (or was killed between its last write and
exit) leaves a structurally *complete* tree that is still classified partial — eyeball the tree
first (the recorded keys are in the error text and `GET /plan/{id}`). One caveat: `--verify`
reads back cancelled issues just fine (cleanup cancels, never deletes), so Retry on a plan whose
tree was already cancelled can "heal" it to `created`, resurrecting a success message for a tree
that is actually cancelled on the board. Safe (verify never writes) but confusing: after a
failed cancel, **Cancel tree again is the right button, not Retry**. A fully `cancelled` plan is
terminal and offers neither button.

**Cancel tree** (the undo): every `created` message — and every `failed` message for a plan that
holds a created record (the surfaced partial tree, whose error text otherwise dead-ends at a CLI
`--cleanup` command) — carries a red **Cancel tree** button behind a Slack confirmation dialog
("Every ticket in this tree will be transitioned to a terminal state (cancelled/closed where
available), never deleted. This cannot be undone from Slack." / **Cancel tree** / **Keep it**). A
confirmed click calls `POST /plan/{id}/cancel` → `cancelling` → the control-plane sweep
(`create-tree.mjs --cleanup <record> --live`, no LLM, no breaker checks — an undo must never be
blocked by a spend budget) transitions every recorded issue to a terminal state (cancelled/closed
where available), children before parents, locale-aware — **nothing is ever deleted**. Success
posts a 🚫 *Tree cancelled* message (one browse link per key, no further buttons); a failed sweep
— or a sweep that could not run at all (spawn failure/timeout) — posts ⚠️ failed with the same
re-click guidance and runnable `--cleanup` command, and the created record survives every outcome
as the audit handle.

One honesty note: the cleanup tool exits `0` only when the sweep ran with **no hard failures**.
An issue whose transitions could not be read, or whose transition POST failed, counts as a hard
failure: it is logged (`⚠`/`✗`) and skipped (not retried), and any hard failure makes the sweep
exit `1` — so the plan lands `failed` with the re-click guidance, never a false `cancelled`. A
ticket already in a terminal state offers no matching transition and is skipped benignly (still
exit `0` — exactly what makes re-clicking Cancel idempotent). The per-issue results land in the
plan's `agent_summary` (`GET /plan/{id}`) — check them before assuming every ticket reached a
cancelled state.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SLACK_APP_TOKEN` | — (required) | App-level token, `xapp-…` — used at boot for `apps.connections.open` and again on every reconnect |
| `SLACK_BOT_TOKEN` | — (required) | Bot token, `xoxb-…` — used for every `chat.postMessage` / `chat.update` call |
| `MERCURY_SERVICE_URL` | `http://127.0.0.1:8090` | Base URL of the planner service (`service/server.mjs`) this bridge drives |
| `MERCURY_SERVICE_TOKEN` | unset | If the planner service has `MERCURY_SERVICE_TOKEN` set, pass the same value here so the bridge's calls carry `Authorization: Bearer <token>` |
| `MERCURY_SLACK_POLL_MS` | `7000` | How often the bridge polls `GET /plan/{id}` for every plan it's watching |

The bridge exits `1` immediately if `SLACK_APP_TOKEN` or `SLACK_BOT_TOKEN` is missing — both are
required; there is no anonymous mode.

### Boot

Two processes — the planner service, then the bridge:

```bash
set -a; . ~/.config/mercury/service.env; set +a; node service/server.mjs &
node service/slack.mjs
```

### Socket Mode specifics

- **No public URL needed.** The bridge calls `apps.connections.open` (the app-level token) to
  get a short-lived WebSocket URL, then connects outbound — Slack never needs to reach this
  process.
- **Reconnects automatically.** An unplanned socket close/error backs off exponentially (1s → 2s
  → 4s → … capped at 30s); a `{type:"disconnect"}` frame (Slack proactively cycling the
  connection) opens a fresh connection immediately and only then closes the old one, so there is
  never a gap with zero live connections. All reconnect activity is logged to stderr.
- **Every envelope is acked within Slack's 3-second budget.** Slash commands get an immediate
  ephemeral acknowledgment ("📋 Planning… I'll post the proposed shape here shortly.", or a usage
  hint if the description was empty); interactive button clicks are acked with no payload, then
  processed.
- **Boot-resume — from the STORE, not RAM.** On startup the bridge calls `GET /plans` and
  re-attaches every plan that still needs it, through **both** restart-loss windows. The bridge
  persists its reply-to as the plan's `surface` descriptor (at `POST /plan`, enriched with the
  placeholder's `message_ts` — plus a `breaking_down` cursor — once the placeholder posts, and
  refreshed on every advancing button click), and advances the `announced_status` delivery cursor
  after **each successfully delivered** status message: a failed Slack post is retried on the next
  poll rather than skipped, and the cursor never moves past what a human actually saw. On resume,
  a plan whose surface says `{type:"slack", channel}` re-watches **with its original channel**
  (Window A — the "no Slack channel on file — skipping post" orphan is dead for surfaced plans),
  and `lastStatus` seeds from the cursor, so a plan that reached ANY further status while the
  bridge was down — including a terminal `created` / `rejected` / `cancelled` — is announced
  exactly once on the first poll (Window B). A plan already announced at a watch-terminal status
  is not re-watched; legacy plans (no surface on file) keep the old behavior — no channel, a
  stderr warning instead of a guessed post, and no re-announce.

### Testing

`service/test/slack.test.mjs` exercises the envelope dispatcher, the poller, boot-resume, and
every Block Kit message builder against simple recorded-calls fakes for
`serviceFetch`/`slackFetch` — no sockets, no network, matching the rest of this service's test
suite. `service/test/slack-plan-gate.test.mjs` covers the create-gate surfaces (content tiers
and their computed budgets, the full-plan file upload leg and its degradations, honest gate
lines, `renderPlanText`); `service/test/slack-plan-gate-adversarial.test.mjs` is the QA
adversarial pass over the same surfaces (hostile/mrkdwn-injection content, exact tier
boundaries, skeleton/plan mismatches, degenerate plans, upload-failure isolation, the depends-on
divergence flag) — both in the same zero-network house pattern.
`service/test/surface-persistence.test.mjs` covers surface persistence end to end: the two
restart-loss windows driven against the real server + store with fresh bridge instances, the
resume STOP_WATCHING × cursor matrix, cursor discipline (failed posts retry; failed cursor writes
re-announce), and the `surface`/`announced_status` validation and opaque round-trip on the
service side. The socket/reconnect state machine itself is the one piece of `slack.mjs` NOT
exercised by the automated suite; operators smoke-test it when deploying with a real Slack app.
