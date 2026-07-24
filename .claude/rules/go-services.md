---
name: go-services
paths: ["internal/checks/**", "cmd/treecheck/**"]
---

# Go Services — Mercury Gate Invariants

Applies to `internal/checks/` and `cmd/treecheck/`.

## Invariants

1. **The gate is fail-closed.** A malformed plan is rejected, not coerced.
2. **Verdict arithmetic is code, never the LLM.** Weights, thresholds, and score aggregation live in Go or YAML tunables.
3. **v0.1.0 legal repo/zone enums are fixed neutral seed values.** Runtime-derived
   vocabulary from config + coupling map is future R1/R2 work.
4. **Every check has a unit test.** New gate logic ships with a failing→passing test.
5. **Schema and gate stay aligned.** If `contracts/*.schema.json` changes, `internal/checks/types.go` must follow.
6. **No `effort: max` anywhere.**
