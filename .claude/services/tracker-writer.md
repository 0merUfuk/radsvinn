# Service: Tracker Writer

| Field | Value |
|---|---|
| Path | `tools/create-tree.mjs` |
| Language | Node.js |
| Status | LIVE potential |
| Interfaces | Jira REST API |

## Context

The only code that writes to the tracker. No LLM. Human-approved plan in, Jira issues out.

## Invariants

- Cancel transitions only; never delete.
- Browse URLs are constructed from `MERCURY_JIRA_SITE_URL` or its clearly-example fallback.
- Cloud ID has no default; the project and site fallbacks are examples that production must override.
