# 02 — Go Gate

The deterministic validation layer: `internal/checks/` and `cmd/treecheck/`.

## Checks

1. **Structure** — valid tree shape, no orphaned children.
2. **Hierarchy** — legal parent/child relationships.
3. **Ordering** — cross-service dependencies sorted correctly.
4. **Sizing** — estimates within configured bounds.
5. **Coupling-zone routing** — no-go zones flagged for human routing.
6. **Anchor existence** — every cited symbol resolves against `origin/main`.

## Tunables

Thresholds live in `internal/checks/thresholds.yaml`. The gate reads them at runtime.

## CLI

```bash
go run ./cmd/treecheck -mode=skeleton < skeleton.json
go run ./cmd/treecheck -mode=plan < plan.json
```

## Invariants

- Verdict arithmetic is Go code, never the LLM.
- v0.1.0 uses the fixed neutral repository and coupling-zone vocabulary in
  `contracts/*.schema.json` and `internal/checks/thresholds.yaml`.
- A coupling map must declare exactly one `no_go_zones` sequence; `no_go_zones: []`
  is legal but provides no coupling-zone enforcement.
- Runtime-derived repository and zone enums are future R1/R2 work.
- Every new check has a unit test.
