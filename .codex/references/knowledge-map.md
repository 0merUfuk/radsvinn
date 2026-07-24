# Knowledge Map

The canonical deep knowledge docs live in `.claude/knowledge/`.

This directory contains only pointers. Do **not** duplicate large docs into `.codex/` unless they are actively curated.

| Topic | `.claude/knowledge/` doc |
|---|---|
| Core principles | `00-core-principles.md` |
| Node engine | `01-node-engine.md` |
| Go gate | `02-go-gate.md` |
| Coupling map | `03-coupling-map.md` |
| Tracker writer | `04-tracker-writer.md` |
| Prompt injection | `05-prompt-injection.md` |

## Curation rule

If a Codex session needs a knowledge doc, read it from `.claude/knowledge/` directly. If the doc is updated, this map does not need to change. Only create a Codex-native copy if the doc is being actively adapted for Codex-specific behavior.
