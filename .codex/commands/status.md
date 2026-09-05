# Radsvinn Status

Collation health check across the Radsvinn repo.

**When to use:** at session start or after a change.

## Steps

1. Check git state.
2. Run Go tests.
3. Run service tests with fake engine.
4. Run dashboard tests.
5. Scan forbidden terms.
6. Check worktrees and stale handoffs.

## Output

Concise ✅/⚠️/❌ table.
