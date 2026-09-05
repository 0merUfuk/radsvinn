---
name: radsvinn-task-prompt
title: Radsvinn Task Prompt Generator
description: Generate a scoped, gated manager brief for Radsvinn work with mandatory acknowledgment sentinel.
version: 1.0
---

# Radsvinn Task Prompt

Generate a scoped, gated manager brief. Output to `tasks/task-prompts/{date}-{slug}.md`.

## Inputs

- Scope class: low / medium / high / max
- Highest deployment tier touched: LIVE / STAGING / DEV / DEFERRED
- Modules affected: `service/`, `dashboard/`, `internal/checks/`, `cmd/treecheck/`, `tools/`, `harness/`, `docs/`, `contracts/`
- Goal: one sentence naming the failure mode if done wrong

## Required reading

1. `CLAUDE.md`
2. `AGENTS.md`
3. Module-specific `SERVICE_CONTEXT.md` or `.claude/templates/SERVICE_CONTEXT_*.md`
4. Relevant rules from `.claude/rules/` or `AGENTS.md`
5. Knowledge floor: `00-core-principles.md`, `02-go-gate.md`, `03-coupling-map.md`

## Sections

1. **Header** — date, scope, tier, modules
2. **§1 Identity & Standing Orders** — which agent role is acting; explicit denials
3. **§2 Acknowledgment Gate** — mandatory sentinel: `Ready to proceed on your "go".`
4. **§3 Goal** — failure-mode named
5. **§4 Required Reading** — rules + docs
6. **§5 Scope Table** — in-scope / out-of-scope / deferred
7. **§6 Quality Bar** — tier-scaled: DEV = fake-engine green; STAGING = gate + manual; LIVE = all of the above + doublecheck + reviewer
8. **§7 Constraints** — no tracker writes, no merges, two human gates
9. **§8 Agent Fan-Out** — which subagents to use
10. **§9 Definition of Done** — observable outputs
11. **§10 Open Questions** — explicit unknowns
12. **§11 State Files** — `tasks/{slug}/` files to maintain
13. **§12 Verification Commands** — exact commands to run
14. **§18 First-Response Format** — how the agent must reply

## Agent fan-out table

| Subagent | Use when |
|---|---|
| strategist | architecture or research needed |
| developer | implementation in a module |
| tester | tests, fake-engine scenarios |
| reviewer | before any human gate |

## Constraints

- Never skip the acknowledgment gate.
- Never apply LIVE rigor to a DEV-only task.
- Never allow the LLM to write to the tracker or merge a PR.
- No `effort: max` anywhere.
