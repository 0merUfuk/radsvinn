---
name: coupling-map
paths: ["coupling-map.yaml", "internal/checks/**", "cmd/treecheck/**", "prompts/**"]
---

# Coupling Map Rules

The coupling map is Mercury's safety ground truth for multi-writer and cross-service ordering hazards.

## Invariants

1. **The map is per-instance, never baked into the engine.** A new org supplies their own `coupling-map.yaml`.
2. **An empty map is legal but degraded.** `no_go_zones: []` provides no
   coupling-zone enforcement and is not evidence that a change is safe.
3. **No-go zones route to a human.** If a change touches a declared multi-writer zone, the planner flags it; the gate rejects auto-routing.
4. **v0.1.0 vocabulary is fixed.** Repository and zone enums come from the
   neutral seed schemas/thresholds; runtime-derived values are future R1/R2 work.
5. **Map changes are versioned and ratified.** Update `coupling-map.yaml` via PR,
   then run `go test ./...`.
