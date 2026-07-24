# 04 — Tracker Writer

`tools/create-tree.mjs` is the only tracker writer. It is deterministic and contains no LLM.

## Contract

- Input: human-approved `plan.json`.
- Output: created Jira issues, linked in the correct hierarchy.
- Failure mode: fail-closed; report what was not created.

## Cancel semantics

- Cancel transitions every issue to a terminal state.
- Children are transitioned before parents.
- Nothing is deleted.

## Invariants

- No model output reaches the tracker.
- The writer reads Jira settings directly from `MERCURY_JIRA_*` environment variables;
  there is no central service config module in v0.1.0.
- `MERCURY_JIRA_CLOUD_ID` has no default and is required for network operations.
- `MERCURY_JIRA_PROJECT=PROJ` and
  `MERCURY_JIRA_SITE_URL=https://your-domain.atlassian.net` are clearly-example
  fallbacks; production deployments must override them.
- Browse URLs are constructed from `MERCURY_JIRA_SITE_URL` (or its example fallback).
