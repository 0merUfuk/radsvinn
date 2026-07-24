# Service Registry — Mercury Modules

| Service | Path | Language | Status | Notes |
|---|---|---|---|---|
| planner | `service/` | Node.js | LIVE potential | HTTP API + state machine + grounding |
| dashboard | `dashboard/` | Node.js | DEV | GitHub-OAuth BFF + browser UI |
| gate | `internal/checks/` + `cmd/treecheck/` | Go | LIVE potential | Deterministic validation |
| tracker-writer | `tools/create-tree.mjs` | Node.js | LIVE potential | No-LLM Jira writer |
| harness | `harness/` | Node.js | DEV | Calibration instrument |

## Status definitions

- **LIVE potential:** will run in production when Mercury is deployed.
- **DEV:** local / fake-engine only for now.
- **DEFERRED:** not built; trigger documented.
