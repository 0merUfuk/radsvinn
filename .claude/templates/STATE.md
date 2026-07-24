# Mercury State Template

Starting shape for per-initiative state files in `tasks/{slug}/`.

## CONTEXT.md

```markdown
# CONTEXT — {slug} (compaction anchor)

Single writer: manager/planner.
PRECEDENCE: where this conflicts with the blueprint, this wins (verified against current main).

## Verified facts
-

## Errata
-

## Contract matrix
-

## Load-bearing gotchas
-
```

## PLAN.md

```markdown
# PLAN — {slug}

Authority: the project owner decides architecture; agent decides implementation details.

## Phases
| # | Phase | Gate | Owner |
|---|---|---|---|
| 1 | ... | human | ... |

## Invariants
- ...
```

## PROGRESS.md

```markdown
# PROGRESS — {slug}

After compaction: `cat tasks/{slug}/{PROGRESS,CONTEXT}.md && read PLAN.md`

## Current
-

## Last step
- ... (with SHA)

## Next step
-

## Blockers
-
```

## HANDOFF.md

See `HANDOFF.md` template.
