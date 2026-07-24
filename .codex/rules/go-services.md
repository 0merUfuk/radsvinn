# Go Services (Codex)

Applies to `internal/checks/` and `cmd/treecheck/`.

Invariants:
1. The gate is fail-closed.
2. Verdict arithmetic is code, never the LLM.
3. v0.1.0 legal repo/zone enums are fixed neutral seed values; runtime-derived vocabulary is future R1/R2 work.
4. Every check has a unit test.
5. Schema and gate stay aligned.
6. No `effort: max` anywhere.

Mirror of `.claude/rules/go-services.md`.
