# Mercury Task Prompt (Codex)

Generate a scoped, gated manager brief. Output to `tasks/task-prompts/{date}-{slug}.md`.

Sections:
1. Header — scope, tier, date, modules.
2. §1 Identity & Standing Orders.
3. §2 Acknowledgment Gate with sentinel `Ready to proceed on your "go".`
4. §3 Goal naming the failure mode.
5. §4 Required Reading — rules, docs, knowledge floor + clusters.
6. §5 Scope Table.
7. §6 Quality Bar scaled to tier.
8. §7 Constraints.
9. §8 Agent Fan-Out.
10. §9 Definition of Done.
11. §10 Open Questions.
12. §11 State Files.
13. §12 Verification Commands.
14. §18 First-Response Format.

Never skip the acknowledgment gate. Never apply LIVE rigor to a DEV-only task. Never allow the LLM to write to the tracker.

Command alias: `mercury-task-prompt`.
