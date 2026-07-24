# Mercury — Hermes Project Constitution

*Version 1.0 · 2026-07-18*

Mercury is a coupling-aware AI planner: it turns a plain-language ask into a validated ticket tree through two LLM planning phases on a first-pass success (bounded gate-driven regeneration may add calls), two human approve-gates, a deterministic Go gate, a no-LLM tracker writer, and bounded spend breakers. This workspace is the **generalized, org-neutral product seed** (`github.com/0merUfuk/mercury`).

> **Standing order:** every session begins by reading this file, then `docs/ARCHITECTURE.md`, then `docs/ROADMAP.md` if the task spans more than one session.

---

## 1. What Mercury is building

A planning engine that can be trusted with real work because every place trust matters is **code and a human**, not a model's promise.

- The LLM proposes; a deterministic gate validates; a human approves twice (shape, then content).
- The LLM **never writes the tracker** — creation is a deterministic tool.
- Anchors resolve against `origin/main` git objects, never a local working tree.
- The planner is sandboxed: read-only tools, default permission mode, no shell.
- Spend is bounded per-plan and daily.

---

## 2. Deployment tiers

Apply the **strictest tier among all touched surfaces**.

| Tier | Definition | Rigor |
|---|---|---|
| **LIVE** | Running in production, serving real plans | Backward-compatible, zero-downtime, two human gates, observability first, rollback target identified |
| **STAGING** | Deployed but not prod | Same gates, may accept short-planned maintenance |
| **DEV** | Local / fake-engine / tests | Correctness and tests, no runtime ceremony |
| **DEFERRED** | Not built yet | Do not build now; document the trigger |

**Anti-over-engineering rule:** never apply LIVE rigor to a DEV-only task; never apply DEV rigor when any LIVE surface is touched.

---

## 3. Agent roster

| Agent | Model | Isolation | Use for | Never use for |
|---|---|---|---|---|
| **planner** | opus / xhigh | none | Design, ask decomposition, coupling-map reasoning, ADRs | Writing code directly |
| **strategist** | opus / high | none | Architecture, research, cross-service contracts | Implementation |
| **developer** | opus | worktree | Implementing features across `service/`, `dashboard/`, `internal/checks/`, `cmd/treecheck/` | Approving gates, merging |
| **tester** | sonnet | worktree | Tests, fake-engine scenarios, harness calibration | Modifying production code to make tests pass |
| **reviewer** | sonnet | none | Read-only quality gate, safety checks | Writing or editing files (denied at harness) |

All agents run with `permissionMode: bypassPermissions` and load project memory on start.

---

## 4. Tool allowlist doctrine

- **planner/strategist:** web search, read, grep, glob, write for ADRs only.
- **developer/tester:** read, write, edit, bash, no GitHub MCP, no web.
- **reviewer:** read, grep, glob, bash for verification only; **no Write, no Edit, no NotebookEdit**.

The reviewer is read-only-by-configuration. A false "all clear" is worse than a false alarm.

---

## 5. Context budget

Three layers, explicit spend policy:

1. **Always-on rules** — tiny, path-scoped invariants. Loaded every session; must be <500 lines total.
2. **On-demand knowledge** — deep Mercury-specific docs. Loaded only when the work shape demands it.
3. **Per-initiative state** — `tasks/{slug}/` quartet (CONTEXT, PLAN, PROGRESS, HANDOFF) for work spanning sessions.

**Context Window Protection:** never keep more than 3 source files in the main context; delegate exploration to subagents.

---

## 6. Core skills

Hermes skills live in `~/.hermes/skills/` and are invoked by name. Mercury uses:

| Skill | Purpose |
|---|---|
| `mercury-task-prompt` | Generate a scoped, gated briefing with acknowledgment sentinel |
| `mercury-continue` | Resume a session from the 4-file state quartet |
| `mercury-handoff` | Package a session for the next session or subagent |
| `mercury-doublecheck` | Run 4 adversarial passes before a gate |
| `mercury-status` | Collation health check across the repo |
| `mercury-commit` | Conventional commit slicing, no AI attribution tags |

---

## 7. Session protocol

- **Context files** (`SERVICE_CONTEXT`, `NEXT_STEPS`, `KNOWN_ISSUES`, `DECISIONS`) are read on branches, **written only on main** via follow-up PR after merge.
- **Session state** lives in gitignored `tasks/{slug}/`.
- A new initiative gets a successor directory; never retrofit the old one.
- Every task prompt ends with: `Ready to proceed on your "go".`

---

## 8. Safety invariants

1. The LLM never writes the tracker.
2. Two human gates per plan (shape, then create).
3. Deterministic gate is fail-closed.
4. Anchors resolve against `origin/main` git objects.
5. Cancel/transition only — never delete.
6. Daily spend breakers before every model call; per-plan checks before every Groom call and before a paid Phase-1 regeneration.
7. No `effort: max` anywhere.

---

## 9. Service registry

| Module | Path | Status |
|---|---|---|
| planner service | `service/` | LIVE potential |
| dashboard BFF | `dashboard/` | DEV |
| deterministic gate | `internal/checks/`, `cmd/treecheck/` | LIVE potential |
| tracker writer | `tools/create-tree.mjs` | LIVE potential |
| calibration harness | `harness/` | DEV |

---

## 10. What to do when lost

1. Read this file.
2. Read `docs/ARCHITECTURE.md`.
3. Read `docs/ROADMAP.md`.
4. Run `mercury-status` skill.
5. If still lost, write a handoff file and stop.
