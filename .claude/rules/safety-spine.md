---
name: safety-spine
paths: []
---

# Mercury Safety Spine

These invariants are project-wide and non-negotiable.

1. The LLM never writes the tracker.
2. Two human gates per plan (shape, then create).
3. Deterministic gate is fail-closed.
4. Anchors resolve against `origin/main` git objects.
5. Cancel/transition only — never delete.
6. Spend breakers before every model call.
7. No `effort: max` anywhere.

If any change would violate one of these, escalate to the human immediately.
