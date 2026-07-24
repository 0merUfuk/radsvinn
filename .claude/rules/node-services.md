---
name: node-services
paths: ["service/**", "dashboard/**", "tools/**", "harness/**"]
---

# Node Services — Mercury Invariants

Applies to `service/`, `dashboard/`, `tools/`, and `harness/`.

## Invariants

1. **No LLM writes to a tracker.** `tools/create-tree.mjs` is the only writer, and it operates on human-approved `plan.json`.
2. **Spend breakers before every model call.** Check per-plan and daily caps.
3. **Anchors resolve against `origin/main`.** Never trust a local working tree for code citations.
4. **Cancel/transition only; never delete.** Undoing a created tree changes status, does not destroy.
5. **Handler functions do not contain business logic.** Business logic lives in `engine.mjs`, `state.mjs`, or dedicated modules.
6. **Boot enforces the current auth/token posture.** Direct planner boot rejects
   missing bearer auth on non-loopback binds (or whenever auth is required) and
   rejects a local Jira-token fallback when env-only token posture is required.

## Prompt files

`prompts/*.md` are verbatim model payloads. Keep new text org-neutral. Per-instance
domain-profile injection is future R3 work; it does not exist in v0.1.0.
