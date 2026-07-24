---
name: mercury-doublecheck
title: Mercury Adversarial Verification
description: Run four orthogonal adversarial passes before a Mercury gate.
version: 1.0
---

# Mercury Doublecheck

Before any human gate or merge, run four adversarial passes. "Looks good" is forbidden.

## The four passes

1. **Gap Finder** — todo list vs diff completeness; are there claimed-but-unimplemented items?
2. **Assumption Attacker** — nil/empty/failure paths; stack-specific tells (Go `_` discards, unawaited async, missing error checks).
3. **Ground Truth Verifier** — actually run `go build ./...`, `go test ./...`, `node --test`, and greps. Trust only `origin/main` git objects, never local trees.
4. **Devil's Advocate** — most probable production failure: DB down, timeout, race, restart, empty list, permission drift.

## Procedure

1. Spawn each pass as a separate `delegate_task` with a focused charter.
2. Collect findings.
3. Convert numeric confidence bands to verdicts:
   - 95–100: SHIP
   - 80–94: FIX FIRST
   - <60: REDESIGN
4. Re-run only the failed pass after fixes.
5. Produce a verdict table.

## Verdict table

| Pass | Confidence | Verdict | Key finding |
|---|---|---|---|
| Gap Finder | ... | SHIP / FIX / REDESIGN | ... |
| Assumption Attacker | ... | ... | ... |
| Ground Truth Verifier | ... | ... | ... |
| Devil's Advocate | ... | ... | ... |

## What NEVER to do

- Say "looks good" without producing findings.
- Trust an agent's claim without re-running the real command.
- Skip the tree re-verification after a reviewer run.
