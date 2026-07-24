---
name: documentation-conventions
paths: []
---

# Documentation Conventions

1. Org-neutral language everywhere. No customer names, no internal paths, no laptop directories.
2. Load-bearing designs live in tracked `docs/` or `blueprints/`, never only in gitignored `tasks/`.
3. `docs/ARCHITECTURE.md` is the design-of-record; `docs/ROADMAP.md` is the forward plan.
4. Every ADR in `docs/adr/` has a status, date, and explicit supersession clause if replaced.
5. `README.md` is the product front door, not a build log.
6. Context files (`SERVICE_CONTEXT`, `NEXT_STEPS`, `KNOWN_ISSUES`, `DECISIONS`) follow the session-protocol rule.
