# 00 — Core Principles

Mercury is a coupling-aware AI planner that can be trusted with real work.

## The trust model

- The LLM proposes.
- A deterministic gate validates.
- A human approves twice (shape, then content).
- The LLM never writes the tracker.

## The pipeline

1. **Break-Down** — agent proposes a skeleton tree.
2. **Skeleton gate** — deterministic validation (structure, hierarchy, sizing).
3. **Human gate 1** — approve the shape.
4. **Grooming** — agent writes 5 fields per ticket + verified anchors.
5. **Plan gate** — deterministic validation (fields, anchors, coupling-zone routing, sizing).
6. **Human gate 2** — approve the groomed tree.
7. **Create** — deterministic writer makes Jira calls.

## Safety invariants

1. The LLM never writes the tracker.
2. Two human gates per plan.
3. The deterministic gate is fail-closed.
4. Anchors resolve against `origin/main` git objects.
5. Cancel/transition only — never delete.
6. Spend breakers before every model call.
7. No `effort: max` anywhere.

## Reversibility doctrine

Classify every choice:
- **GREEN** trivially reversible → pick a sensible default, proceed.
- **YELLOW** reversible with migration cost → proceed, note it.
- **RED** one-way door → explicit acknowledgment; convert to reversible where possible.

When two options are close, the reversible one wins automatically.
