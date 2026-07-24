---
name: port-agent-ecosystem
title: Port Agent Ecosystem Across AI Coding Tools
description: Synthesize a project's agent ecosystem into Hermes, Claude Code, and Codex native formats from portable know-how capture cards.
version: 1.0
---

# Port Agent Ecosystem

Synthesize an agent operating system for a target project, producing three native renderings:
- **Hermes**: root `CLAUDE.md`/`AGENTS.md` + Hermes skills under `~/.hermes/skills/`
- **Claude Code**: `.claude/` tree (agents, rules, skills, knowledge, memory, services, templates)
- **Codex**: `.codex/` tree (TOML agents, rules, skills, commands, templates, references)

## When to use

The target project already has a credible scope (services, deployment tiers, a manifest) and needs a durable, multi-agent development layer. Do NOT use this for a one-off script or a pre-launch single-file app.

## Inputs

- Source know-how: `knowledge-preservation/cards/` + `know-how-extraction/reports/`
- Target project path
- Forbidden namespaces (organization names, project keys, laptop paths, cloud IDs, product domain lore that must not leak)
- Target project stack and module list

## Procedure

1. **Audit the target project.** Read `README.md`, package manifest, service layout, existing context files. Do not design blind.
2. **Size the roster.** Before designing a 5-role roster, ask: **how many services, how many live users, what deployment tier?** The full fleet (manager/planner + strategist + developer + tester + reviewer, 5+ skills, `.claude/` + `.codex/` twins, per-agent memory dirs) is earned by a polyrepo of 4+ services serving production traffic. An MVP, a personal tool, or a pre-launch app does NOT earn that ceremony.
3. **Build the shared semantic model.** Define: constitution, roles + denials, rules, skills, knowledge docs, memory scheme, templates, service registry. Write it tool-agnostically first.
4. **Render Hermes first.** Root `CLAUDE.md`/`AGENTS.md` plus skills in `~/.hermes/skills/{project}-*`. Hermes is the runtime you are in now; it must work.
5. **Render Claude Code.** `.claude/` tree. Use the source cards for format conventions.
6. **Render Codex.** `.codex/` tree. Mirror the same semantic model. Keep `.codex/references/knowledge-map.md` pointing at `.claude/knowledge/` so deep docs have one source of truth.
7. **Neutralize.** Strip every forbidden namespace. Replace with placeholders: `example-org`, `EXAMPLE`, `example.atlassian.net`, `00000000-0000-0000-0000-000000000000`, `../source-workspace`, `example-zone`.
8. **Verify.** Run forbidden-term grep, syntax checks (TOML, JSON, Go), and the target project's test suite.
9. **Package for installability.** Copy Hermes skills into the target repo under `.hermes/skills/` so the repo is self-contained, while keeping `~/.hermes/skills/` as the active runtime copy.

## Agent roster template

| Role | Responsibility | Denial |
|---|---|---|
| planner/manager | Orchestrator, durable state, dispatch | Implementation |
| strategist | Architecture, research, ADRs | Implementation |
| developer | Feature work in worktree | Gate approval |
| tester | Tests, fake-engine scenarios | Modifying prod code for tests |
| reviewer | Read-only quality gate | Write/Edit |

## Permanent role exclusion (owner directive)

Apply any owner-specified permanent role exclusions with zero trace:
1. Do not create the excluded role's agent file in any runtime.
2. Do not list it in any roster table.
3. Do not create its memory directory.
4. Grep the output tree for the excluded role name; any hit is a blocker.

Record specific excluded roles in your user memory, not in the ported ecosystem files.

## Artifacts

| Artifact | Hermes | Claude Code | Codex |
|---|---|---|---|
| Constitution | `CLAUDE.md` + `AGENTS.md` at target root | Injected by Hermes Project; read by Claude Code; optional Codex twin | Optional `.codex/README.md` + `AGENTS.md` |
| Agent roster | `delegate_task` patterns in prompts | `.claude/agents/*.md` | `.codex/agents/*.toml` |
| Rules | `AGENTS.md` rules section | `.claude/rules/*.md` | `.codex/rules/*.md` |
| Skills | `~/.hermes/skills/{project}-*` + `.hermes/skills/` in repo | `.claude/skills/*/SKILL.md` | `.codex/skills/*/SKILL.md` + `.codex/commands/*.md` |
| Knowledge | root docs + skills | `.claude/knowledge/*.md` | `.codex/references/knowledge-map.md` → `.claude/knowledge/` |
| Memory | `memory` tool | `.claude/agent-memory/{role}/MEMORY.md` | `.codex/agent-memory/{role}/MEMORY.md` |
| Templates | skills | `.claude/templates/*.md` | `.codex/templates/*.md` |

## Anti-patterns

- Do not copy raw source-org files; synthesize.
- Do not leave real org names, project keys, cloud IDs, or laptop paths.
- Do not build a `.claude/` or `.codex/` tree without an equivalent Hermes layer.
- Do not let `.codex/` drift from `.claude/`; keep a sync log.
- Do not build the full 5-agent fleet for a pre-launch MVP.
- Do not put project status in agent memory.
