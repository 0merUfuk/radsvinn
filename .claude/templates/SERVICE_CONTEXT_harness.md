# Service Context: Harness (`harness/`)

## Purpose
Calibration instrument for planner quality: runs dry-run samples, scores agreement, renders comparison sheets.

## Public interface
- `node harness/run-calibration.mjs --sample fixtures/asks/sample-01.md`
- `node harness/render-sheet.mjs`
- `node harness/reprecheck.mjs`

## Key files
- `run-calibration.mjs` — sample runner.
- `score-agreement.mjs` — judge score aggregator.
- `render-sheet.mjs` — HTML diff sheet.
- `lib.mjs` — harness utilities.

## Env
- `MERCURY_ENGINE`
- `MERCURY_SKIP_PLAN_ANCHORS`

## Tests
```bash
cd harness && node --test lib.test.mjs
```
