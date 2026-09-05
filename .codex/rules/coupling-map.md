# Coupling Map (Codex)

The coupling map is Radsvinn's safety ground truth.

Invariants:
1. The map is per-instance, never baked into the engine.
2. `no_go_zones: []` is legal but degraded: it provides no coupling-zone enforcement and is not evidence of safety.
3. No-go zones route to a human.
4. v0.1.0 repository and zone enums are fixed neutral seed values; runtime-derived vocabulary is future R1/R2 work.
5. Map changes are versioned and ratified.

Mirror of `.claude/rules/coupling-map.md`.
