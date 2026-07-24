---
name: mercury-continue
title: Mercury Session Continuation
description: Resume a Mercury session from the state quartet with drift verification.
version: 1.0
---

# Mercury Continue

Resume a Mercury initiative without context loss. Use when a previous session ended or compaction occurred.

## Procedure

1. Ask the user (or read `tasks/{slug}/PROGRESS.md`) for the initiative slug.
2. Read in fixed order:
   - `tasks/{slug}/PROGRESS.md`
   - `tasks/{slug}/CONTEXT.md`
   - `tasks/{slug}/PLAN.md`
   - `tasks/{slug}/HANDOFF.md`
3. Run drift verification:
   - `git rev-parse HEAD` vs the last recorded HEAD in HANDOFF.md
   - `git status --short` must be clean or match the recorded state
   - Re-grep any load-bearing symbols the HANDOFF claims are FIXED
4. If drift is found, update CONTEXT.md and ask the project owner before continuing.
5. State the next step from PROGRESS.md and wait for `go`.

## Output

- Brief summary of where the initiative stands.
- Drift status.
- Next step.
- `Ready to proceed on your "go".`

## What NEVER to do

- Continue from a stale handoff without verification.
- Re-fix anything listed as FIXED in HANDOFF.md.
- Begin work before the user says `go`.
