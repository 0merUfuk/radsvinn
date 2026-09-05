# Radsvinn Handoff (Codex)

Package the current session.

Output `tasks/{slug}/HANDOFF.md` with:
- §0 Recovery command.
- §1 Current position.
- §2 DONE.
- §3 PENDING-{owner}.
- §4 FIXED — do NOT re-do.
- §5 OPEN PROBLEMS.
- §6 Constraints restated.
- §7 Verification commands.

Also produce a 20–40 line loader prompt.

Command alias: `radsvinn-handoff`.
