# Mercury Commit

Slice changes into clean conventional commits.

## Procedure

1. `git status` + `git diff --stat`.
2. Group by concern, not file type.
3. Write type/scope header + body.
4. Preview to user.
5. Commit one by one on approval.

## Scopes

- `planner`, `dashboard`, `gate`, `tracker`, `harness`, `docs`, `agent`

## What NEVER to do

- `git add -A` blindly.
- Add AI attribution tags.
- Squash unrelated concerns.
- Commit without preview.
