# Mercury — Agent Constitution (Codex / AGENTS.md format)

*Version 1.0 · 2026-07-18 · twin to `CLAUDE.md`*

This document is the same operating model as `CLAUDE.md`, written in the language of OpenAI Codex CLI. Use it when working in Mercury with Codex.

---

## Project identity

Mercury is a coupling-aware AI planner that turns a plain-language ask into a validated ticket tree. The LLM proposes; a deterministic Go gate validates; a human approves twice. The LLM **never writes the tracker**.

This repo is the **org-neutral product seed**: `github.com/0merUfuk/mercury`.

---

## Agent roster

| Agent | Model | Isolation | Responsibility | Denial |
|---|---|---|---|---|
| `planner` | `claude-opus-4-8` / `effort: high` | none | Ask decomposition, coupling-map reasoning, ADRs | Implementation |
| `strategist` | `claude-opus-4-8` / `effort: high` | none | Architecture, research, cross-service contracts | Implementation |
| `developer` | `claude-opus-4-8` / `effort: medium` | worktree | Feature work in `service/`, `dashboard/`, `internal/checks/`, `cmd/treecheck/` | Gate approval |
| `tester` | `claude-sonnet-5` | worktree | Tests, fake-engine scenarios, harness calibration | Modifying prod code for tests |
| `reviewer` | `claude-sonnet-5` | none | Read-only quality gate | Write/Edit/NotebookEdit |

**No `effort: max` anywhere.**

---

## Rules (auto-loaded)

Rules are tiny, path-scoped, and live in `.codex/rules/`. They state invariants only; deep examples live in `.codex/knowledge/`.

1. `session-protocol.md` — context files read on branches, written on main.
2. `node-services.md` — invariants for `service/` and `dashboard/`.
3. `go-services.md` — invariants for `internal/checks/` and `cmd/treecheck/`.
4. `safety-spine.md` — the seven safety invariants.

---

## Knowledge (on demand)

- `coupling-map.md` — how to read and maintain `coupling-map.yaml`.
- `go-gate.md` — the deterministic gate and `treecheck` CLI.
- `node-engine.md` — planner service, state machine, spend breakers.
- `prompt-injection.md` — sandbox posture and child-env credential deny-set.
- `tracker-writer.md` — `create-tree.mjs` contract and cancel semantics.

---

## Skills

Codex skills live in `.codex/skills/` and are also exposed as `.codex/commands/`.

- `task-prompt` — briefing factory with acknowledgment gate.
- `continue` — resume from the state quartet.
- `handoff` — package session state.
- `doublecheck` — adversarial verification.
- `status` — health collation.
- `commit` — conventional commit slicing.

---

## Memory

Per-agent memory lives in `.codex/agent-memory/`.

- `planner/` — flat `MEMORY.md` for orchestration state.
- `reviewer/` — `MEMORY.md` index + per-incident `feedback_*.md`.
- `strategist/` — `MEMORY.md` index + backing files.
- `developer/`, `tester/` — empty by design.

Do **not** store project status in memory; use the `tasks/{slug}/` quartet.

---

## Session protocol

1. Read `CLAUDE.md` or `AGENTS.md` first.
2. Acknowledge every loaded rule, knowledge doc, and skill in the first response.
3. Wait for the human's `go` before implementation.
4. Update `PROGRESS.md` after every meaningful action.
5. Write context files only on main via follow-up PR.

---

## Safety invariants

1. The LLM never writes the tracker.
2. Two human gates per plan (shape, then create).
3. Deterministic gate is fail-closed.
4. Anchors resolve against `origin/main` git objects.
5. Cancel/transition only — never delete.
6. Spend breakers before every model call.
7. No `effort: max` anywhere.
