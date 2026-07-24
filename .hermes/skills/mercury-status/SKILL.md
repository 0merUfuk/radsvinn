---
name: mercury-status
title: Mercury Health Collation
description: Collation health check across the Mercury repo.
version: 1.0
---

# Mercury Status

Run a quick health collation before starting or after a change.

## Checks

1. **Git state** — `git status --short`, current branch, HEAD SHA.
2. **Go gate** — `go build ./... && go vet ./... && go test -count=1 ./...`
3. **Service tests** — `MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs`
4. **Dashboard tests** — `cd dashboard && node --test test/*.test.mjs`
5. **Forbidden-term scan** — grep for source-org references (none expected).
6. **Open worktrees / dirty state** — warn if found.
7. **Outstanding handoffs** — list `tasks/` dirs older than 7 days with no closure marker.

## Output

A concise table:

| Check | Status | Notes |
|---|---|---|
| git state | ✅/⚠️/❌ | ... |
| Go gate | ✅/❌ | ... |
| service tests | ✅/❌ | ... |
| dashboard tests | ✅/❌ | ... |
| forbidden terms | ✅/❌ | ... |
| worktrees | ✅/⚠️ | ... |
| stale handoffs | ✅/⚠️ | ... |

## What to do if a check fails

- Fix it before starting new work.
- If the failure is unrelated to your task, record it in `KNOWN_ISSUES.md` and continue.
- Never hide a red check.
