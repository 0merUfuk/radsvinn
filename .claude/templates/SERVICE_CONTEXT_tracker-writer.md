# Service Context: Tracker Writer (`tools/create-tree.mjs`)

## Purpose
The only code that writes to the tracker. Deterministic, no LLM.

## Public interface
- `node tools/create-tree.mjs plan.json` — create Jira issues and links.

## Contract
- Input: human-approved `plan.json`.
- Output: created issues, links, comments.
- Cancel = transition, never delete.

## Key files
- `tools/create-tree.mjs` — writer.

## Env
- `MERCURY_JIRA_PROJECT`
- `MERCURY_JIRA_CLOUD_ID`
- `MERCURY_JIRA_SITE_URL`
- `MERCURY_JIRA_TOKEN`

## Tests
Use fake stubs in `service/test/create-tree-*.test.mjs`.
