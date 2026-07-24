# Service Context: Gate (`internal/checks/`, `cmd/treecheck/`)

## Purpose
Deterministic validation of plan/skeleton shape, hierarchy, sizing, coupling, and anchors.

## Public interface
- `treecheck` CLI:
  - `go run ./cmd/treecheck -mode=skeleton < skeleton.json`
  - `go run ./cmd/treecheck -mode=plan < plan.json`
- In-process checks via `internal/checks`.

## Key files
- `cmd/treecheck/main.go` — CLI entrypoint.
- `internal/checks/precheck.go` — structure/hierarchy.
- `internal/checks/skeleton.go` — skeleton validation.
- `internal/checks/thresholds.go` — sizing thresholds.
- `internal/checks/types.go` — types and enums.

## Env
- `MERCURY_COUPLING_MAP`

## Tests
```bash
go test ./...
```
