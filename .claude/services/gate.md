# Service: Gate

| Field | Value |
|---|---|
| Path | `internal/checks/`, `cmd/treecheck/` |
| Language | Go |
| Status | LIVE potential |
| Interfaces | `treecheck` CLI, in-process checks |

## Context

Deterministic validation of skeleton and plan JSON. Verdict arithmetic is code, never LLM.

## Next steps

- Make repo/zone enums runtime-driven from config + coupling map.
- Attach advisory judge score to live path.
