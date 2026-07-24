# Mercury Knowledge Base

Deep, on-demand docs for Mercury. These are never auto-loaded; read them when the work shape demands it.

## Index

| Doc | Topic | Read when |
|---|---|---|
| `00-core-principles.md` | Mercury design philosophy and safety spine | Every new contributor / new initiative |
| `01-node-engine.md` | Planner service, state machine, breakers | Working in `service/` |
| `02-go-gate.md` | Deterministic gate and `treecheck` CLI | Working in `internal/checks/` or `cmd/treecheck/` |
| `03-coupling-map.md` | How to read and maintain `coupling-map.yaml` | Changing zones, repos, or prompts |
| `04-tracker-writer.md` | `create-tree.mjs` contract and cancel semantics | Working in `tools/` |
| `05-prompt-injection.md` | Current sandbox posture and child-env deny-set | Security work |
| `06-llm-contracts.md` | The two LLM planning phases and their contracts | Changing prompts or model policy |
| `07-jira-conventions.md` | Neutral tracker conventions | Working in `tools/` or tracker-related prompts |
| `08-config-spine.md` | Proposed R1/R2 central config design | Planning config-spine or derived-enum work |
