# Mercury — Frequently Asked Questions

*The doc between the [README](../README.md) (30 seconds) and
[docs/ARCHITECTURE.md](ARCHITECTURE.md) (the full design-of-record). Read this if you read the
README, got intrigued, and want the whole thing explained in one screen.*

---

## What does Mercury do?

Mercury turns a plain-language work request ("add prompt-text search to the history view")
into a validated tree of Jira tickets — an epic, its stories, their sub-tasks — each with a
why, a definition of done, acceptance criteria, and verified code anchors. It grounds itself
in your actual codebase, knows which changes are *coupled* (a database column three services
write to; a producer that must ship before its consumer), and orders the tree so the work is
safe to execute.

The LLM proposes. A deterministic Go gate validates. A human approves twice. Only then does a
no-LLM tool write to your tracker. That separation is the whole point.

---

## How does a plan flow through Mercury?

On a first-pass success, one plan has two model phases and two human gates. A gate failure can
send either model phase through bounded regeneration, so a run may make more than two model
calls:

1. **Break-Down** — a fresh agent session reads your ask + coupling map, greps the grounding
   repos, proposes a skeleton tree.
2. **Deterministic SKELETON gate** — structure, hierarchy, ordering, sizing checked by compiled
   Go. Fail → bounded regeneration against the machine's complaint (max 2), never a silent
   bad tree.
3. **HUMAN GATE 1 — approve the shape.** Approve, edit, or reject.
4. **Groom** — the agent resumes the same session, writes the 5 fields per ticket + verified
   code anchors.
5. **Deterministic PLAN gate** — fields, single-repo, anchors resolve against `origin/main`,
   coupling-zone routing, sizing. Plus an advisory duplicate search.
6. **HUMAN GATE 2 — approve the groomed tree.**
7. **Create** — a deterministic tool (no LLM) creates the tree in your tracker, then verifies
   it.

Request-driven phase starts and terminal human actions are persisted through a
compare-and-swap before the response, so racing clicks cannot double-fire a phase or resurrect
a rejected plan. Background workers persist their own progress and terminal state updates.

---

## Why two model phases and not one?

Because the shape and the content have different quality/cost profiles. **Decompose** produces
the shape — cheap to be wrong (the human shape gate rejects a bad shape for ~the phase-1 cost
alone). **Groom** writes the 5 fields, the verified code anchors, and the coupling-zone routing —
expensive to be wrong (it is what the create gate approves). Mercury lets each seat pick its
own Claude model/effort (`MERCURY_AGENT_MODEL_DECOMPOSE` / `_GROOM`) so you can run a
cheaper/faster model on decompose and the strongest one on groom.

---

## What stops the LLM from writing garbage to my tracker?

Three layers, in order:

1. **The LLM never writes the tracker.** Creation is a deterministic tool
   (`tools/create-tree.mjs`) operating on a human-approved plan. No model output reaches your
   board unreviewed.
2. **The deterministic gate is fail-closed.** Structure, ordering, sizing, coupling-zone
   routing, and anchor existence are checked by compiled Go, not by trusting the model. A hard
   failure blocks.
3. **Two human gates** bracket the two model phases. The human is the correctness authority; the
   machine's job is to make sure the human sees exactly what they're approving.

---

## What if the LLM hallucinates a code anchor?

Every code anchor (`repo:path[:symbol]`) is verified by the Go gate against `origin/main` git
objects — not a local working tree. A ticket cannot cite code that isn't on the mainline. If
the agent names a symbol, the gate checks it appears in the file (a lenient substring match
today, WARN-first — a hard fail is a documented promotion path once a baseline shows symbols
are reliably present). A missing anchor is a hard block.

---

## How does Mercury handle cost?

Three breakers bound model work:

- **Per-plan budget** (`MERCURY_PLAN_BUDGET_USD`, default $10) — checked before every Groom
  call and, once spend exists, before Phase-1 regeneration. A blocked plan is retryable and
  the blocked attempt is not charged.
- **Daily hard cap** (`MERCURY_DAILY_HARD_USD`, default $100) — blocks all new LLM work when
  hit; checked before every model call and resets at UTC midnight.
- **Daily soft cap** (`MERCURY_DAILY_SOFT_USD`, default $50) — checked before every model
  call, warns once per boot, and continues.

