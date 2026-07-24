# Safety Spine (Codex)

Project-wide non-negotiable invariants:

1. The LLM never writes the tracker.
2. Two human gates per plan.
3. Deterministic gate is fail-closed.
4. Anchors resolve against `origin/main` git objects.
5. Cancel/transition only — never delete.
6. Spend breakers before every model call.
7. No `effort: max` anywhere.

Mirror of `.claude/rules/safety-spine.md`.
