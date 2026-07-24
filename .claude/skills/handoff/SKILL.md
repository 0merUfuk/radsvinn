# Mercury Handoff

Package the current session for the next session or subagent.

## Output

- `tasks/{slug}/HANDOFF.md`
- Optional: `tasks/session-handoff-{slug}-{date}.md`

## Sections

1. §0 Recovery command.
2. §1 Current position (HEAD, status, last step, next step).
3. §2 DONE.
4. §3 PENDING-{owner}.
5. §4 FIXED — do NOT re-do.
6. §5 OPEN PROBLEMS.
7. §6 Constraints restated.
8. §7 Verification commands.

## Loader prompt

Produce a 20–40 line paste-able prompt that lists required reading, states the recovery command, demands drift verification, and ends with `Ready to proceed on your "go".`.
