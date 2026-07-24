package checks

// Adversarial edge-case matrix for the A1/A2/A3 non-blocking gate additions
// (fix/mercury-gate-correctness). Independently re-derives properties the
// developer's checks_test.go already exercises, and closes gaps the roadmap
// calls out explicitly: FooBar/foobar case-direction, in-item anchor
// self-citation dedup, 3-way anchor_consistency attribution, the
// summary_consistency 0.8 boundary (inclusive) plus a mixed empty/duplicate
// set, and the A3 floor's exact-boundary + parent-exemption behavior.
//
// Every sub-test asserts NON-BLOCKING where applicable: Pass stays true,
// v.OK stays true, v.HardFail stays false — a WARN/FLAG must never move an
// existing verdict.

import (
	"os/exec"
	"strings"
	"testing"
)

// ─────────── A1: case-insensitive substring, FooBar/foobar direction ──────

// TestAnchorSymbolCaseDirectionFooBar locks the OTHER case direction from the
// developer's "realFUNC" test (mixed-case ANCHOR against a lowercase FILE
// symbol, rather than mixed-case file against a plain anchor) — both
// directions must clear cleanly since symbolInBlob lowercases both sides.
func TestAnchorSymbolCaseDirectionFooBar(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	th := loadTestThresholds(t)
	root := t.TempDir()
	seedOriginMainRepo(t, root, "casetest", "handler.go", "package casetest\n\nfunc foobar() {}\n")
	cm := writeFile(t, root, "coupling-map.yaml", "no_go_zones: []\n")

	item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
		[]string{"casetest:handler.go:FooBar"}, []string{"none"}, []string{"kriter"})
	v := PrecheckPlan(mkPlan(item), th, cm, root)["i1"]
	ae := v.Checks["anchors_exist"]
	if !ae.Pass || len(ae.Complaints) != 0 {
		t.Fatalf("anchor %q (mixed-case) against file symbol %q (lowercase) must clear with no WARN, got pass=%v complaints=%v",
			"FooBar", "foobar", ae.Pass, ae.Complaints)
	}
}

// ─────────────── A1/A4(ii): blob + originMain dedupe within ONE item ──────

// TestAnchorCacheDedupesWithinOneItem calls checkAnchorsExist directly (not
// through PrecheckPlan) with a SINGLE item citing the SAME file twice via two
// different symbols, then inspects the cache's internal maps: after the call,
// exactly one blob entry and one originMain entry must exist for that
// repo/file — proving N anchors to the same file cost one git-show/rev-parse,
// not N. This closes the gap between the developer's unit-level cache-swap
// proof (TestAnchorCacheBlobMemoized, which calls blobOnOriginMain directly)
// and the actual call site inside checkAnchorsExist.
func TestAnchorCacheDedupesWithinOneItem(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	seedOriginMainRepo(t, root, "deduprepo", "shared.go", "package d\n\nfunc One() {}\nfunc Two() {}\n")

	it := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
		[]string{"deduprepo:shared.go:One", "deduprepo:shared.go:Two"}, []string{"none"}, []string{"kriter"})

	cache := newAnchorCache()
	res := checkAnchorsExist(&it, root, cache)
	if !res.Pass || len(res.Complaints) != 0 {
		t.Fatalf("both symbols are real; expected a clean pass, got pass=%v complaints=%v", res.Pass, res.Complaints)
	}
	if got := len(cache.blob); got != 1 {
		t.Fatalf("cache.blob has %d entries after two anchors to the SAME file, want 1 (one git-show, not two)", got)
	}
	if got := len(cache.originMain); got != 1 {
		t.Fatalf("cache.originMain has %d entries after two anchors to the SAME repo, want 1 (one rev-parse, not two)", got)
	}
}

// ─────────────────── A2: anchor_consistency — no self-citation ────────────

