---
name: session-protocol
paths: []
---

# Session Protocol

Context files (`SERVICE_CONTEXT.md`, `NEXT_STEPS.md`, `KNOWN_ISSUES.md`, `DECISIONS.md`) are **read on branches, written only on main** via follow-up PR after merge.

Session-local noise goes to gitignored `tasks/{slug}/`.

## Why

1. Prevents a feature branch from asserting a state that never shipped.
2. Avoids merge conflicts in append-heavy shared files.
3. Keeps handoff corruption out of incoming agent sessions.

## Trigger

After merging any PR that changes durable context, open a follow-up PR on `main` updating the context files.

## Failure mode

If context files are not updated, every future session starts from stale memory and will re-derive or contradict reality.
