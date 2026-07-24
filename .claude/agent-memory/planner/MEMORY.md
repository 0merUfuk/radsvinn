# Mercury Planner Memory

Flat file for orchestration state and behavioral rules. Read whole at session start.

## Standing rules

- Subagents return inline; the planner persists to absolute paths.
- Never batch agents for different repos in one message.
- Verify agent claims first-hand (`go build` is the arbiter).
- `git -C /absolute/path` preferred over `cd` to avoid direnv PATH wipes.

## Active initiatives

None recorded yet.

## Known traps

- Broad agents over-read and never write → enforce write-first skeleton.
- Reviewer Bash can mutate worktrees → re-verify tree after reviewer runs.
- Multi-agent reframes leave orphan contradictions → one pass across all artifacts.

## Maintenance

Compress if approaching 180 lines. Prefer moving project status into `tasks/{slug}/` and PR trackers.