// TestAnchorConsistencyNoSelfCitation locks the dedup rule: an item citing the
// SAME anchor twice (e.g. a sloppy copy-paste in code_anchors) must NOT WARN
// against itself when no OTHER item cites that anchor. indexAnchorCiters
// dedupes within an item, so citers[anchor] has exactly one entry (this item)
// and checkAnchorConsistency's `len(citers) <= 1` guard skips it.
func TestAnchorConsistencyNoSelfCitation(t *testing.T) {
	th := loadTestThresholds(t)
	dir := t.TempDir()
	seedOriginMainRepo(t, dir, "web-app", "solo2.ts", "export function Solo2() {}\n")
	cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")

	item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
		[]string{"web-app:solo2.ts", "web-app:solo2.ts"}, []string{"none"}, []string{"kriter"})
	v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
	ac := v.Checks["anchor_consistency"]
	if len(ac.Complaints) != 0 {
		t.Fatalf("a repeated anchor within a single item (no other citer) must not self-WARN; got %v", ac.Complaints)
	}
	if !ac.Pass {
		t.Fatalf("anchor_consistency must stay Pass:true; got %v", ac.Complaints)
	}
}

// TestAnchorConsistencyThreeWay locks per-item attribution across THREE
// citers: each item's WARN must name exactly the OTHER two, never itself.
func TestAnchorConsistencyThreeWay(t *testing.T) {
	th := loadTestThresholds(t)
	dir := t.TempDir()
	seedOriginMainRepo(t, dir, "web-app", "triple.ts", "export function Triple() {}\n")
	cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")

	planA := mkPlanItem("planA", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:triple.ts"}, []string{"none"}, []string{"ac"})
	planB := mkPlanItem("planB", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:triple.ts"}, []string{"none"}, []string{"ac"})
	planC := mkPlanItem("planC", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:triple.ts"}, []string{"none"}, []string{"ac"})

	out := PrecheckPlan(mkPlan(planA, planB, planC), th, cm, dir)

	expect := map[string][]string{
		"planA": {"planB", "planC"},
		"planB": {"planA", "planC"},
		"planC": {"planA", "planB"},
	}
	for id, others := range expect {
		v := out[id]
		ac := v.Checks["anchor_consistency"]
		if !ac.Pass {
			t.Fatalf("%s: anchor_consistency must be NON-BLOCKING; got %v", id, ac.Complaints)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("%s: 3-way shared anchor must not hard-fail the verdict; regen: %q", id, v.RegenComplaint)
		}
		joined := strings.Join(ac.Complaints, "\n")
		if len(ac.Complaints) != 1 {
			t.Fatalf("%s: expected exactly one WARN (one shared anchor), got %v", id, ac.Complaints)
		}
		for _, other := range others {
			if !strings.Contains(joined, other) {
				t.Fatalf("%s: WARN should name %s, got %q", id, other, joined)
			}
		}
		if strings.Contains(strings.TrimPrefix(joined, "WARN: "+id+": "), id) {
			t.Fatalf("%s: WARN must not name itself as an 'other' citer; got %q", id, joined)
		}
	}
}

// ─────────────────── A2: summary_consistency — 0.8 boundary ───────────────

// TestSummaryConsistencyBoundary pins the documented boundary: the check uses
// `jac >= summaryJaccardThreshold`, so a Jaccard of EXACTLY 0.8 must WARN
// (inclusive), while 0.75 (one word short of the ratio) must not.
func TestSummaryConsistencyBoundary(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("exactly 0.8 Jaccard WARNs (inclusive boundary)", func(t *testing.T) {
		// A = {alpha,bravo,charlie,delta,echo} (5), B = {alpha,bravo,charlie,delta} (4, subset of A).
		// intersection=4, union=5 -> 4/5 = 0.8 exactly.
		s := skeletonOf(
			mkSummarizedItem("i1", "alpha bravo charlie delta echo"),
			mkSummarizedItem("i2", "alpha bravo charlie delta"),
		)
		v := ValidateSkeleton(s, th)
		sc := v.Checks["summary_consistency"]
		if !sc.Pass {
			t.Fatalf("must stay NON-BLOCKING at the boundary; got a fail: %v", sc.Complaints)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("boundary WARN must not hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(sc.Complaints, "\n")
		if !strings.Contains(joined, "WARN:") || !strings.Contains(joined, "80%") {
			t.Fatalf("expected a WARN reporting 80%%, got %v", sc.Complaints)
		}
	})

	t.Run("0.75 Jaccard (just under threshold) does not WARN", func(t *testing.T) {
		// A = {alpha,bravo,charlie,delta} (4), B = {alpha,bravo,charlie} (3, subset).
		// intersection=3, union=4 -> 3/4 = 0.75 < 0.8.
		s := skeletonOf(
			mkSummarizedItem("i1", "alpha bravo charlie delta"),
			mkSummarizedItem("i2", "alpha bravo charlie"),
		)
		if c := ValidateSkeleton(s, th).Checks["summary_consistency"].Complaints; len(c) != 0 {
			t.Fatalf("a 0.75 overlap is below the 0.8 threshold and must not WARN; got %v", c)
		}
	})
}

// TestSummaryConsistencyMixedEmptyAndDuplicate exercises a realistic mixed
// skeleton: an item with an empty summary and one with a whitespace-only
// summary must both be silently skipped (no panic, no WARN attributed to
// them), while a genuinely near-duplicate pair elsewhere in the SAME
// skeleton still WARNs.
func TestSummaryConsistencyMixedEmptyAndDuplicate(t *testing.T) {
	th := loadTestThresholds(t)
	s := skeletonOf(
		mkSummarizedItem("empty1", ""),
		mkSummarizedItem("blank1", "   "),
		mkSummarizedItem("dup1", "add retry logic to the upload worker"),
		mkSummarizedItem("dup2", "add retry logic to the upload worker queue"),
		mkSummarizedItem("distinct1", "migrate billing cron to the new scheduler"),
	)

	v := ValidateSkeleton(s, th)
	sc := v.Checks["summary_consistency"]
	if !sc.Pass {
		t.Fatalf("must stay NON-BLOCKING; got a fail: %v", sc.Complaints)
	}
	if !v.OK || v.HardFail {
		t.Fatalf("must not hard-fail the verdict; regen: %q", v.RegenComplaint)
	}
	joined := strings.Join(sc.Complaints, "\n")
	if strings.Contains(joined, "empty1") || strings.Contains(joined, "blank1") {
		t.Fatalf("empty/whitespace summaries must be skipped entirely, never named in a complaint; got %q", joined)
	}
	if !strings.Contains(joined, "dup1") || !strings.Contains(joined, "dup2") {
		t.Fatalf("the genuine near-duplicate pair must still WARN; got %q", joined)
	}
	if strings.Contains(joined, "distinct1") {
		t.Fatalf("the distinct item must not be flagged; got %q", joined)
	}
}

// ────────────────────── A3: micro-leaf floor boundary + scope ─────────────

// TestMicroLeafFloorExactBoundary pins the `c < floor` (strict) semantics: a
// leaf priced EXACTLY at the floor must NOT WARN — only strictly-below does.
func TestMicroLeafFloorExactBoundary(t *testing.T) {
	th := loadTestThresholds(t) // thresholds.yaml min_leaf is $2.00
	s := skeletonOf(mkItem("i1", "Task", nil, nil, nil, "web-app", th.Sizing.MinLeafPredictedCostUSD))
	if c := ValidateSkeleton(s, th).Checks["sizing_sane"].Complaints; len(c) != 0 {
		t.Fatalf("a leaf priced EXACTLY at the floor ($%.2f) must not be flagged (strict <, not <=); got %v",
			th.Sizing.MinLeafPredictedCostUSD, c)
	}
}

// TestMicroLeafFloorParentExempt locks the parent-exemption: checkSizingSane
// only iterates LEAVES for cost checks (leafCount/warn-band/floor all sit
// inside the `!isParent[it.TempID]` branch). A PARENT priced below the floor
// must never surface the fold-candidate WARN — only its leaf children (if any)
// are judged.
func TestMicroLeafFloorParentExempt(t *testing.T) {
	th := loadTestThresholds(t)
	par := mkItem("par", "Story", nil, nil, nil, "web-app", 0.10) // far below the $2 floor
	child := mkItem("child", "Sub-task", sptr("par"), nil, nil, "web-app", 3)
	s := skeletonOf(par, child)

	res := checkSizingSane(s, th)
	joined := strings.Join(res.Complaints, "\n")
	if strings.Contains(joined, "par:") || strings.Contains(joined, "\"par\"") {
		t.Fatalf("a non-leaf (parent) priced below the floor must never be judged by the A3 leaf-only floor; got %v", res.Complaints)
	}
	if strings.Contains(joined, "below the min") {
		t.Fatalf("no fold-candidate WARN should fire at all here — the only leaf (child) is well within band; got %v", res.Complaints)
	}
}
