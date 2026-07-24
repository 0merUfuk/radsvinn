# Mercury Doublecheck

Run four adversarial passes before any human gate. "Looks good" is forbidden.

## Passes

1. **Gap Finder** — todo vs diff completeness.
2. **Assumption Attacker** — nil/empty/failure paths; Go `_` discards, unawaited async.
3. **Ground Truth Verifier** — run the real commands; trust `origin/main` git objects only.
4. **Devil's Advocate** — DB down, timeout, race, restart, empty list, permission drift.

## Verdict bands

- 95–100: SHIP
- 80–94: FIX FIRST
- <60: REDESIGN

Re-run only the failed pass after fixes.
