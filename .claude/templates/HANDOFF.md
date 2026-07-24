# Mercury Handoff Template

Use this as the starting shape for `tasks/{slug}/HANDOFF.md` and `tasks/session-handoff-*.md`.

## §0 Recovery command
After compaction: `cat tasks/{slug}/{PROGRESS,CONTEXT}.md && read PLAN.md`

## §1 Current position
- HEAD:
- Git status:
- Last completed step:
- Next step:

## §2 DONE
- [ ]

## §3 PENDING-{owner}
- ...

## §4 FIXED — do NOT re-do
- ...

## §5 OPEN PROBLEMS
1.

## §6 Constraints restated
- ...

## §7 Verification commands
```bash
git rev-parse HEAD
git status --short
```