Create is a deterministic control-plane operation with no model call, so it has no
model-spend check.

Cost is tracked in **integer nanodollars** (1e9 per USD) so a sub-cent charge cannot disappear
in rounding. When Mercury runs through OpenRouter, a local proxy reconciles every generation
receipt against the provider's API — Claude Code's own cost estimate is deliberately not used.

---

## Can I run Mercury without Slack?

Yes. The planner is an HTTP API (`service/server.mjs`). The Slack bridge
(`service/slack.mjs`) is one client; the dashboard BFF (`dashboard/`) is another. You can drive
the whole pipeline with `curl`; the README quickstart's `make demo` command drives that same
HTTP lifecycle in fake mode.

---

## What is the dashboard?

A web review surface — a GitHub-OAuth BFF over the planner API. It gives you:

- **GitHub login** with PKCE + org-membership gating (your org, your teams).
- **RBAC** — four roles mapped from GitHub team membership: `viewer` (read), `planner` (submit
  / reject / retry), `approver` (approve shape), `creator` (create / cancel). The route table,
  not the UI, is the control.
- **CSRF** in four layers: SameSite=Lax cookies, Origin check, per-session CSRF header, and a
  named confirm string on the two heavy actions (create / cancel).
- **Rate limits** per session and per IP, with a separate stricter budget for plan creation.
- A static SPA shell — the client fetches `/api/session` and renders the plan tree.

The dashboard is optional and runs as a separate process. See
[dashboard/README.md](../dashboard/README.md).

---

## What happens if Mercury crashes mid-plan?

On boot, the state store replays every persisted plan. Any plan caught in a transient status
(`breaking_down`, `grooming`, `creating`, `cancelling`) is honestly reloaded as `failed` with
`error: "interrupted by restart"` — no zombie workers, no silent resume of a call that never
finished. The Slack bridge re-watches every non-terminal plan from the store and announces
anything past its delivery cursor, so a bridge that dies mid-plan does not orphan the message
thread.

---

## What does "cancel" do?

Cancel transitions every issue in a created tree to a terminal state (cancelled/closed where
available; children before parents), locale-aware. **It never deletes.** The record of what was
cancelled is kept as an audit handle. Re-clicking cancel is safe — Jira offers no transition
into a state an issue is already in, so already-terminal issues are benignly skipped.

---

## What model does Mercury use?

The runtime default is the floating Claude CLI alias `opus` at `effort: xhigh`; v0.1.0 does
not pin that alias to an exact model ID. The planner is a sandboxed `claude -p` child with
read-only tools (`Read`, `Grep`, `Glob`), default permission mode, no shell — untrusted
request text cannot escalate into command execution. A non-Claude model enters only when
`MERCURY_LLM_PROVIDER=openrouter` explicitly selects the OpenRouter metering proxy, which
reconciles every receipt; setting its API key alone does not switch providers.

---

## Is Mercury multi-tenant?

No. Mercury is single-tenant, self-hosted, bring-your-own-model-key. Multi-tenancy is an
explicit opt-in later milestone (R7) gated on demand — the roadmap warns against building
multi-tenant SaaS scaffolding before a design partner has pulled for it. The deployment shape
is design-partner-first on a self-hostable open-core base.

---

## Can I run it right now without any API keys?

Yes. The deterministic fixture replay drives the production HTTP handlers and state machine,
both real Go gates, and both human actions. It validates anchors against temporary local
`origin/main` refs; the walkthrough itself opens only loopback HTTP and makes no model,
tracker, or remote-grounding calls. On a cold Go module cache, the Go toolchain may download
the repository's declared build dependencies before the checker starts. With Node 22+, Go
1.25+, and Git installed:

```bash
make demo
```

See the [README quickstart](../README.md#quickstart) for the full end-to-end.

---

## What's next for Mercury?

The [roadmap](ROADMAP.md) has the full picture. The short version: the generalization spine
(R1 config spine → R2 de-freeze vocabulary → R3 neutralize prompts → R4 coupling-map generator)
makes Mercury organization-independent. The reliability track adds admission control, a
skeleton-⊆-plan coverage gate, and real-engine smoke tests. The executor (approved tickets →
draft PRs) is a future iteration, hard-gated behind its own preconditions.
