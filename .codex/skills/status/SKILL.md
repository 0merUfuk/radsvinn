# Mercury Status (Codex)

Collation health check.

Checks:
1. `git status --short`
2. `go build ./... && go vet ./... && go test ./...`
3. `MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs`
4. `cd dashboard && node --test test/*.test.mjs`
5. Forbidden-term scan.
6. Open worktrees / dirty state.
7. Stale `tasks/` dirs.

Command alias: `mercury-status`.
