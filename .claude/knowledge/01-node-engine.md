# 01 — Node Engine

The planner service in `service/`.

## Components

- `server.mjs` — HTTP API and state machine.
- `engine.mjs` — LLM invocation + grounding orchestration.
- `state.mjs` — plan lifecycle, CAS transitions.
- `breakers.mjs` — per-plan and daily spend caps.
- `grounding.mjs` — git fetch + anchor resolution.

## State machine

```
breaking_down → shape_ready → grooming → plan_ready → creating → created
                ↑ human      ↑ human            ↑ create call
```

Request handlers claim user-driven transitions (approve, reject, create, retry, and cancel)
with a persisted compare-and-swap. After a request wins that claim, the asynchronous worker
persists its completion or failure with ordinary state updates. On restart, transient in-flight
statuses are swept to `failed`; create records and retry guards prevent duplicate tracker writes.

## Fake engine

Set `MERCURY_ENGINE=fake` to run through the real code path with deterministic replay artifacts. This is the default for demos and most CI.

## Testing

```bash
MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs
```

## Invariants

- No LLM output reaches the tracker unreviewed.
- Spend breakers run before every model call.
- Anchors resolve against `origin/main`.
- The default agent tool posture is `Read,Grep,Glob` with no shell or write tool.
