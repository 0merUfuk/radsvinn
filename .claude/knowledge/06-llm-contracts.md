# 06 — LLM Contracts

Mercury has two LLM planning phases on a first-pass success. Bounded gate-driven regeneration
may add planning calls; tracker creation remains deterministic. Calibration judges are a
separate harness path, not part of a live service request.

## Phase 1: Decompose

**Input:** plain-language ask + coupling map + grounding context.
**Output:** `skeleton.json`.
**Model policy:** the live default is the floating Claude CLI alias `opus` at `xhigh`.
Operators can override the model and effort globally or per planning seat.

### Contract

- The model proposes structure and content only.
- The model does not know the tracker API.
- The model must respect coupling-map no-go zones.
- Spend breaker checked before invocation.

## Phase 2: Groom

**Input:** approved skeleton + plan draft + coupling map.
**Output:** groomed tickets with summary, description, acceptance criteria, zone tags, repo tags.
**Model policy:** same as phase 1.

### Contract

- Each ticket has 5 groomed fields.
- New issues use temporary IDs; only the optional `epic.existing_key` may name an
  already-existing Jira Epic, which the writer verifies before creating children.
- Coupling zones are explicit.

## Calls and regeneration

- First-pass success uses one Decompose call and one Groom call.
- After either call, the deterministic Go gate validates the emitted artifact.
- A failed gate with actionable complaints can trigger up to two additional calls for that
  phase. Each regeneration is another metered planning call and re-checks spend breakers.
- The calibration harness has separate tree and ticket judge calls configured in
  `harness/config.yaml`; those scores do not approve a live plan or replace the Go gate.

## What the LLM must never do

- Write to the tracker.
- Commit code.
- Merge a PR.
- Approve a gate on its own.
- Use `effort: max`.

## Fake engine

`MERCURY_ENGINE=fake` returns deterministic fixtures for tests. The LLM contract is exercised by the harness in `harness/`.
