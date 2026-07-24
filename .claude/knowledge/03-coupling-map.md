# 03 — Coupling Map

`coupling-map.yaml` is Mercury's safety ground truth for multi-writer and cross-service ordering hazards.

## Shape

```yaml
version: 1
no_go_zones:
  - id: shared-write
    kind: shared-write # human-facing context
    members:
      - "api-service:internal/billing/store.go"
      - "web-app:src/lib/billing.ts"
    why: A column/table is written by more than one service.
```

## Rules

- The map is per-instance. The engine must not require a specific map to boot.
- The Go gate currently parses exactly one top-level `no_go_zones` sequence. Additional
  top-level sections are planning context, not deterministic gate inputs.
- An empty map means `no_go_zones: []`. It is legal but degraded: no coupling zones are
  enforced, so it is not evidence that changes are safe.
- v0.1.0 uses a fixed neutral seed vocabulary: repositories are `web-app`,
  `api-service`, `worker-service`, `shared-lib`, plus the plan-only
  `cross-repo-lockstep` marker; plan zones are `none` and `shared-write`.
- Runtime-derived repository and zone enums are future R1/R2 work.
- No-go zones (shared-write) route to a human; they are never auto-decomposed.

## Maintenance

- Update via PR.
- Run `go test ./...` after any map schema change.
- Record the rationale for each zone in a comment or ADR.
