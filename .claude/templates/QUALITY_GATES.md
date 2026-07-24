# Mercury Quality Gates

Pipeline for any change that touches Mercury code.

## Gates

1. **Self-check** — author runs the relevant tests.
2. **Doublecheck** — 4 adversarial passes.
3. **Reviewer** — read-only gate, verify against `origin/main`.
4. **Human gate** — required for any LIVE-facing change.
5. **CI** — `go test`, `node --test` in fake mode, docker build smoke.
6. **Merge** — only after human `go`.

## Blockers

- Any red gate blocks.
- A reviewer finding must be resolved or downgraded with evidence.
- No merge without a clean CI run on a worktree-based branch.
