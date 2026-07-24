# 07 — Jira Conventions

v0.1.0 is a configurable single-deployment seed, not a multi-tenant tracker adapter. Its
schemas and writer carry fixed neutral conventions. Production operators must verify those
conventions against their Jira project and override the clearly-example environment defaults.

## Project-agnostic keys

- The current plan-contract `existing_key` pattern is `^[A-Z]+-[0-9]+$`.
- Example: `EXAMPLE-123`, `PROJ-456`.
- The writer's `MERCURY_JIRA_PROJECT` fallback is the example key `PROJ`; set the real
  project in production.

## Issue types

- Epic for the plan root.
- The current schema accepts `Story`, `Task`, `Feature`, `Request`, `Bug`, `Test`, and
  `Sub-task` for items; the target project must provide the non-subtask names a plan uses.
- At live creation time, the writer discovers the project's first Jira issue type marked
  `subtask: true`; there is no `tracker.subtask_type_id` config yet.

## Five groomed fields every item must have

1. Why
2. Related links (external links and code anchors)
3. Definition of done
4. Technical analysis (including affected repos and coupling-zone routing)
5. Acceptance criteria

The writer combines those fields with the approved skeleton's one-line summary to build the
Jira summary and description. v0.1.0 does not add Jira labels for repos or coupling zones.

## Links

- Epic link: every child points to the plan epic.
- Dependencies: `blocks` / `depends on` for cross-zone ordering.

## Cancellation semantics

- Cancel = transition to a terminal status.
- Never delete a created issue.
- Cleanup of partial failures is deterministic and logged.

## Browse base

The Jira browse URL is derived directly from the environment, with a clearly-example fallback:

```
MERCURY_JIRA_SITE_URL=https://your-domain.atlassian.net
BROWSE_BASE=${MERCURY_JIRA_SITE_URL}/browse
```

`MERCURY_JIRA_CLOUD_ID` has no default and is required for every network operation.
`MERCURY_JIRA_TOKEN` is required for live/read network modes (with a local-file convenience
fallback that production deployments should disable). The R1 config spine and R5 tracker
adapter are future work.
