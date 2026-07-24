---
name: mercury-commit
title: Mercury Conventional Commit Slicer
description: Slice Mercury changes into conventional commits with mandatory preview, no AI attribution tags.
version: 1.0
---

# Mercury Commit

Slice changes into clean, conventional commits. Mercury is a product repo; its history is a changelog.

## Procedure

1. Run `git status` and `git diff --stat`.
2. Group changes by concern (not by file type):
   - `feat(planner): ...`
   - `feat(gate): ...`
   - `fix(dashboard): ...`
   - `docs: ...`
   - `test: ...`
   - `chore: ...`
3. For each group, write a commit message with:
   - Type/scope header
   - Body explaining *why* the change, not what
   - No AI attribution tags (no "Co-authored-by: Claude")
4. Show the user a preview of each commit (files + message).
5. On approval, stage and commit one by one.

## Scope convention

| Scope | Use for |
|---|---|
| `planner` | `service/` changes |
| `dashboard` | `dashboard/` changes |
| `gate` | `internal/checks/`, `cmd/treecheck/` |
| `tracker` | `tools/create-tree.mjs` |
| `harness` | `harness/` |
| `docs` | `docs/`, `README.md` |
| `agent` | `.claude/`, `.codex/`, `CLAUDE.md`, `AGENTS.md` |

## What NEVER to do

- Run `git add -A` blindly.
- Add AI attribution tags.
- Squash unrelated concerns.
- Commit without preview.
