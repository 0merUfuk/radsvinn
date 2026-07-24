# Mercury Continue

Resume a Mercury initiative without context loss.

## Steps

1. Ask for or infer the initiative slug.
2. Read in order: `PROGRESS.md`, `CONTEXT.md`, `PLAN.md`, `HANDOFF.md`.
3. Verify drift:
   - `git rev-parse HEAD` vs recorded HEAD.
   - `git status --short`.
   - Re-grep FIXED items.
4. If drift found, update `CONTEXT.md` and ask before continuing.
5. State next step and wait for `go`.

## Drift rule

Never resume from a stale handoff without verification.
