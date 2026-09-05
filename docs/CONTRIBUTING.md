# Contributing to Radsvinn

*Version 1.0 · 2026-07-18*

Radsvinn is a coupling-aware AI planner. The LLM proposes; the Go gate validates; a human approves twice. This document is the on-ramp for code contributors.

## Table of contents

1. [What we optimize for](#what-we-optimize-for)
2. [Getting started](#getting-started)
3. [Agent workflow](#agent-workflow)
4. [Quality gates](#quality-gates)
5. [Commit conventions](#commit-conventions)
6. [Where to get help](#where-to-get-help)

## What we optimize for

1. **Correctness over speed.** A slow green gate is better than a fast broken deploy.
2. **Org-neutrality.** No source-organization names, project keys, cloud IDs, laptop paths, or service topologies in product-facing files.
3. **Determinism where it matters.** The gate is code; the LLM is proposal only.
4. **Human gates.** Two approval points per plan: shape, then create.

## Getting started

```bash
git clone https://github.com/0merUfuk/radsvinn.git
cd radsvinn
make demo
make check
```

See `docs/GETTING-STARTED.md` for environment setup and `docs/ARCHITECTURE.md` for system design.

## Agent workflow

Radsvinn development is designed for multi-agent tools. The canonical roles are:

| Role | Responsibility | Model tier | Denial |
|---|---|---|---|
| `planner` | Orchestrator, durable state | High | Implementation |
| `strategist` | Architecture, ADRs | High | Implementation |
| `developer` | Code in worktree | High | Gate approval |
| `tester` | Tests, fake engine | Medium | Prod-code patches |
| `reviewer` | Read-only quality gate | Medium | Write/Edit |

Agents are defined natively for each tool:
- Hermes: root `CLAUDE.md`/`AGENTS.md` + Hermes skills `radsvinn-*`
- Claude Code: `.claude/agents/*.md`
- Codex: `.codex/agents/*.toml`

## Quality gates

Before any change is considered done:

1. **Self-check** — run the relevant tests locally.
2. **Doublecheck** — four adversarial passes (gap finder, assumption attacker, ground truth verifier, devil's advocate).
3. **Reviewer** — a read-only agent re-runs commands and verifies claims.
4. **CI** — component test jobs and the public-hygiene job (`make public-scan`) must pass;
   run the integrated `make check` locally before release.
5. **Human approval** — required for plan shape and tracker creation.

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<scope>: <subject>

<body>
```

Allowed scopes: `planner`, `dashboard`, `gate`, `tracker`, `harness`, `docs`, `agent`, `contracts`, `coupling`.

Do not add AI attribution tags.

## Where to get help

- Architecture questions → `docs/ARCHITECTURE.md`
- Runtime commands → `docs/OPERATIONS.md`
- Coupling map → `.claude/knowledge/03-coupling-map.md`
- Agent ecosystem → `.claude/README.md`
