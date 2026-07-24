# Node Services (Codex)

Applies to `service/`, `dashboard/`, `tools/`, `harness/`.

Invariants:
1. No LLM writes to a tracker.
2. Spend breakers before every model call.
3. Anchors resolve against `origin/main`.
4. Cancel/transition only; never delete.
5. Handlers do not contain business logic.
6. Boot enforces the current auth/token posture: non-loopback or explicitly required auth must have a bearer, and env-only Jira-token posture rejects the local fallback.

Prompt text must stay org-neutral. Per-instance domain-profile injection is future R3 work, not current behavior.

Mirror of `.claude/rules/node-services.md`.
