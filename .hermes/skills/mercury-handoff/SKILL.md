---
name: mercury-handoff
title: Mercury Session Handoff
description: Package a Mercury session into a continuation-ready handoff with claims to verify.
version: 1.0
---

# Mercury Handoff

Package the current Mercury session so the next session or subagent can resume without re-deriving state.

## Output files

- `tasks/{slug}/HANDOFF.md`
- Optional: `tasks/session-handoff-{slug}-{date}.md`

## Structure

```markdown
# Handoff — {slug} · {date}

## §0 Recovery command
After compaction: cat tasks/{slug}/{PROGRESS,CONTEXT}.md && read PLAN.md

## §1 Current position
- HEAD: {sha}
- Git status: {clean / list of files}
- Last completed step: ...
- Next step: ...

## §2 DONE
- [ ] ...

## §3 PENDING-{owner}
- ...

## §4 FIXED — do NOT re-do
- ...

## §5 OPEN PROBLEMS
1. ...

## §6 Constraints restated
- ...

## §7 Verification commands
```bash
git rev-parse HEAD
git status --short
# load-bearing greps
```
```

## Loader prompt

Produce a 20–40 line paste-able prompt the next session uses to resume. It must:
1. List required reading.
2. State the recovery command.
3. Demand drift verification before work.
4. End with `Ready to proceed on your "go".`

## What NEVER to do

- Hand off without recording HEAD and git status.
- Leave FIXED items ambiguous.
- Skip the recovery command in the file header.
