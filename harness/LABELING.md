**Version**: 1.0
**Created**: 2026-07-03
**Last Updated**: 2026-07-03
**Authors:** Mercury maintainers

---

# Mercury Blind Labeling Guide

You label the held-out calibration run **blind** (the
review sheet hides every judge score), then `score-agreement --dod` compares your
labels to the judge. This guide pins the two questions and the handful of edge
cases that would otherwise become label noise.

> **Why blind**: the metric is *judge-vs-human agreement*. If you saw the judge's
> score first you'd anchor on it, and the number would measure "does the human labeler defer to
> a displayed score," not "does the judge match an independent human." `render-sheet`
> blanks the judge columns by default — don't run `--unblind` until labels are locked.

---

## The workflow

```bash
cd harness  # from the repository root
node render-sheet.mjs --run results/dod-round1     # writes review-sheet.md + labels.csv (BLIND)
# 1. read review-sheet.md top-to-bottom
# 2. fill the two human columns in labels.csv (copy it to labels.filled.csv first)
node score-agreement.mjs --run results/dod-round1 --labels results/dod-round1/labels.filled.csv --dod
```

`--dod` refuses to print a verdict unless all 20 asks are present, every ticket is
labeled, every big-ask tree is labeled, and the thresholds file is unchanged since
the run (the freeze rule). It also refuses if any judge failed mid-run — fill those
with `node run-calibration.mjs --rejudge results/dod-round1` first.

---

## The two questions

### Per ticket — `human_dev_ready_without_edits` (y/n)

> **Would you hand this exact ticket to a developer on your team and expect them to build
> it without coming back to ask you what you meant?**

- **y** — the 5 fields are complete and unambiguous; a dev reads it and starts.
- **n** — the dev would have to come back: vague Technical Analysis, untestable AC,
  a wrong/missing code anchor, a DoD that states an activity instead of an outcome.

The phrase is literally *without edits* — a ticket you'd tweak first is **n**, even
if it's close. That strictness is deliberate; it's what makes the bar meaningful.

### Per big-ask tree — `human_breakdown_good` (y/n, or `na` for small asks)

> **Is this a good decomposition — right-sized pieces, buildable order, sensible
> milestones, nothing missing, nothing over-split?**

- **y** — you'd run this breakdown in a planning meeting as-is.
- **n** — wrong slices, wrong order, a milestone that isn't shippable, a missing
  piece, or fragment-swarm over-splitting.
- **na** — small ask (one-node tree); there is no breakdown to judge. (The sheet
  marks the stratum; small asks are pre-set to `na`.)

Label the **tree from the tree view alone, before reading the groomed tickets below
it** — otherwise a beautiful write-up halos a bad shape.

---

## Edge cases (pin these — they are where labels drift)

### 1. A "needs-human / lockstep" ticket is still dev-ready

Some asks (team workspace shared credits, referral credits, credit-refund UI) are
genuinely **shared-write-zone** changes. The correct planner output is a ticket flagged
`needs-human` + `high` effort that says *"this touches the shared-write balance
columns across their multiple writers — lockstep, route to a human, do not let the
agent decompose it."*

**That is a GOOD ticket.** `needs-human` means the *automation agent* refuses it —
NOT that a human dev can't build it. The dual-execution model is exactly this: one
quality bar, two possible executors. So:

- A well-written lockstep ticket → **dev-ready = y** (a human dev takes it).
- A tree that *correctly refused to decompose* pure coupled work into a
  small flagged ticket → **breakdown-good = y** (refusing to decompose is the right
  architectural call, not a failure to decompose).

Judge these on writing quality, not on whether they chose to decompose.

### 2. A force-BLOCKED ticket

The sheet shows some tickets as `BLOCK (deterministic precheck hard-fail)`. That's
the code gate, not the LLM — it fired because the ticket was internally inconsistent
(e.g. anchored a zone file while declaring `zones: none`, or a fabricated anchor).
Ask yourself the same question honestly: **would you hand THIS ticket, as written,
to a dev without edits?** Almost always **n** — an inconsistent ticket needs fixing
first. Your **n** agreeing with the judge's BLOCK is a *correct* agreement; that's
the gate and the human converging, which is what we want to see.

### 3. A JUDGE_FAILED item

Rare — the judge call itself failed (malformed output). The sheet shows
`— → JUDGE_FAILED`. **Label it anyway** (your human judgment doesn't need the judge).
It's excluded from the agreement math but counts toward hand-to-dev. If there are
several, `--rejudge` and re-score instead.

### 4. An escalated ask

If an ask escalated (the decomposer couldn't produce a valid tree after 2 regens),
it has no tickets. It counts as **not** hand-to-dev-ready (an ask that produced
nothing usable). The sheet notes it.

---

## What the numbers mean (after you score)

Three bars, all must clear for **DoD: PASS**:

| Metric | Bar | Reads |
|--------|-----|-------|
| hand-to-dev | ≥ 16/20 | of 20 asks, ≥16 produced a tree you'd hand a dev whole |
| ticket agreement | ≥ 80% | judge PASS/not-PASS matches your y/n per ticket |
| tree agreement | ≥ 80% | same, per big-ask breakdown (a real gate now — 10 big asks) |

The report also prints **Cohen's kappa** (agreement above chance — a raw 80% with
skewed marginals can be weak; kappa shows it) and a **Wilson 95% CI** on hand-to-dev
(so a 16/20 squeaker is visibly a squeaker, not a clean pass). **Soft disagreements**
(judge FLAG where you said y) are counted separately — they're the least-alarming
kind of miss.

If a bar misses: the fix is a prompt/rubric tweak, then **re-run**. Judge-side tweaks
use `--rejudge` (cheap — reuses the generator work). Generator-side tweaks re-run the
ask. **Never edit `thresholds.yaml` to make a run pass** — freeze it per run; tune on
a separate slice if you tune at all (the whole point of `--verify`).
