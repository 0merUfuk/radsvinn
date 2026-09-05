# Radsvinn Task Prompt

Generate a scoped, gated manager brief for Radsvinn work.

**When to use:** starting any Radsvinn initiative or continuation.
**Output:** `tasks/task-prompts/{date}-{slug}.md` + inline loader prompt.

## Steps

1. Collect scope, tier, modules, and goal.
2. Load `CLAUDE.md`, `AGENTS.md`, relevant rules, and knowledge docs.
3. Produce the brief with §1–§18 structure.
4. End with acknowledgment sentinel: `Ready to proceed on your "go".`

## Constraints

- Never skip the acknowledgment gate.
- Never apply LIVE rigor to a DEV-only task.
- Never allow the LLM to write to the tracker.
