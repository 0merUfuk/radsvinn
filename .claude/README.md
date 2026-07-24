# Mercury `.claude/` Ecosystem

*Version 1.0 · 2026-07-18*

This directory is the Claude Code-native agent operating system for the generalized Mercury product seed. It mirrors the same roles, rules, skills, and memory architecture as the Hermes and Codex ecosystems, expressed in Claude Code's native format.

## Contents

| Path | What |
|---|---|
| `agents/` | 6 agents with model/tool/memory frontmatter |
| `rules/` | Auto-loaded, path-scoped invariants |
| `skills/` | Reusable slash-command skills |
| `knowledge/` | On-demand deep docs |
| `agent-memory/` | Per-agent memory directories |
| `services/` | Mercury module registry |
| `templates/` | Handoff / state / source-context / quality-gates templates |

## Agent roster

- `planner.md` — orchestrator
- `strategist.md` — architecture/research
- `developer.md` — implementation
- `tester.md` — verification
- `reviewer.md` — read-only gate

## Maintenance cadence

This ecosystem is consumed by every Claude Code session in Mercury. Staleness hurts the reader: a wrong rule produces wrong code, a stale skill generates bad briefs. Therefore it must be refreshed.

- After every merged PR that changes architecture: update `knowledge/`, `services/`, and the relevant rule.
- After every significant incident or near-miss: the `reviewer` agent writes a `feedback_*.md` in `agent-memory/reviewer/`.
- Monthly: run a `/status` pass and update `README.md` if counts drift.
- Never let a `.codex/` mirror exist without a documented sync cadence — see `../.codex/README.md`.

## Quick start

Open Claude Code in this repo. It loads:
1. Root `CLAUDE.md` / `AGENTS.md`
2. `.claude/rules/*.md` matching the current path
3. The agent's `.claude/agent-memory/{agent}/MEMORY.md`

Invoke a skill with `/task-prompt`, `/continue`, `/handoff`, `/doublecheck`, `/status`, `/commit`.
