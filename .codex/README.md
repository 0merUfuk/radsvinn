# Mercury `.codex/` Ecosystem

*Version 1.0 · 2026-07-18*

This directory is the OpenAI Codex CLI companion to `.claude/`. It contains the same agent operating system for Mercury, rendered in Codex-native formats:

- `agents/*.toml` — role definitions
- `rules/*.md` — always-on invariants
- `skills/` + `commands/` — reusable workflows (dual-targeted so Codex can load them as both project skills and slash commands)
- `templates/` — handoff/state/source-context/quality-gates
- `agent-memory/` — per-agent memory
- `references/knowledge-map.md` — pointer to `.claude/knowledge/` as source-of-truth

## Important

**This mirror will rot if not maintained.** The canonical knowledge docs live in `.claude/knowledge/`. The canonical rules live in `.claude/rules/`. Updates must flow here or this ecosystem becomes dangerous stale guidance.

## Sync cadence

- After every change to `.claude/agents/`, `.claude/rules/`, or `.claude/skills/`, reconcile `.codex/`.
- Keep a changelog in `references/sync-log.md`.
- If this mirror falls more than 2 weeks behind `.claude/`, stop using it until reconciled.

## Agent roster

- `planner.toml` — orchestrator
- `strategist.toml` — architecture/research
- `developer.toml` — implementation
- `tester.toml` — verification
- `reviewer.toml` — read-only gate

## Maintenance rule

`README.md` rot is the leading cause of stale mirrors. Update this file when agent/rule/skill counts change.
