# 08 — Proposed Config Spine (R1/R2)

This document describes the planned R1/R2 design, not current v0.1.0 behavior.

Today, Node configuration is read from scattered environment accesses, `service/config.mjs`
does not exist, and repository/coupling-zone enums are fixed neutral seed values in the JSON
schemas and Go thresholds. `no_go_zones: []` is legal but degraded because it provides no
coupling-zone enforcement.

## Goal

Replace scattered `process.env.*` reads with one typed config object loaded at boot.

## Modules

- `service/config.mjs` — proposed server-side config (does not exist yet).
- `dashboard/lib/config.mjs` — proposed dashboard alignment; the dashboard currently loads
  its own environment-derived config inside `dashboard/server.mjs`.
- `cmd/treecheck/main.go` — proposed profile integration; the v0.1.0 CLI currently receives
  configuration through flags.

## Config shape

```yaml
instance:
  name: mercury

vcs:
  org: example-org          # GitHub org
  repos: []                 # grounding repo list; empty allowed
  root: /data/repos         # local checkout root

tracker:
  type: jira
  project: EXAMPLE
  cloudId: required-secret
  siteUrl: https://example.atlassian.net
  subtaskTypeId: null       # resolved at runtime

llm:
  provider: anthropic       # or openrouter
  model: opus
  maxSpendUsd: 10.0
  breaker:
    requestsPerWindow: 100
    windowSeconds: 60

zones:
  mapPath: coupling-map.yaml  # per-tenant
  emptyIsLegalDegraded: true

rbac:
  teams:
    planners: []
    approvers: []
    creators: []

brand:
  name: Mercury
  logoUrl: null
```

## Target rules

1. One read at boot; values are frozen afterward.
2. Required fields fail-closed.
3. No org-specific defaults in source.
4. Secrets stay in env, never in config files.
5. Derived values (repo enum, zone enum, key pattern) are generated from config, not hardcoded.

## Proposed migration from scattered env

1. Enumerate every `process.env.MERCURY_*` and `process.env.DASH_*` read.
2. Add to `service/config.mjs` schema.
3. Replace inline reads with `config.*`.
4. Delete inline defaults.
5. In R2, generate and validate repository/zone vocabularies from the profile and coupling map.
6. Add a CI check that greps for inline `|| 'SPECIFIC-VALUE'` defaults.
