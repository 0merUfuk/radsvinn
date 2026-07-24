# Service Context: Planner (`service/`)

## Purpose
HTTP API + state machine + grounding orchestration for the two-phase plan pipeline.

## Public interface
- `POST /plan` — start a plan.
- `GET /plan/:id` — read plan state.
- `POST /plan/:id/approve-shape` — human gate 1.
- `POST /plan/:id/approve-create` — human gate 2.
- `GET /healthz` — process health and summary counters.

## Key files
- `server.mjs` — HTTP routes and state transitions.
- `engine.mjs` — LLM invocation + judge passes.
- `state.mjs` — plan lifecycle and persistence.
- `grounding.mjs` — repo fetch and anchor extraction.
- `gates.mjs` — deterministic prechecks.
- `breakers.mjs` — spend and rate breakers.

## Env
- `MERCURY_ENGINE`
- `MERCURY_LLM_PROVIDER`
- `MERCURY_*` grounding / tracker / spend knobs

## Tests
```bash
MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs
```
