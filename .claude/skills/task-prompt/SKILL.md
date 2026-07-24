# Mercury Task Prompt

Generate a scoped, gated manager brief. Output to `tasks/task-prompts/{date}-{slug}.md`.

## Inputs

- Scope class: low / medium / high / max
- Highest deployment tier touched: LIVE / STAGING / DEV / DEFERRED
- Slug
- One-sentence goal naming the failure mode to prevent
- Modules touched

## Output sections

1. **Header** — scope, tier, date, modules.
2. **§1 Identity & Standing Orders** — role, Mercury context anchor, non-negotiables.
3. **§2 Acknowledgment Gate** — mandatory first-response coverage list + `Ready to proceed on your "go".`
4. **§3 Goal** — one sentence with named failure mode.
5. **§4 Required Reading** — rules, docs, knowledge floor + clusters.
6. **§5 Scope Table** — in/out of scope + cross-service contracts.
7. **§6 Quality Bar** — tier-scaled.
8. **§7 Constraints** — incident-traceable don't-list.
9. **§8 Agent Fan-Out** — who to spawn, who NOT to spawn.
10. **§9 Definition of Done** — checkboxes.
11. **§10 Open Questions** — agent-decides / recommends / human-only.
12. **§11 State Files** — `tasks/{slug}/` quartet.
13. **§12 Verification Commands** — runnable.
14. **§18 First-Response Format** — coverage list + sentinel.

## What NEVER to do

- Skip the acknowledgment gate.
- Apply LIVE rigor to a DEV-only task.
- Allow the LLM to write to the tracker.
- Invent file paths.
