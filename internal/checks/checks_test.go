package checks

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ─────────────────────────────── helpers ─────────────────────────────────

func sptr(s string) *string { return &s }

// loadTestThresholds loads the real thresholds.yaml sitting next to this test.
func loadTestThresholds(t *testing.T) *Thresholds {
	t.Helper()
	th, err := LoadThresholds("thresholds.yaml")
	if err != nil {
		t.Fatalf("LoadThresholds: %v", err)
	}
	return th
}

func mkItem(id, typ string, parent *string, deps []string, ms *string, repo string, cost float64) SkeletonItem {
	return SkeletonItem{
		TempID:         id,
		Type:           typ,
		ParentTempID:   parent,
		DependsOn:      deps,
		MilestoneID:    ms,
		Repo:           repo,
		SizeEstimate:   SizeEstimate{Tier: "low", PredictedCostUSD: cost, Rationale: "r"},
		OneLineSummary: "özet",
	}
}

func mkMS(id string, order int) Milestone {
	return Milestone{MilestoneID: id, Name: "n", Goal: "g", Order: order}
}

// manyLeaves builds a warning-free, milestone-free skeleton of n standalone L0
// leaves. It deliberately keeps costs in-band and summaries distinct, so width
// tests isolate max_tree_leaves rather than accidentally triggering the
// unrelated sizing or summary-consistency advisories.
func manyLeaves(n int) *Skeleton {
	items := make([]SkeletonItem, 0, n)
	for i := 0; i < n; i++ {
		it := mkItem("i"+itoa(i), "Task", nil, nil, nil, "web-app", 3)
		it.OneLineSummary = "leaf-" + itoa(i)
		items = append(items, it)
	}
	return &Skeleton{PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{}, Items: items}
}

// manySubtasks builds a warning-free skeleton with one legal L0 parent and n
// legal Sub-task children. It isolates the advisory per-parent convention from
// hierarchy legality, other sizing advisories, and summary consistency.
func manySubtasks(n int) *Skeleton {
	parent := mkItem("parent", "Story", nil, nil, nil, "web-app", 3)
	parent.OneLineSummary = "parent-root"
	items := []SkeletonItem{parent}
	for i := 0; i < n; i++ {
		it := mkItem("sub"+itoa(i), "Sub-task", sptr("parent"), nil, nil, "web-app", 3)
		it.OneLineSummary = "sub-" + itoa(i)
		items = append(items, it)
	}
	return &Skeleton{PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{}, Items: items}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

// ─────────────────────────── skeleton checks ─────────────────────────────

func TestValidateSkeleton(t *testing.T) {
	th := loadTestThresholds(t)

	validTree := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door",
		Epic:       &Epic{TempID: "e1", Summary: "s", Why: "w"},
		Milestones: []Milestone{mkMS("m1", 1), mkMS("m2", 2)},
		Items: []SkeletonItem{
			mkItem("i1", "Story", sptr("e1"), nil, sptr("m1"), "api-service", 3),
			mkItem("i1a", "Sub-task", sptr("i1"), nil, sptr("m1"), "api-service", 2),
			mkItem("i2", "Story", sptr("e1"), []string{"i1"}, sptr("m2"), "web-app", 4),
		},
	}

	oneNode := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door",
		Epic: nil, Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "web-app", 3)},
	}

	cycle := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{
			mkItem("i1", "Task", nil, []string{"i2"}, nil, "web-app", 1),
			mkItem("i2", "Task", nil, []string{"i1"}, nil, "web-app", 1),
		},
	}

	subUnderSub := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{
			mkItem("i1", "Story", nil, nil, nil, "web-app", 1),
			mkItem("i2", "Sub-task", sptr("i1"), nil, nil, "web-app", 1),
			mkItem("i3", "Sub-task", sptr("i2"), nil, nil, "web-app", 1),
		},
	}

	subUnderEpic := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door",
		Epic: &Epic{TempID: "e1", Summary: "s", Why: "w"}, Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Sub-task", sptr("e1"), nil, nil, "web-app", 1)},
	}

	danglingDep := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, []string{"i9"}, nil, "web-app", 1)},
	}

	danglingParent := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", sptr("i9"), nil, nil, "web-app", 1)},
	}

	danglingMilestone := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{mkMS("m1", 1)},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, sptr("m9"), "web-app", 1)},
	}

	nullMilestone := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{mkMS("m1", 1)},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "web-app", 1)},
	}

	orderViolation := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{
			mkItem("i1", "Task", nil, []string{"i2"}, nil, "web-app", 1),
			mkItem("i2", "Task", nil, nil, nil, "web-app", 1),
		},
	}

	forwardMilestone := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{mkMS("m1", 1), mkMS("m2", 2)},
		Items: []SkeletonItem{
			mkItem("i2", "Task", nil, nil, sptr("m2"), "web-app", 1),
			mkItem("i1", "Task", nil, []string{"i2"}, sptr("m1"), "web-app", 1),
		},
	}

	leafOverCap := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "web-app", 12)},
	}

	leafWarn := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "web-app", 8)},
	}

	unknownRepo := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "made-up-repo", 1)},
	}

	lockstepRepo := &Skeleton{
		PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{},
		Items: []SkeletonItem{mkItem("i1", "Task", nil, nil, nil, "cross-repo-lockstep", 1)},
	}

	tests := []struct {
		name      string
		skel      *Skeleton
		wantOK    bool
		failCheck string // check expected to fail ("" when wantOK)
		substr    string // expected substring in RegenComplaint
	}{
		{"valid multi-milestone tree", validTree, true, "", ""},
		{"one-node skeleton", oneNode, true, "", ""},
		{"dependency cycle", cycle, false, "acyclic", "cycle"},
		{"sub-task under sub-task", subUnderSub, false, "hierarchy_legal", "itself a Sub-task"},
		{"sub-task under epic", subUnderEpic, false, "hierarchy_legal", "is the epic"},
		{"dangling depends_on", danglingDep, false, "hierarchy_legal", "does not resolve"},
		{"dangling parent_temp_id", danglingParent, false, "hierarchy_legal", "does not resolve"},
		{"dangling milestone_id", danglingMilestone, false, "hierarchy_legal", "does not resolve to a declared milestone"},
		{"null milestone_id with milestones", nullMilestone, false, "hierarchy_legal", "must belong to a milestone"},
		{"dependency later than dependent", orderViolation, false, "order_consistent", "later in the items array"},
		{"forward milestone dependency", forwardMilestone, false, "milestone_shippable", "forward across a milestone"},
		{"leaf over cap is advisory WARN, non-blocking", leafOverCap, true, "", "advisory"},
		{"leaf in warn band", leafWarn, true, "", "WARN:"},
		{"over-fragmented tree is advisory WARN", manyLeaves(21), true, "", "WARN: tree has 21 leaves, exceeds max_tree_leaves 20"},
		{"too many sub-tasks is advisory WARN", manySubtasks(6), true, "", "WARN: parent: has 6 sub-tasks, exceeds max_subtasks_per_parent 5"},
		{"unknown repo", unknownRepo, false, "sizing_sane", "not in the known set"},
		{"lockstep repo passes sizing", lockstepRepo, true, "", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := ValidateSkeleton(tc.skel, th)

			if v.OK != tc.wantOK {
				t.Fatalf("OK = %v, want %v (regen: %q)", v.OK, tc.wantOK, v.RegenComplaint)
			}
			if v.HardFail == tc.wantOK {
				t.Fatalf("HardFail = %v, want %v", v.HardFail, !tc.wantOK)
			}
			if tc.failCheck != "" {
				if r, ok := v.Checks[tc.failCheck]; !ok || r.Pass {
					t.Fatalf("check %q: pass = %v (want failed); regen: %q", tc.failCheck, r.Pass, v.RegenComplaint)
				}
			}
			if tc.substr != "" && !strings.Contains(v.RegenComplaint, tc.substr) {
				t.Fatalf("regen %q does not contain %q", v.RegenComplaint, tc.substr)
			}
		})
	}

	// The advisory bounds are strictly greater-than checks: exactly-at-limit
	// trees must stay fully clean, not merely non-blocking. These fixtures are
	// constructed to avoid every unrelated advisory, so any complaint is a
	// regression in the exact-boundary behavior.
	for _, tc := range []struct {
		name string
		skel *Skeleton
	}{
		{"tree at max leaves is clean", manyLeaves(20)},
		{"parent at max sub-tasks is clean", manySubtasks(5)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := ValidateSkeleton(tc.skel, th)
			if !v.OK || v.HardFail {
				t.Fatalf("exact-boundary shape must pass cleanly; OK=%v hard_fail=%v regen=%q", v.OK, v.HardFail, v.RegenComplaint)
			}
			if v.RegenComplaint != "" {
				t.Fatalf("exact-boundary shape must have no advisory complaints, got %q", v.RegenComplaint)
			}
		})
	}
}

// ─────────────────────────── plan prechecks ──────────────────────────────

func mkPlanItem(id, repo, tier1, effort string, cost float64, anchors, zones, ac []string) PlanItem {
	return PlanItem{
		TempID: id, Type: "Task", Repo: repo, EffortTier: effort, PredictedCostUSD: cost,
		Fields: Fields{
			Why:              "neden",
			RelatedLinks:     RelatedLinks{External: []string{}, CodeAnchors: anchors},
			DefinitionOfDone: "tanım",
			TechnicalAnalysis: TechnicalAnalysis{
				Prose: "teknik prose", AffectedRepos: []string{repo},
				CouplingZones: zones, Tier1Decomposition: tier1, ReadOnlyRepos: []string{},
			},
			AcceptanceCriteria: ac,
		},
	}
}

func mkPlan(items ...PlanItem) *Plan {
	return &Plan{PlanID: "p", Requester: "r", RoleLens: "tech", Mode: "front_door", Milestones: []Milestone{}, Items: items}
}

func writeFile(t *testing.T, dir, rel, content string) string {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

func TestPrecheckPlan(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("missing AC fails fields_present", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, nil)
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v == nil {
			t.Fatal("no verdict for i1")
		}
		if v.Checks["fields_present"].Pass {
			t.Fatalf("fields_present should fail; regen: %q", v.RegenComplaint)
		}
		if v.OK {
			t.Fatal("verdict should be a hard fail")
		}
	})

	t.Run("blank AC entry fails fields_present", func(t *testing.T) {
		// A-Min2-Go: acceptance_criteria used to be validated by length only —
		// a whitespace-only entry satisfied len()>=1 and slipped through.
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"   "})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["fields_present"].Pass {
			t.Fatalf("fields_present should fail for a blank acceptance_criteria entry; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "acceptance_criteria[0]") {
			t.Fatalf("regen %q should name the blank entry by index", v.RegenComplaint)
		}
	})

	t.Run("lockstep without needs-human fails single_repo", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "cross-repo-lockstep", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["single_repo"].Pass {
			t.Fatalf("single_repo should fail; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("nonexistent anchor fails anchors_exist", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{"web-app:src/does-not-exist.ts"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["anchors_exist"].Pass {
			t.Fatalf("anchors_exist should fail; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("zone-member anchor with none fails zone_routing", func(t *testing.T) {
		dir := t.TempDir()
		seedOriginMainRepo(t, dir, "api-service", "internal/service/credit_service.go", "package x\n")
		cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: shared-write
    members:
      - "api-service:internal/service/credit_service.go"
`)
		item := mkPlanItem("i1", "api-service", "single-repo-sequenced", "low", 1,
			[]string{"api-service:internal/service/credit_service.go"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["zone_routing"].Pass {
			t.Fatalf("zone_routing should fail; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "no-go zone") {
			t.Fatalf("regen %q missing zone complaint", v.RegenComplaint)
		}
	})

	t.Run("fully valid item passes all", func(t *testing.T) {
		dir := t.TempDir()
		seedOriginMainRepo(t, dir, "api-service", "internal/service/credit_service.go", "package x\n")
		cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: shared-write
    members:
      - "api-service:internal/service/credit_service.go"
`)
		item := mkPlanItem("i1", "api-service", "needs-human", "high", 1,
			[]string{"api-service:internal/service/credit_service.go"}, []string{"shared-write"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if !v.OK {
			t.Fatalf("expected OK verdict; regen: %q", v.RegenComplaint)
		}
		if ps, ok := v.Checks["plan_structure"]; !ok || !ps.Pass {
			t.Fatalf("plan_structure should be present and passing on a valid plan; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("cost over cap is an advisory WARN on sizing_bounds, not a hard fail", func(t *testing.T) {
		// 2026-07-13 sizing-warn demotion: the $10 leaf cap is a work-SIZE
		// estimate, not metered money, so an over-cap leaf PASSES with an
		// advisory WARN instead of hard-failing.
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 12, nil, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		sb := v.Checks["sizing_bounds"]
		if !sb.Pass {
			t.Fatalf("sizing_bounds is advisory now — an over-cap leaf must PASS with a WARN; regen: %q", v.RegenComplaint)
		}
		if len(sb.Complaints) == 0 || !strings.HasPrefix(sb.Complaints[0], "WARN:") || !strings.Contains(sb.Complaints[0], "consider splitting") {
			t.Fatalf("expected an advisory over-cap WARN; got: %v", sb.Complaints)
		}
		if !v.OK {
			t.Fatalf("an over-cap leaf alone must not hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("parent roll-up and over-cap leaf both pass sizing_bounds with a WARN", func(t *testing.T) {
		// The sizing band gates LEAVES; a parent's cost is a
		// roll-up. Both are ADVISORY: the parent passes with the
		// roll-up "informational" WARN, and the over-cap leaf child passes with
		// the "consider splitting (advisory)" WARN — neither hard-fails.
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		parent := mkPlanItem("story", "web-app", "single-repo-sequenced", "medium", 14.5, nil, []string{"none"}, []string{"kriter"})
		childID := "story"
		childOK := mkPlanItem("sub-ok", "web-app", "single-repo-sequenced", "low", 3, nil, []string{"none"}, []string{"kriter"})
		childOK.ParentTempID = &childID
		childBig := mkPlanItem("sub-big", "web-app", "single-repo-sequenced", "low", 14.5, nil, []string{"none"}, []string{"kriter"})
		childBig.ParentTempID = &childID

		out := PrecheckPlan(mkPlan(parent, childOK, childBig), th, cm, dir)

		pv := out["story"].Checks["sizing_bounds"]
		if !pv.Pass {
			t.Fatalf("parent sizing_bounds should pass (leaf-only gate); complaints: %v", pv.Complaints)
		}
		if len(pv.Complaints) == 0 || !strings.HasPrefix(pv.Complaints[0], "WARN:") || !strings.Contains(pv.Complaints[0], "roll-up") {
			t.Fatalf("parent should carry the roll-up WARN complaint; got: %v", pv.Complaints)
		}
		if !out["sub-ok"].Checks["sizing_bounds"].Pass {
			t.Fatal("in-band leaf should pass sizing_bounds")
		}
		bigLeaf := out["sub-big"].Checks["sizing_bounds"]
		if !bigLeaf.Pass {
			t.Fatalf("an over-cap leaf is advisory now — it must PASS sizing_bounds with a WARN; complaints: %v", bigLeaf.Complaints)
		}
		if len(bigLeaf.Complaints) == 0 || !strings.Contains(bigLeaf.Complaints[0], "consider splitting") {
			t.Fatalf("over-cap leaf should carry the advisory split WARN; got: %v", bigLeaf.Complaints)
		}
	})

	t.Run("traversal anchor fails anchors_exist", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{"web-app:../../etc/passwd"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["anchors_exist"].Pass {
			t.Fatalf("anchors_exist should fail for a traversal anchor; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "escapes") {
			t.Fatalf("regen %q should mention the repos-root escape", v.RegenComplaint)
		}
	})
}

// ──────────── C1/C3: plan-level structural pre-gate ───────────────────────

func TestPlanStructurePreGate(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("duplicate temp_id fails plan_structure on every item", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		// The C1 exploit: an evil T1 (over-cap) followed by a clean T1 —
		// last write wins in the verdict map, so without the pre-gate the
		// clean twin's verdict masks the evil one entirely.
		evil := mkPlanItem("T1", "web-app", "single-repo-sequenced", "low", 50, nil, []string{"none"}, []string{"kriter"})
		clean := mkPlanItem("T1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		other := mkPlanItem("T2", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})

		out := PrecheckPlan(mkPlan(evil, clean, other), th, cm, dir)
		if len(out) != 2 { // T1 (collapsed by the map) + T2
			t.Fatalf("verdict map has %d entries, want 2", len(out))
		}
		for tid, v := range out {
			ps, ok := v.Checks["plan_structure"]
			if !ok {
				t.Fatalf("%s: plan_structure check missing from verdict", tid)
			}
			if ps.Pass {
				t.Fatalf("%s: plan_structure should fail on EVERY item (fail-closed); regen: %q", tid, v.RegenComplaint)
			}
			if v.OK || !v.HardFail {
				t.Fatalf("%s: verdict must be a hard fail", tid)
			}
			if !strings.Contains(v.RegenComplaint, "duplicate temp_id") {
				t.Fatalf("%s: regen %q should name the duplicate", tid, v.RegenComplaint)
			}
		}
	})

	t.Run("self-parent fails plan_structure and stays a leaf for sizing", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		// The C3 exploit: an item naming ITSELF as parent must not launder into a
		// "non-leaf". Sizing is ADVISORY now (2026-07-13) — the $999 over-cap
		// WARNs, never hard-fails — so leaf-vs-non-leaf only changes the WARN
		// WORDING; but the classification must still be correct: a self-parent
		// stays a LEAF, so it gets the leaf "consider splitting (advisory)" WARN,
		// NOT the parent roll-up "informational" note. The verdict still
		// HARD-fails via plan_structure (self-parent), independent of sizing.
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 999, nil, []string{"none"}, []string{"kriter"})
		item.ParentTempID = sptr("i1")

		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["plan_structure"].Pass {
			t.Fatalf("plan_structure should fail for a self-parent; regen: %q", v.RegenComplaint)
		}
		if v.OK || !v.HardFail {
			t.Fatalf("a self-parent must still hard-fail the verdict via plan_structure; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "references itself") {
			t.Fatalf("regen %q should name the self-parent", v.RegenComplaint)
		}
		sb := v.Checks["sizing_bounds"]
		if !sb.Pass {
			t.Fatalf("sizing_bounds is advisory now — a self-parent leaf must PASS it (WARN, not hard); regen: %q", v.RegenComplaint)
		}
		if len(sb.Complaints) == 0 || !strings.HasPrefix(sb.Complaints[0], "WARN:") || !strings.Contains(sb.Complaints[0], "consider splitting") {
			t.Fatalf("a self-parent stays a LEAF → the leaf advisory WARN, not the parent roll-up note; got: %v", sb.Complaints)
		}
		if strings.Contains(sb.Complaints[0], "roll-up") {
			t.Fatalf("a self-parent leaf must NOT get the parent roll-up wording (C3: classification preserved); got: %v", sb.Complaints)
		}
	})

	t.Run("dangling parent fails plan_structure", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		item.ParentTempID = sptr("ghost")

		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["plan_structure"].Pass {
			t.Fatalf("plan_structure should fail for a dangling parent; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "does not resolve") {
			t.Fatalf("regen %q should name the dangling reference", v.RegenComplaint)
		}
	})

	t.Run("parent chain loop fails plan_structure on every item", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		a := mkPlanItem("A", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		b := mkPlanItem("B", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		a.ParentTempID = sptr("B")
		b.ParentTempID = sptr("A")

		out := PrecheckPlan(mkPlan(a, b), th, cm, dir)
		for tid, v := range out {
			if v.Checks["plan_structure"].Pass {
				t.Fatalf("%s: plan_structure should fail for a parent loop; regen: %q", tid, v.RegenComplaint)
			}
			if !strings.Contains(v.RegenComplaint, "parent chain loops") {
				t.Fatalf("%s: regen %q should name the loop", tid, v.RegenComplaint)
			}
		}
	})

	t.Run("epic-parented items pass plan_structure", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		item.ParentTempID = sptr("e1")
		p := mkPlan(item)
		p.Epic = &Epic{TempID: "e1", Summary: "s", Why: "w"}

		v := PrecheckPlan(p, th, cm, dir)["i1"]
		if !v.Checks["plan_structure"].Pass {
			t.Fatalf("plan_structure should pass for an epic-parented item; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("malformed epic.existing_key hard-fails plan_structure at the gate", func(t *testing.T) {
		// The attach-mode key lands raw in the create tool's GET /issue/{key}
		// path and the tool dies on a non-key shape at create time — the gate
		// must catch it EARLIER (before groom spend feeds a doomed create).
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		mk := func(key *string) *Plan {
			item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
			item.ParentTempID = sptr("e1")
			p := mkPlan(item)
			p.Epic = &Epic{TempID: "e1", Summary: "s", Why: "w", ExistingKey: key}
			return p
		}

		for _, bad := range []string{"not a key", "proj-451", "PROJ-1/../secret?x=", "451-PROJ", "PROJ-", "1PROJ-451"} {
			v := PrecheckPlan(mk(sptr(bad)), th, cm, dir)["i1"]
			if v.Checks["plan_structure"].Pass {
				t.Fatalf("existing_key %q: plan_structure should hard-fail; regen: %q", bad, v.RegenComplaint)
			}
			if v.OK || !v.HardFail {
				t.Fatalf("existing_key %q: verdict must be a hard fail", bad)
			}
			if !strings.Contains(v.RegenComplaint, "existing_key") {
				t.Fatalf("existing_key %q: regen %q should name the field", bad, v.RegenComplaint)
			}
		}

		// Legal keys pass — including any project key prefix (the gate mirrors
		// the tool's project-agnostic jiraKeyRE, deliberately wider than the
		// schemas' letter-only pattern; see types.go's enum-set note). nil and
		// blank-after-trim mean "no attach" (the tool nulls them) and must
		// not fail either.
		for _, ok := range []*string{sptr("PROJ-451"), sptr("AB2-9"), sptr("  PROJ-1  "), sptr(""), sptr("   "), nil} {
			v := PrecheckPlan(mk(ok), th, cm, dir)["i1"]
			if !v.Checks["plan_structure"].Pass {
				t.Fatalf("existing_key %v: plan_structure should pass; regen: %q", ok, v.RegenComplaint)
			}
		}
	})
}

// ──────────────── A-M2: plan-mode hierarchy legality ──────────────────────

// mkTypedPlanItem is mkPlanItem with the type/parent overridden — the base
// helper hardcodes Type:"Task", which is unhelpful for legality tests that
// vary the type on purpose.
func mkTypedPlanItem(id, typ string, parent *string) PlanItem {
	it := mkPlanItem(id, "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
	it.Type = typ
	it.ParentTempID = parent
	return it
}

// TestHierarchyLegalPlanMode locks A-M2: checkPlanStructure never reads
// item.Type, so a re-typed item (Story parented by Story, a Sub-task chain,
// a Sub-task parented directly by the epic) used to sail through plan-mode
// treecheck. hierarchy_legal ports skeleton mode's checkParent rules to catch
// exactly this.
func TestHierarchyLegalPlanMode(t *testing.T) {
	th := loadTestThresholds(t)
	dir := t.TempDir()
	cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")

	t.Run("Story parented by another Story fails hierarchy_legal", func(t *testing.T) {
		parent := mkTypedPlanItem("s1", "Story", nil)
		child := mkTypedPlanItem("s2", "Story", sptr("s1"))
		out := PrecheckPlan(mkPlan(parent, child), th, cm, dir)
		v := out["s2"]
		if v.Checks["hierarchy_legal"].Pass {
			t.Fatalf("hierarchy_legal should fail: an L0 item cannot be parented by another item; regen: %q", v.RegenComplaint)
		}
		if !v.Checks["plan_structure"].Pass {
			t.Fatalf("plan_structure should still pass — the structure itself (a resolvable, non-looping parent edge) is fine; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("Sub-task parented by another Sub-task fails hierarchy_legal", func(t *testing.T) {
		story := mkTypedPlanItem("s1", "Story", nil)
		sub1 := mkTypedPlanItem("t1", "Sub-task", sptr("s1"))
		sub2 := mkTypedPlanItem("t2", "Sub-task", sptr("t1"))
		out := PrecheckPlan(mkPlan(story, sub1, sub2), th, cm, dir)
		v := out["t2"]
		if v.Checks["hierarchy_legal"].Pass {
			t.Fatalf("hierarchy_legal should fail: a Sub-task cannot be parented by another Sub-task; regen: %q", v.RegenComplaint)
		}
		if !out["t1"].Checks["hierarchy_legal"].Pass {
			t.Fatalf("t1 (a Sub-task legally parented by a Story) should still pass hierarchy_legal; regen: %q", out["t1"].RegenComplaint)
		}
	})

	t.Run("Sub-task with null parent fails hierarchy_legal", func(t *testing.T) {
		sub := mkTypedPlanItem("t1", "Sub-task", nil)
		out := PrecheckPlan(mkPlan(sub), th, cm, dir)
		v := out["t1"]
		if v.Checks["hierarchy_legal"].Pass {
			t.Fatalf("hierarchy_legal should fail: a Sub-task needs exactly one L0 parent; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "no parent") {
			t.Fatalf("regen %q should name the missing parent", v.RegenComplaint)
		}
	})

	t.Run("Sub-task parented by the epic temp_id fails hierarchy_legal", func(t *testing.T) {
		sub := mkTypedPlanItem("t1", "Sub-task", sptr("e1"))
		p := mkPlan(sub)
		p.Epic = &Epic{TempID: "e1", Summary: "s", Why: "w"}
		out := PrecheckPlan(p, th, cm, dir)
		v := out["t1"]
		if v.Checks["hierarchy_legal"].Pass {
			t.Fatalf("hierarchy_legal should fail: a Sub-task needs an L0 parent, never the epic; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "is the epic") {
			t.Fatalf("regen %q should name the epic-parent violation", v.RegenComplaint)
		}
	})

	t.Run("valid Epic to L0 to Sub-task plan passes hierarchy_legal", func(t *testing.T) {
		story := mkTypedPlanItem("s1", "Story", sptr("e1"))
		sub := mkTypedPlanItem("t1", "Sub-task", sptr("s1"))
		p := mkPlan(story, sub)
		p.Epic = &Epic{TempID: "e1", Summary: "s", Why: "w"}
		out := PrecheckPlan(p, th, cm, dir)
		for tid, v := range out {
			if !v.Checks["hierarchy_legal"].Pass {
				t.Fatalf("%s: hierarchy_legal should pass on a legal Epic→L0→Sub-task plan; regen: %q", tid, v.RegenComplaint)
			}
		}
	})
}

// ──────────────── C2: case-insensitive zone matching ──────────────────────

func TestZoneRoutingCaseInsensitive(t *testing.T) {
	th := loadTestThresholds(t)

	const memberMap = `no_go_zones:
  - id: shared-write
    members:
      - "worker-service:src/subscription/services/subscription.service.js"
`

	cases := []struct{ name, anchor string }{
		{"wrong-case repo", "Worker-Service:src/subscription/services/subscription.service.js"},
		{"wrong-case path", "worker-service:SRC/subscription/services/subscription.service.js"},
		{"wrong-case both", "WORKER-SERVICE:src/SUBSCRIPTION/services/Subscription.Service.JS"},
	}
	for _, tc := range cases {
		t.Run(tc.name+" cannot dodge the coupling zone", func(t *testing.T) {
			dir := t.TempDir()
			cm := writeFile(t, dir, "coupling-map.yaml", memberMap)
			item := mkPlanItem("i1", "worker-service", "single-repo-sequenced", "low", 1,
				[]string{tc.anchor}, []string{"none"}, []string{"kriter"})
			v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
			if v.Checks["zone_routing"].Pass {
				t.Fatalf("zone_routing should FAIL for %q — zone matching must be case-insensitive; regen: %q", tc.anchor, v.RegenComplaint)
			}
			if !strings.Contains(v.RegenComplaint, "shared-write") {
				t.Fatalf("complaint should name shared-write; regen: %q", v.RegenComplaint)
			}
		})
	}

	t.Run("uppercase map member matches lowercase anchor", func(t *testing.T) {
		// Both sides are normalized: an oddly-cased MEMBER must still cover a
		// lowercase anchor.
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: shared-write
    members:
      - "Worker-Service:SRC/subscription/services/subscription.service.js"
`)
		item := mkPlanItem("i1", "worker-service", "single-repo-sequenced", "low", 1,
			[]string{"worker-service:src/subscription/services/subscription.service.js"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		if v.Checks["zone_routing"].Pass {
			t.Fatalf("zone_routing should FAIL; regen: %q", v.RegenComplaint)
		}
	})
}

// ──────────────── W3: malformed zone member fails closed ──────────────────

func TestMalformedZoneMemberFailsClosed(t *testing.T) {
	th := loadTestThresholds(t)

	for name, member := range map[string]string{
		"missing repo prefix":    "src/payment/services/payment-callback.service.js",
		"empty path":             "worker-service:",
		"dot path":               "api-service:.",
		"path normalizes to dot": "api-service:foo/..",
		"traversing member path": "api-service:../internal/account",
		"absolute member path":   "api-service:/internal/account",
		"traversing repo":        "../api:src",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: shared-write
    members:
      - "`+member+`"
`)
			a := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
			b := mkPlanItem("i2", "worker-service", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
			out := PrecheckPlan(mkPlan(a, b), th, cm, dir)
			for tid, v := range out {
				zr := v.Checks["zone_routing"]
				if zr.Pass {
					t.Fatalf("%s: zone_routing should hard-fail when the map has a malformed member (fail-closed, like a missing map)", tid)
				}
				if !strings.Contains(strings.Join(zr.Complaints, "\n"), "malformed") {
					t.Fatalf("%s: complaint should say the map is malformed: %v", tid, zr.Complaints)
				}
				if !v.HardFail {
					t.Fatalf("%s: must be a hard fail", tid)
				}
			}
		})
	}
}

func TestNoGoZoneDeclarationValidationFailsClosed(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("empty map remains valid", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		zones, err := loadNoGoZones(cm)
		if err != nil {
			t.Fatalf("empty no_go_zones must remain legal: %v", err)
		}
		if len(zones) != 0 {
			t.Fatalf("empty no_go_zones returned %d zones, want 0", len(zones))
		}

		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
		zr := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"].Checks["zone_routing"]
		if !zr.Pass {
			t.Fatalf("empty no_go_zones should pass zone_routing: %v", zr.Complaints)
		}
	})

	cases := map[string]string{
		"empty top-level object": `{}
`,
		"missing no_go_zones key": `version: 1
`,
		"misspelled no_go_zones key": `no_go_zonez: []
`,
		"null no_go_zones": `no_go_zones: null
`,
		"scalar no_go_zones": `no_go_zones: shared-write
`,
		"object no_go_zones": `no_go_zones: {}
`,
		"duplicate no_go_zones key": `no_go_zones: []
no_go_zones: []
`,
		"empty declared zone": `no_go_zones:
  - {}
`,
		"empty zone id": `no_go_zones:
  - id: " "
    members:
      - "api-service:internal/account"
`,
		"empty members list": `no_go_zones:
  - id: shared-write
    members: []
`,
		"sentinel none zone id": `no_go_zones:
  - id: none
    members:
      - "api-service:internal/account"
`,
		"unknown zone id": `no_go_zones:
  - id: invented-zone
    members:
      - "api-service:internal/account"
`,
		"duplicate zone id": `no_go_zones:
  - id: shared-write
    members:
      - "api-service:internal/account"
  - id: shared-write
    members:
      - "worker-service:jobs/account"
`,
		"guide-style anchors object": `no_go_zones:
  - id: shared-write
    anchors:
      - repo: api-service
        path: internal/account
`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cm := writeFile(t, dir, "coupling-map.yaml", content)
			if _, err := loadNoGoZones(cm); err == nil {
				t.Fatal("invalid declared zone should return a coupling-map load error")
			}

			item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"kriter"})
			v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
			zr := v.Checks["zone_routing"]
			if zr.Pass {
				t.Fatalf("zone_routing should fail closed for an invalid declared zone: %v", zr.Complaints)
			}
			if !v.HardFail {
				t.Fatalf("invalid declared zone must hard-fail the verdict: %v", zr.Complaints)
			}
			if !strings.Contains(strings.Join(zr.Complaints, "\n"), "malformed") {
				t.Fatalf("complaint should identify a malformed coupling map: %v", zr.Complaints)
			}
		})
	}

	t.Run("none sentinel cannot become a matching map-zone bypass", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: none
    members:
      - "web-app:src/sensitive"
`)
		item := mkPlanItem(
			"i1",
			"web-app",
			"single-repo-sequenced",
			"low",
			1,
			[]string{"web-app:src/sensitive/write.ts"},
			[]string{"none"},
			[]string{"criterion"},
		)
		v := PrecheckPlan(mkPlan(item), th, cm, dir)["i1"]
		zr := v.Checks["zone_routing"]
		if zr.Pass || !v.HardFail {
			t.Fatalf("a map declaring id:none must hard-fail instead of treating the matching anchor as uncoupled: %v", zr.Complaints)
		}
		if !strings.Contains(strings.Join(zr.Complaints, "\n"), "legal non-none coupling zone") {
			t.Fatalf("complaint should explain that none is not a legal map-zone id: %v", zr.Complaints)
		}
	})
}

// ──────────────── origin/main anchor resolution ───────────────────────────

// gitCmd runs a git command for test setup with global/system config isolated,
// so a developer's gitconfig (signing, hooks, templates) cannot break the test.
func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// snapshotOriginMainRepo commits the current contents of repoDir and points
// refs/remotes/origin/main at that commit. Tests that expect anchors_exist to
// pass must call this instead of relying on working-tree files.
func snapshotOriginMainRepo(t *testing.T, repoDir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	gitCmd(t, repoDir, "init")
	gitCmd(t, repoDir, "add", ".")
	gitCmd(t, repoDir, "commit", "-m", "seed", "--no-gpg-sign")
	gitCmd(t, repoDir, "update-ref", "refs/remotes/origin/main", "HEAD")
}

func TestAnchorsExistOriginMain(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	th := loadTestThresholds(t)

	root := t.TempDir()
	repoDir := filepath.Join(root, "somerepo")
	writeFile(t, root, "somerepo/tracked.go", "package x\n")
	writeFile(t, root, "somerepo/sub/dir/file.go", "package y\n")
	snapshotOriginMainRepo(t, repoDir)
	// Working-tree-only file: present on disk, absent from origin/main.
	writeFile(t, root, "somerepo/untracked.go", "package z\n")

	cm := writeFile(t, root, "coupling-map.yaml", "no_go_zones: []\n")

	run := func(anchor string) *Verdict {
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{anchor}, []string{"none"}, []string{"kriter"})
		return PrecheckPlan(mkPlan(item), th, cm, root)["i1"]
	}

	t.Run("anchor on origin/main passes without WARN", func(t *testing.T) {
		v := run("somerepo:tracked.go")
		ae := v.Checks["anchors_exist"]
		if !ae.Pass || len(ae.Complaints) != 0 {
			t.Fatalf("expected a clean pass, got pass=%v complaints=%v", ae.Pass, ae.Complaints)
		}
	})

	t.Run("directory anchor resolves as a tree on origin/main", func(t *testing.T) {
		for _, a := range []string{"somerepo:sub/dir", "somerepo:sub/dir/"} {
			v := run(a)
			ae := v.Checks["anchors_exist"]
			if !ae.Pass || len(ae.Complaints) != 0 {
				t.Fatalf("%s: expected a clean pass, got pass=%v complaints=%v", a, ae.Pass, ae.Complaints)
			}
		}
	})

	t.Run("working-tree-only anchor FAILS against origin/main", func(t *testing.T) {
		v := run("somerepo:untracked.go")
		ae := v.Checks["anchors_exist"]
		if ae.Pass {
			t.Fatalf("anchors_exist should fail: the file exists only in the working tree, not on origin/main; complaints: %v", ae.Complaints)
		}
		if !strings.Contains(v.RegenComplaint, "origin/main") {
			t.Fatalf("complaint should name origin/main; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("non-git repo hard-fails even when the file exists locally", func(t *testing.T) {
		plainRoot := t.TempDir()
		writeFile(t, plainRoot, "plainrepo/file.go", "package p\n")
		cm2 := writeFile(t, plainRoot, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{"plainrepo:file.go"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm2, plainRoot)["i1"]
		ae := v.Checks["anchors_exist"]
		if ae.Pass {
			t.Fatalf("anchors_exist must fail closed without origin/main; complaints: %v", ae.Complaints)
		}
		if len(ae.Complaints) != 1 || strings.HasPrefix(ae.Complaints[0], "WARN: ") ||
			!strings.Contains(ae.Complaints[0], "origin/main is unavailable") {
			t.Fatalf("expected a hard complaint naming origin/main unavailability, got: %v", ae.Complaints)
		}
		if v.OK || !v.HardFail {
			t.Fatalf("unavailable origin/main must hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("git repo without origin/main hard-fails even when the file is committed locally", func(t *testing.T) {
		localRoot := t.TempDir()
		repoDir := filepath.Join(localRoot, "localrepo")
		writeFile(t, localRoot, "localrepo/file.go", "package p\n")
		gitCmd(t, repoDir, "init")
		gitCmd(t, repoDir, "add", ".")
		gitCmd(t, repoDir, "commit", "-m", "local-only", "--no-gpg-sign")
		cm2 := writeFile(t, localRoot, "coupling-map.yaml", "no_go_zones: []\n")
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{"localrepo:file.go"}, []string{"none"}, []string{"kriter"})
		v := PrecheckPlan(mkPlan(item), th, cm2, localRoot)["i1"]
		ae := v.Checks["anchors_exist"]
		if ae.Pass || !v.HardFail {
			t.Fatalf("a local commit without origin/main must fail closed; complaints: %v", ae.Complaints)
		}
		if !strings.Contains(strings.Join(ae.Complaints, "\n"), "origin/main is unavailable") {
			t.Fatalf("hard complaint should name unavailable origin/main: %v", ae.Complaints)
		}
	})
}

// ───────────────────────── contract validation ───────────────────────────

// TestSupportedRepoUniverseStaysAligned makes the deliberate defense-in-depth
// copies of the repository universe auditable: the runtime contract is the
// canonical gate, while both wire schemas and the known-repo precheck set must
// stay exactly synchronized with it.
func TestSupportedRepoUniverseStaysAligned(t *testing.T) {
	th := loadTestThresholds(t)
	wantKnown := make([]string, 0, len(repoEnum)-1)
	for _, repo := range repoEnum {
		if repo != th.Repos.LockstepMarker {
			wantKnown = append(wantKnown, repo)
		}
	}
	if !slices.Equal(th.Repos.Known, wantKnown) {
		t.Fatalf("thresholds repos.known = %v, want runtime contract repos excluding %q: %v", th.Repos.Known, th.Repos.LockstepMarker, wantKnown)
	}

	for _, schemaPath := range []string{
		"../../contracts/skeleton.schema.json",
		"../../contracts/plan.schema.json",
	} {
		raw, err := os.ReadFile(schemaPath)
		if err != nil {
			t.Fatalf("read %s: %v", schemaPath, err)
		}
		var schema map[string]any
		if err := json.Unmarshal(raw, &schema); err != nil {
			t.Fatalf("parse %s: %v", schemaPath, err)
		}
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s: properties is not an object", schemaPath)
		}
		items, ok := properties["items"].(map[string]any)
		if !ok {
			t.Fatalf("%s: properties.items is not an object", schemaPath)
		}
		itemSchema, ok := items["items"].(map[string]any)
		if !ok {
			t.Fatalf("%s: properties.items.items is not an object", schemaPath)
		}
		itemProperties, ok := itemSchema["properties"].(map[string]any)
		if !ok {
			t.Fatalf("%s: item properties is not an object", schemaPath)
		}
		repoSchema, ok := itemProperties["repo"].(map[string]any)
		if !ok {
			t.Fatalf("%s: repo schema is not an object", schemaPath)
		}
		rawEnum, ok := repoSchema["enum"].([]any)
		if !ok {
			t.Fatalf("%s: repo enum is missing", schemaPath)
		}
		got := make([]string, 0, len(rawEnum))
		for _, value := range rawEnum {
			repo, ok := value.(string)
			if !ok {
				t.Fatalf("%s: repo enum value %v is not a string", schemaPath, value)
			}
			got = append(got, repo)
		}
		if !slices.Equal(got, repoEnum) {
			t.Fatalf("%s repo enum = %v, want runtime contract enum %v", schemaPath, got, repoEnum)
		}
	}
}

// TestSkeletonOutputLanguageCompatibilitySchema locks the one intentional root
// metadata exception to the same narrow enum enforced by ValidateSkeletonContract.
// It prevents a future schema broadening from silently accepting arbitrary
// Decomposer metadata at the externally published contract boundary.
func TestSkeletonOutputLanguageCompatibilitySchema(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/skeleton.schema.json")
	if err != nil {
		t.Fatalf("read skeleton schema: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse skeleton schema: %v", err)
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatal("skeleton schema properties is not an object")
	}
	outputLanguage, ok := properties["output_language"].(map[string]any)
	if !ok {
		t.Fatal("skeleton schema is missing the audited output_language compatibility property")
	}
	if got, _ := outputLanguage["type"].(string); got != "string" {
		t.Fatalf("skeleton output_language type = %q, want string", got)
	}
	rawEnum, ok := outputLanguage["enum"].([]any)
	if !ok {
		t.Fatal("skeleton output_language schema enum is missing")
	}
	got := make([]string, 0, len(rawEnum))
	for _, value := range rawEnum {
		language, ok := value.(string)
		if !ok {
			t.Fatalf("output_language enum value %v is not a string", value)
		}
		got = append(got, language)
	}
	if !slices.Equal(got, outputLanguageEnum) {
		t.Fatalf("skeleton output_language enum = %v, want runtime allowlist %v", got, outputLanguageEnum)
	}
}

func TestContractValidation(t *testing.T) {
	validSkeleton := `{
  "plan_id": "p", "requester": "r", "mode": "front_door",
  "epic": null, "milestones": [],
  "items": [{
    "temp_id": "i1", "type": "Task", "parent_temp_id": null,
    "depends_on": [], "milestone_id": null, "repo": "web-app",
    "size_estimate": {"tier": "low", "predicted_cost_usd": 1.0, "rationale": "r"},
    "one_line_summary": "özet"
  }]
}`

	t.Run("valid skeleton has no contract complaints", func(t *testing.T) {
		_, complaints := ValidateSkeletonContract([]byte(validSkeleton))
		if len(complaints) != 0 {
			t.Fatalf("unexpected complaints: %v", complaints)
		}
	})

	t.Run("malformed JSON is a contract failure", func(t *testing.T) {
		_, complaints := ValidateSkeletonContract([]byte(`{not json`))
		if len(complaints) == 0 {
			t.Fatal("expected a contract complaint for malformed JSON")
		}
	})

	t.Run("missing required key is reported", func(t *testing.T) {
		_, complaints := ValidateSkeletonContract([]byte(`{"plan_id":"p"}`))
		joined := strings.Join(complaints, "\n")
		if !strings.Contains(joined, "missing required key") {
			t.Fatalf("expected missing-key complaint, got: %v", complaints)
		}
	})

	t.Run("unknown field is rejected", func(t *testing.T) {
		bad := strings.Replace(validSkeleton, `"plan_id": "p",`, `"plan_id": "p", "surprise": 1,`, 1)
		_, complaints := ValidateSkeletonContract([]byte(bad))
		if len(complaints) == 0 {
			t.Fatal("expected a contract complaint for an unknown field")
		}
	})

	t.Run("allowlisted output_language is accepted and visibly audited", func(t *testing.T) {
		good := strings.Replace(validSkeleton, `"mode": "front_door",`, `"mode": "front_door", "output_language": "tr",`, 1)
		s, complaints := ValidateSkeletonContract([]byte(good))
		if len(complaints) != 0 {
			t.Fatalf("allowlisted metadata unexpectedly failed contract: %v", complaints)
		}
		if s.OutputLanguage == nil || *s.OutputLanguage != "tr" {
			t.Fatalf("output_language was not preserved for audit: %#v", s.OutputLanguage)
		}
		v := ValidateSkeleton(s, loadTestThresholds(t))
		audit := v.Checks["output_language_metadata"]
		if !audit.Pass || !strings.Contains(strings.Join(audit.Complaints, "\n"), "accepted as allowlisted compatibility metadata") {
			t.Fatalf("metadata allowance must be a visible non-blocking audit record, got: %#v", audit)
		}
		if !v.OK {
			t.Fatalf("allowlisted metadata must not hard-fail: %q", v.RegenComplaint)
		}
	})

	t.Run("output_language exact allowlist preserves unknown-field and type failures", func(t *testing.T) {
		unsupported := strings.Replace(validSkeleton, `"mode": "front_door",`, `"mode": "front_door", "output_language": "de",`, 1)
		if _, complaints := ValidateSkeletonContract([]byte(unsupported)); !complaintsContain(complaints, `output_language "de"`) {
			t.Fatalf("unsupported output_language must hard-fail the exact enum, got: %v", complaints)
		}

		wrongType := strings.Replace(validSkeleton, `"mode": "front_door",`, `"mode": "front_door", "output_language": 7,`, 1)
		if _, complaints := ValidateSkeletonContract([]byte(wrongType)); !complaintsContain(complaints, "cannot unmarshal number") {
			t.Fatalf("non-string output_language must remain a strict decode failure, got: %v", complaints)
		}

		unknownAlongsideAllowed := strings.Replace(validSkeleton, `"mode": "front_door",`, `"mode": "front_door", "output_language": "en", "surprise": 1,`, 1)
		if _, complaints := ValidateSkeletonContract([]byte(unknownAlongsideAllowed)); !complaintsContain(complaints, `unknown field "surprise"`) {
			t.Fatalf("the narrow allowlist must not admit arbitrary sibling metadata, got: %v", complaints)
		}
	})

	// M1 — enum values are enforced by the contract gate, mirroring the JSON schemas.
	t.Run("Epic item type is a contract failure", func(t *testing.T) {
		bad := strings.Replace(validSkeleton, `"type": "Task"`, `"type": "Epic"`, 1)
		_, complaints := ValidateSkeletonContract([]byte(bad))
		if !complaintsContain(complaints, `"Epic"`) {
			t.Fatalf("expected an enum complaint naming Epic, got: %v", complaints)
		}
	})

	t.Run("banana mode is a contract failure", func(t *testing.T) {
		bad := strings.Replace(validSkeleton, `"mode": "front_door"`, `"mode": "banana-mode"`, 1)
		_, complaints := ValidateSkeletonContract([]byte(bad))
		if !complaintsContain(complaints, `"banana-mode"`) {
			t.Fatalf("expected an enum complaint naming banana-mode, got: %v", complaints)
		}
	})

	t.Run("galactic size tier is a contract failure", func(t *testing.T) {
		bad := strings.Replace(validSkeleton, `"tier": "low"`, `"tier": "galactic"`, 1)
		_, complaints := ValidateSkeletonContract([]byte(bad))
		if !complaintsContain(complaints, `"galactic"`) {
			t.Fatalf("expected an enum complaint naming galactic, got: %v", complaints)
		}
	})

	t.Run("supported repos api-service worker-service and shared-lib are legal", func(t *testing.T) {
		for _, repo := range []string{"api-service", "worker-service", "shared-lib"} {
			good := strings.Replace(validSkeleton, `"repo": "web-app"`, `"repo": "`+repo+`"`, 1)
			_, complaints := ValidateSkeletonContract([]byte(good))
			if len(complaints) != 0 {
				t.Fatalf("repo %q should be contract-legal, got: %v", repo, complaints)
			}
		}
	})
}

func complaintsContain(complaints []string, sub string) bool {
	return strings.Contains(strings.Join(complaints, "\n"), sub)
}

func TestPlanContractEnums(t *testing.T) {
	validPlan := `{
  "plan_id": "p", "requester": "r", "role_lens": "tech", "mode": "front_door",
  "epic": null, "milestones": [],
  "items": [{
    "temp_id": "i1", "type": "Task", "parent_temp_id": null,
    "depends_on": [], "milestone_id": null, "repo": "web-app",
    "effort_tier": "low", "predicted_cost_usd": 1.0,
    "fields": {
      "why": "neden",
      "related_links": {"external": [], "code_anchors": []},
      "definition_of_done": "tanım",
      "technical_analysis": {
        "prose": "teknik", "affected_repos": ["web-app"], "coupling_zones": ["none"],
        "tier1_decomposition": "single-repo-sequenced", "read_only_repos": []
      },
      "acceptance_criteria": ["kriter"]
    }
  }]
}`

	t.Run("valid plan has no contract complaints", func(t *testing.T) {
		_, complaints := ValidatePlanContract([]byte(validPlan))
		if len(complaints) != 0 {
			t.Fatalf("unexpected complaints: %v", complaints)
		}
	})

	cases := []struct{ name, from, to, wantSub string }{
		{"role_lens", `"role_lens": "tech"`, `"role_lens": "manager"`, `"manager"`},
		{"mode", `"mode": "front_door"`, `"mode": "banana-mode"`, `"banana-mode"`},
		{"item type", `"type": "Task"`, `"type": "Epic"`, `"Epic"`},
		{"effort_tier", `"effort_tier": "low"`, `"effort_tier": "galactic"`, `"galactic"`},
		{"repo", `"repo": "web-app"`, `"repo": "skynet"`, `"skynet"`},
		{"tier1_decomposition", `"tier1_decomposition": "single-repo-sequenced"`, `"tier1_decomposition": "vibes"`, `"vibes"`},
		{"coupling_zones entry", `"coupling_zones": ["none"]`, `"coupling_zones": ["sre-zone"]`, `"sre-zone"`},
	}
	for _, tc := range cases {
		t.Run(tc.name+" enum is enforced", func(t *testing.T) {
			bad := strings.Replace(validPlan, tc.from, tc.to, 1)
			if bad == validPlan {
				t.Fatalf("mutation %q did not apply", tc.from)
			}
			_, complaints := ValidatePlanContract([]byte(bad))
			if !complaintsContain(complaints, tc.wantSub) {
				t.Fatalf("expected an enum complaint containing %s, got: %v", tc.wantSub, complaints)
			}
		})
	}

	t.Run("score.verdict enum is enforced when present", func(t *testing.T) {
		bad := strings.Replace(validPlan, `"predicted_cost_usd": 1.0,`,
			`"predicted_cost_usd": 1.0, "score": {"total": 90, "by_field": {}, "verdict": "MAYBE"},`, 1)
		_, complaints := ValidatePlanContract([]byte(bad))
		if !complaintsContain(complaints, `"MAYBE"`) {
			t.Fatalf("expected an enum complaint naming MAYBE, got: %v", complaints)
		}
	})
}

// TestTicketServicePlanContractAndOriginMainAnchor reproduces the production
// failure class: api-service must pass the wire contract, the known-repo
// gate, and an origin/main anchor check. The repo is hermetic but uses the
// real service name and a real entrypoint-shaped anchor, so this test catches
// a schema-only or threshold-only addition.
func TestTicketServicePlanContractAndOriginMainAnchor(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}

	th := loadTestThresholds(t)
	root := t.TempDir()
	seedOriginMainRepo(t, root, "api-service", "cmd/api/main.go", "package main\n\nfunc main() {}\n")
	cm := writeFile(t, root, "coupling-map.yaml", "no_go_zones: []\n")
	item := mkPlanItem("api-service-deploy", "api-service", "single-repo-sequenced", "medium", 3,
		[]string{"api-service:cmd/api/main.go:main"}, []string{"none"}, []string{"api-service deploy is validated"})
	plan := mkPlan(item)

	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	if _, complaints := ValidatePlanContract(raw); len(complaints) != 0 {
		t.Fatalf("api-service plan must be contract-valid, got: %v", complaints)
	}

	verdict := PrecheckPlan(plan, th, cm, root)[item.TempID]
	if !verdict.OK {
		t.Fatalf("api-service plan and origin/main anchor must pass every precheck; regen: %q", verdict.RegenComplaint)
	}

	// Mutation proof: admitting api-service must not turn the repo gate into
	// an open allowlist. The exact adjacent unknown value still fails at the
	// contract boundary before any worker can plan against an arbitrary path.
	item.Repo = "api-service-typo"
	item.Fields.TechnicalAnalysis.AffectedRepos = []string{item.Repo}
	mutant := mkPlan(item)
	mutantRaw, err := json.Marshal(mutant)
	if err != nil {
		t.Fatalf("marshal unknown-repo mutant: %v", err)
	}
	if _, complaints := ValidatePlanContract(mutantRaw); !complaintsContain(complaints, `"api-service-typo"`) {
		t.Fatalf("unknown repo mutant must fail closed at the contract boundary, got: %v", complaints)
	}
	mutantVerdict := PrecheckPlan(mutant, th, cm, root)[item.TempID]
	if mutantVerdict.Checks["single_repo"].Pass {
		t.Fatalf("unknown repo mutant must fail the deterministic known-repo gate; regen: %q", mutantVerdict.RegenComplaint)
	}
}

// ─────────── scalar-or-array string fields (FlexStrings) ──────────────────

// flexEqual compares a FlexStrings to a want slice by length + elements (nil and
// []string{} both read as length 0 — that is all the downstream range/len logic
// distinguishes).
func flexEqual(a FlexStrings, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestFlexStringsUnmarshal locks the scalar-vs-array SHAPE tolerance: a single
// JSON string decodes to a one-element slice, an array decodes as-is, null to
// nil — but a non-string scalar (number/bool/object) or a non-string array
// element is still a decode error (bad VALUES/types are never laundered).
func TestFlexStringsUnmarshal(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
		err  bool
	}{
		{"array of strings", `["a","b"]`, []string{"a", "b"}, false},
		{"single-element array", `["none"]`, []string{"none"}, false},
		{"scalar string normalizes to one element", `"none"`, []string{"none"}, false},
		{"empty array", `[]`, []string{}, false},
		{"null decodes to nil", `null`, nil, false},
		{"number scalar is rejected", `123`, nil, true},
		{"bool scalar is rejected", `true`, nil, true},
		{"object is rejected", `{"a":1}`, nil, true},
		{"non-string array element is rejected", `["ok",7]`, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var fs FlexStrings
			err := json.Unmarshal([]byte(tc.in), &fs)
			if tc.err {
				if err == nil {
					t.Fatalf("expected a decode error for %s, got %v", tc.in, fs)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error decoding %s: %v", tc.in, err)
			}
			if !flexEqual(fs, tc.want) {
				t.Fatalf("decoded %s -> %v, want %v", tc.in, fs, tc.want)
			}
		})
	}
}

// scalarZonePlan is a groomed plan whose string-array fields are emitted as
// bare scalars (coupling_zones / affected_repos as a single string, not an
// array) — the exact live Groomer shape that used to hard-BLOCK the whole plan
// at decode and bypass the deterministic gate. %s slots in the scalar zone.
const scalarZonePlanTmpl = `{
  "plan_id": "p", "requester": "r", "role_lens": "tech", "mode": "front_door",
  "epic": null, "milestones": [],
  "items": [{
    "temp_id": "i1", "type": "Task", "parent_temp_id": null,
    "depends_on": [], "milestone_id": null, "repo": "api-service",
    "effort_tier": "%s", "predicted_cost_usd": 1.0,
    "fields": {
      "why": "neden",
      "related_links": {"external": [], "code_anchors": ["api-service:internal/service/credit_service.go"]},
      "definition_of_done": "tanım",
      "technical_analysis": {
        "prose": "teknik", "affected_repos": "api-service", "coupling_zones": "%s",
        "tier1_decomposition": "needs-human", "read_only_repos": []
      },
      "acceptance_criteria": ["kriter"]
    }
  }]
}`

// TestScalarCouplingZonesParsesAndGates is the safety-critical regression: a
// plan with scalar string-array fields must now (a) PARSE the contract gate,
// and (b) let the deterministic zone_routing check actually RUN — firing on the
// shared-write zone that the pre-fix fail-open silently bypassed.
func TestScalarCouplingZonesParsesAndGates(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("scalar shared-write parses AND hard-fails zone_routing on wrong effort", func(t *testing.T) {
		// coupling_zones:"shared-write" (scalar) with effort_tier low: a coupled
		// ticket MUST be high|max, so zone_routing hard-fails — proving the gate
		// runs on the shared-write zone instead of being bypassed at decode.
		raw := []byte(fmt.Sprintf(scalarZonePlanTmpl, "low", "shared-write")) // effort, zone

		p, complaints := ValidatePlanContract(raw)
		if len(complaints) != 0 {
			t.Fatalf("scalar coupling_zones should PARSE now, got contract complaints: %v", complaints)
		}
		if got := p.Items[0].Fields.TechnicalAnalysis.CouplingZones; !flexEqual(got, []string{"shared-write"}) {
			t.Fatalf("scalar coupling_zones normalized to %v, want [shared-write]", got)
		}
		if got := p.Items[0].Fields.TechnicalAnalysis.AffectedRepos; !flexEqual(got, []string{"api-service"}) {
			t.Fatalf("scalar affected_repos normalized to %v, want [api-service]", got)
		}

		dir := t.TempDir()
		seedOriginMainRepo(t, dir, "api-service", "internal/service/credit_service.go", "package x\n")
		cm := writeFile(t, dir, "coupling-map.yaml", `no_go_zones:
  - id: shared-write
    members:
      - "api-service:internal/service/credit_service.go"
`)
		v := PrecheckPlan(p, th, cm, dir)["i1"]
		if v.Checks["zone_routing"].Pass {
			t.Fatalf("zone_routing must hard-fail (shared-write zone at effort low); regen: %q", v.RegenComplaint)
		}
		if v.OK || !v.HardFail {
			t.Fatalf("verdict must be a hard fail once the gate runs; regen: %q", v.RegenComplaint)
		}
		if !strings.Contains(v.RegenComplaint, "high or max") {
			t.Fatalf("complaint should name the high/max effort rule; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("scalar none on a clean single-repo ticket parses AND passes", func(t *testing.T) {
		// A clean ticket: swap the credit anchor out so nothing lands in a zone.
		raw := []byte(strings.Replace(
			fmt.Sprintf(scalarZonePlanTmpl, "low", "none"),
			`["api-service:internal/service/credit_service.go"]`,
			`["api-service:go.mod"]`, 1))

		p, complaints := ValidatePlanContract(raw)
		if len(complaints) != 0 {
			t.Fatalf("scalar coupling_zones:\"none\" should PARSE, got: %v", complaints)
		}
		dir := t.TempDir()
		seedOriginMainRepo(t, dir, "api-service", "go.mod", "module x\n")
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		v := PrecheckPlan(p, th, cm, dir)["i1"]
		if !v.OK {
			t.Fatalf("a clean scalar-none ticket should PASS every check; regen: %q", v.RegenComplaint)
		}
	})

	t.Run("scalar banana still fails the enum check", func(t *testing.T) {
		// FlexStrings tolerates the SHAPE, never a bad VALUE.
		raw := []byte(fmt.Sprintf(scalarZonePlanTmpl, "low", "banana"))
		_, complaints := ValidatePlanContract(raw)
		if !complaintsContain(complaints, `"banana"`) {
			t.Fatalf("scalar coupling_zones:\"banana\" must still fail the enum, got: %v", complaints)
		}
	})
}

// ─────────────── B1: zone routing against the REAL coupling map ───────────

// TestZoneRoutingRealCouplingMap loads the REAL coupling-map.yaml (not a
// fixture) and asserts, for EVERY no-go-zone member the map actually declares,
// that zone_routing enforces both directions: an anchor that lands on that
// member with coupling_zones ["none"] must FAIL zone_routing (and the complaint
// must name that zone id), while re-declaring the zone with needs-human + high
// must PASS. Expectations are DERIVED from the map's own contents (via the
// same-package loadNoGoZones), not hardcoded, so this stays correct as the
// coupling map is re-seeded per instance — the seed ships an example map a new
// deployment replaces (docs/GETTING-STARTED.md; docs/ROADMAP.md R1/R2). This
// preserves the B1 property (a declared zone member cannot be dodged by
// omitting the zone) without pinning the test to any one org's writers. Only
// zone_routing is asserted — anchors need not resolve on disk (reposRoot is a
// temp dir), keeping the test hermetic.
func TestZoneRoutingRealCouplingMap(t *testing.T) {
	th := loadTestThresholds(t)
	const realMap = "../../coupling-map.yaml"
	if _, err := os.Stat(realMap); err != nil {
		t.Fatalf("real coupling map not found at %s: %v", realMap, err)
	}
	zones, err := loadNoGoZones(realMap)
	if err != nil {
		t.Fatalf("load real coupling map %s: %v", realMap, err)
	}
	reposRoot := t.TempDir()

	exercised := 0
	for zi := range zones {
		z := &zones[zi]
		for _, m := range z.members {
			if len(m.pathPrefixes) == 0 {
				continue
			}
			exercised++
			// A member's cleaned repo + a declared path prefix is, by
			// construction, an anchor that lands inside the zone.
			anchor := m.repo + ":" + m.pathPrefixes[0]
			zoneID := z.id

			t.Run("none fails "+anchor, func(t *testing.T) {
				item := mkPlanItem("i1", m.repo, "single-repo-sequenced", "low", 1,
					[]string{anchor}, []string{"none"}, []string{"kriter"})
				v := PrecheckPlan(mkPlan(item), th, realMap, reposRoot)["i1"]
				if v.Checks["zone_routing"].Pass {
					t.Fatalf("zone_routing should FAIL for %s with coupling_zones [none]; regen: %q", anchor, v.RegenComplaint)
				}
				if !strings.Contains(v.RegenComplaint, zoneID) {
					t.Fatalf("complaint should name the %q zone; regen: %q", zoneID, v.RegenComplaint)
				}
			})

			t.Run("declared passes "+anchor, func(t *testing.T) {
				item := mkPlanItem("i1", m.repo, "needs-human", "high", 1,
					[]string{anchor}, []string{zoneID}, []string{"kriter"})
				v := PrecheckPlan(mkPlan(item), th, realMap, reposRoot)["i1"]
				if !v.Checks["zone_routing"].Pass {
					t.Fatalf("zone_routing should PASS for %s with %q declared (needs-human, high); regen: %q", anchor, zoneID, v.RegenComplaint)
				}
			})
		}
	}
	if exercised == 0 {
		t.Skip("coupling map declares no no-go-zone members to exercise")
	}
}

// ─────────────── parser hardening: brace globs + traversal ────────────────

func TestParseZoneMemberBraceExpansion(t *testing.T) {
	repo, prefixes := parseZoneMember(
		"web-app:src/app/api/v1/admin/credits/ + src/features/{admin,billing}/services/ (6 user.update sites)")
	if repo != "web-app" {
		t.Fatalf("repo = %q, want web-app", repo)
	}
	want := []string{"src/app/api/v1/admin/credits", "src/features/admin/services", "src/features/billing/services"}
	if len(prefixes) != len(want) {
		t.Fatalf("prefixes = %v, want %v", prefixes, want)
	}
	for i := range want {
		if prefixes[i] != want[i] {
			t.Fatalf("prefixes[%d] = %q, want %q (all: %v)", i, prefixes[i], want[i], prefixes)
		}
	}
}

func TestParseZoneMemberRejectsUnsafeRepoAndPaths(t *testing.T) {
	for _, member := range []string{
		"api-service:../internal/account",
		"api-service:/internal/account",
		"../api:src",
	} {
		repo, prefixes := parseZoneMember(member)
		if repo != "" || len(prefixes) != 0 {
			t.Fatalf("parseZoneMember(%q) = (%q, %v), want rejection", member, repo, prefixes)
		}
	}
}

func TestParseAnchorTraversal(t *testing.T) {
	bad := []string{
		"web-app:../secrets.env",
		"web-app:src/../../other-repo/file.ts",
		"web-app:/etc/passwd",
		"web-app:..",
		"..:src/file.ts",
		"web/app:src/file.ts",
	}
	for _, a := range bad {
		if _, _, _, ok := parseAnchor(a); ok {
			t.Fatalf("parseAnchor(%q) should be rejected (traversal/absolute)", a)
		}
	}

	repo, p, sym, ok := parseAnchor("web-app:src/features/./billing/../billing/services/credit-service.ts:handleCredit")
	if !ok || repo != "web-app" || p != "src/features/billing/services/credit-service.ts" || sym != "handleCredit" {
		t.Fatalf("parseAnchor should clean a non-escaping path and return the symbol, got (%q, %q, %q, %v)", repo, p, sym, ok)
	}

	// A1: bare repo:path yields an empty symbol; a trailing colon yields an
	// empty (not missing) symbol too — both mean "no symbol to verify".
	if _, _, sym, ok := parseAnchor("web-app:src/x.ts"); !ok || sym != "" {
		t.Fatalf(`parseAnchor("web-app:src/x.ts") symbol should be "", got %q (ok=%v)`, sym, ok)
	}
	if _, _, sym, ok := parseAnchor("web-app:src/x.ts:  Foo  "); !ok || sym != "Foo" {
		t.Fatalf("parseAnchor should trim the symbol to %q, got %q (ok=%v)", "Foo", sym, ok)
	}
}

// ─────────────────────── zero-anchor safeguard ─────────────────────

// TestZeroAnchorFlag pins the zero-anchor coupling-zone-dodge flag
// On a multi-item plan, an item
// carrying zero code anchors gives zone_routing's map-consistency check
// nothing to match — the exact omission that lets coupled work render a
// plausible `zones: none`. The flag is NON-BLOCKING: it must appear in the
// complaints (and therefore in RegenComplaint, where the human gate reads
// it) without ever flipping the check's Pass or the verdict's OK.
func TestZeroAnchorFlag(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("zero anchors on a multi-item plan FLAGS zone_routing without failing anything", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		// i1 has zero anchors (nil), i2 anchors a real file so the sibling
		// stays clean — isolating the flag to the dodging item.
		writeFile(t, dir, "web-app/src/x.ts", "x")
		noAnchors := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"ac"})
		withAnchors := mkPlanItem("i2", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:src/x.ts"}, []string{"none"}, []string{"ac"})
		verdicts := PrecheckPlan(mkPlan(noAnchors, withAnchors), th, cm, dir)

		v := verdicts["i1"]
		zr := v.Checks["zone_routing"]
		if !zr.Pass {
			t.Fatalf("the zero-anchor safeguard flag must be NON-BLOCKING — zone_routing flipped to fail; regen: %q", v.RegenComplaint)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("the zero-anchor safeguard flag must not hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(zr.Complaints, "\n")
		if !strings.Contains(joined, "FLAG:") || !strings.Contains(joined, "zero code anchors") {
			t.Fatalf("zone_routing must carry the zero-anchor safeguard FLAG complaint; got %q", joined)
		}
		if !strings.Contains(v.RegenComplaint, "zero code anchors") {
			t.Fatalf("the flag must reach RegenComplaint (the downstream-visible text); got %q", v.RegenComplaint)
		}

		// The sibling WITH anchors must not be flagged.
		sibling := verdicts["i2"]
		if got := strings.Join(sibling.Checks["zone_routing"].Complaints, "\n"); strings.Contains(got, "FLAG:") {
			t.Fatalf("an item WITH anchors must not be flagged; got %q", got)
		}
	})

	t.Run("a one-node plan is exempt by design", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		only := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"ac"})
		v := PrecheckPlan(mkPlan(only), th, cm, dir)["i1"]
		if got := strings.Join(v.Checks["zone_routing"].Complaints, "\n"); strings.Contains(got, "FLAG:") {
			t.Fatalf("a one-node plan must not be flagged (quick single-ticket fixes are exempt); got %q", got)
		}
	})

	t.Run("the flag never masks or revives a HARD zone_routing failure", func(t *testing.T) {
		dir := t.TempDir()
		cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")
		// A real declared zone with wrong routing is a hard failure — and the
		// item ALSO has zero anchors, so both (a) and (c) fire: the check
		// must still FAIL (the flag must not overwrite the hard verdict).
		bad := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"credits-zone"}, []string{"ac"})
		other := mkPlanItem("i2", "web-app", "single-repo-sequenced", "low", 1, nil, []string{"none"}, []string{"ac"})
		v := PrecheckPlan(mkPlan(bad, other), th, cm, dir)["i1"]
		zr := v.Checks["zone_routing"]
		if zr.Pass {
			t.Fatalf("a mis-routed real zone must still hard-fail zone_routing regardless of the flag; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(zr.Complaints, "\n")
		if !strings.Contains(joined, "needs-human") {
			t.Fatalf("the hard complaint must survive alongside the flag; got %q", joined)
		}
		if !strings.Contains(joined, "FLAG:") {
			t.Fatalf("the flag must still be appended after hard complaints; got %q", joined)
		}
	})
}

// ─────────────────── A1: anchor SYMBOL verification ───────────────────────

// seedOriginMainRepo commits fileContent at repo/relPath and points
// refs/remotes/origin/main at that commit — the same shape TestAnchorsExist-
// OriginMain uses, so the deterministic gate resolves anchors against the
// last-pushed mainline rather than the working tree.
func seedOriginMainRepo(t *testing.T, root, repoName, relPath, fileContent string) {
	t.Helper()
	repoDir := filepath.Join(root, repoName)
	writeFile(t, root, filepath.Join(repoName, relPath), fileContent)
	snapshotOriginMainRepo(t, repoDir)
}

// TestAnchorSymbolVerification is the A1 crown-jewel regression: an anchor's
// FILE resolving on origin/main no longer clears a fabricated :symbol. A
// real symbol passes clean; an invented one is a NON-BLOCKING WARN (never a
// hard fail); a file-only anchor is unaffected.
func TestAnchorSymbolVerification(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	th := loadTestThresholds(t)

	root := t.TempDir()
	seedOriginMainRepo(t, root, "somerepo", "auth.go", "package auth\n\nfunc RealFunc() {}\n")
	cm := writeFile(t, root, "coupling-map.yaml", "no_go_zones: []\n")

	run := func(anchor string) *Verdict {
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{anchor}, []string{"none"}, []string{"kriter"})
		return PrecheckPlan(mkPlan(item), th, cm, root)["i1"]
	}

	t.Run("real symbol on origin/main passes clean (no WARN)", func(t *testing.T) {
		v := run("somerepo:auth.go:RealFunc")
		ae := v.Checks["anchors_exist"]
		if !ae.Pass || len(ae.Complaints) != 0 {
			t.Fatalf("a real symbol should pass clean, got pass=%v complaints=%v", ae.Pass, ae.Complaints)
		}
	})

	t.Run("symbol match is case-insensitive", func(t *testing.T) {
		v := run("somerepo:auth.go:realFUNC")
		ae := v.Checks["anchors_exist"]
		if !ae.Pass || len(ae.Complaints) != 0 {
			t.Fatalf("symbol matching must be case-insensitive, got pass=%v complaints=%v", ae.Pass, ae.Complaints)
		}
	})

	t.Run("invented symbol WARNs but never hard-fails", func(t *testing.T) {
		v := run("somerepo:auth.go:GhostFunc")
		ae := v.Checks["anchors_exist"]
		if !ae.Pass {
			t.Fatalf("a fabricated symbol must be WARN-first, not a hard fail; complaints=%v", ae.Complaints)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("the verdict must not hard-fail on a fabricated symbol; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(ae.Complaints, "\n")
		if !strings.HasPrefix(joined, "WARN:") || !strings.Contains(joined, "GhostFunc") ||
			!strings.Contains(joined, "may be fabricated") {
			t.Fatalf("expected a WARN naming the fabricated symbol, got: %v", ae.Complaints)
		}
	})

	t.Run("file-only anchor (no symbol) is unaffected", func(t *testing.T) {
		v := run("somerepo:auth.go")
		ae := v.Checks["anchors_exist"]
		if !ae.Pass || len(ae.Complaints) != 0 {
			t.Fatalf("a file-only anchor must resolve clean with no symbol WARN, got pass=%v complaints=%v", ae.Pass, ae.Complaints)
		}
	})

	t.Run("a missing file still hard-fails before the symbol is checked", func(t *testing.T) {
		v := run("somerepo:ghost.go:GhostFunc")
		ae := v.Checks["anchors_exist"]
		if ae.Pass {
			t.Fatalf("a missing FILE must still hard-fail regardless of the symbol; complaints=%v", ae.Complaints)
		}
		if !strings.Contains(v.RegenComplaint, "origin/main") {
			t.Fatalf("the hard complaint should name origin/main; regen: %q", v.RegenComplaint)
		}
	})
}

// TestAnchorSymbolUnavailableOriginMainFailsClosed proves a locally-present
// file/symbol cannot substitute for an origin/main git object. Symbol
// verification stays WARN-first only after the file resolves on origin/main.
func TestAnchorSymbolUnavailableOriginMainFailsClosed(t *testing.T) {
	th := loadTestThresholds(t)
	root := t.TempDir()
	writeFile(t, root, "plainrepo/svc.go", "package p\n\nfunc Present() {}\n")
	cm := writeFile(t, root, "coupling-map.yaml", "no_go_zones: []\n")

	run := func(anchor string) *Verdict {
		item := mkPlanItem("i1", "web-app", "single-repo-sequenced", "low", 1,
			[]string{anchor}, []string{"none"}, []string{"kriter"})
		return PrecheckPlan(mkPlan(item), th, cm, root)["i1"]
	}

	t.Run("present local symbol cannot clear the hard failure", func(t *testing.T) {
		v := run("plainrepo:svc.go:Present")
		ae := v.Checks["anchors_exist"]
		if ae.Pass || !v.HardFail {
			t.Fatalf("a present working-tree symbol must not clear unavailable origin/main; complaints=%v", ae.Complaints)
		}
		joined := strings.Join(ae.Complaints, "\n")
		if !strings.Contains(joined, "origin/main is unavailable") || strings.Contains(joined, "file resolves") {
			t.Fatalf("expected only the fail-closed origin/main complaint, got: %v", ae.Complaints)
		}
	})

	t.Run("missing git binary hard-fails before reading the local file", func(t *testing.T) {
		t.Setenv("PATH", t.TempDir())
		v := run("plainrepo:svc.go:Present")
		ae := v.Checks["anchors_exist"]
		if ae.Pass || !v.HardFail {
			t.Fatalf("missing git must fail closed; complaints=%v", ae.Complaints)
		}
		if !strings.Contains(strings.Join(ae.Complaints, "\n"), "origin/main is unavailable") {
			t.Fatalf("hard complaint should name unavailable origin/main: %v", ae.Complaints)
		}
	})
}

// ─────────────────── A4(ii): anchorCache memoization ──────────────────────

// TestAnchorCacheOriginMainMemoized proves originMainAvailable is probed at most
// once per repoDir: after the cache records "available", deleting origin/main
// does not change the cached answer, while a fresh cache observes the new
// reality. This is the perf fix — one `git rev-parse` per repo, not per anchor.
func TestAnchorCacheOriginMainMemoized(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	seedOriginMainRepo(t, root, "repo", "f.go", "package f\n")
	repoDir := filepath.Join(root, "repo")

	c := newAnchorCache()
	if !c.originMainAvailable(repoDir) {
		t.Fatal("first probe should report origin/main available")
	}
	gitCmd(t, repoDir, "update-ref", "-d", "refs/remotes/origin/main")
	if !c.originMainAvailable(repoDir) {
		t.Fatal("cache miss: originMainAvailable re-probed after the ref was deleted (must be memoized true)")
	}
	if newAnchorCache().originMainAvailable(repoDir) {
		t.Fatal("a fresh cache must observe origin/main as now-unavailable (proving the first answer was cached, not stale-by-luck)")
	}
}

// TestAnchorCacheBlobMemoized proves a file's origin/main bytes are read once:
// after caching, moving origin/main to new content does not change the cached
// bytes, while a fresh cache reads the update. This is why N anchors to the
// same file cost a single `git show`.
func TestAnchorCacheBlobMemoized(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	root := t.TempDir()
	seedOriginMainRepo(t, root, "repo", "f.go", "package f\n\nconst Token = 1\n")
	repoDir := filepath.Join(root, "repo")

	c := newAnchorCache()
	first, err := c.blobOnOriginMain(repoDir, "f.go")
	if err != nil {
		t.Fatalf("blobOnOriginMain: %v", err)
	}
	if !strings.Contains(string(first), "Token") {
		t.Fatalf("blob should carry the seeded content, got %q", first)
	}

	// Move origin/main to a commit with DIFFERENT content.
	writeFile(t, root, "repo/f.go", "package f\n\nconst Different = 2\n")
	gitCmd(t, repoDir, "add", ".")
	gitCmd(t, repoDir, "commit", "-m", "change", "--no-gpg-sign")
	gitCmd(t, repoDir, "update-ref", "refs/remotes/origin/main", "HEAD")

	second, err := c.blobOnOriginMain(repoDir, "f.go")
	if err != nil {
		t.Fatalf("blobOnOriginMain (cached): %v", err)
	}
	if string(second) != string(first) {
		t.Fatalf("cache miss: blob re-read after origin/main moved (got %q, want cached %q)", second, first)
	}
	if fresh, _ := newAnchorCache().blobOnOriginMain(repoDir, "f.go"); !strings.Contains(string(fresh), "Different") {
		t.Fatalf("a fresh cache must read the updated blob, got %q", fresh)
	}
}

// ─────────────────── A2: anchor_consistency (plan) ────────────────────────

// TestAnchorConsistency locks the A2 plan-level check: the SAME anchor (full
// string, symbol included) cited by more than one item is a NON-BLOCKING WARN,
// attributed per item and naming the other citers. A different symbol on the
// same file does not collide, and a unique anchor is never flagged.
func TestAnchorConsistency(t *testing.T) {
	th := loadTestThresholds(t)
	dir := t.TempDir()
	// Contents carry the symbols so the A1 symbol check adds no noise here.
	writeFile(t, dir, "web-app/shared.ts", "export function Foo() {}\nexport function Bar() {}\n")
	writeFile(t, dir, "web-app/solo.ts", "export function Solo() {}\n")
	snapshotOriginMainRepo(t, filepath.Join(dir, "web-app"))
	cm := writeFile(t, dir, "coupling-map.yaml", "no_go_zones: []\n")

	t.Run("same anchor on two items WARNs both, naming the other, non-blocking", func(t *testing.T) {
		a := mkPlanItem("A", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:shared.ts:Foo"}, []string{"none"}, []string{"ac"})
		b := mkPlanItem("B", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:shared.ts:Foo"}, []string{"none"}, []string{"ac"})
		out := PrecheckPlan(mkPlan(a, b), th, cm, dir)

		for _, tid := range []string{"A", "B"} {
			v := out[tid]
			ac := v.Checks["anchor_consistency"]
			if !ac.Pass {
				t.Fatalf("%s: anchor_consistency must be NON-BLOCKING; got a fail, complaints=%v", tid, ac.Complaints)
			}
			if !v.OK || v.HardFail {
				t.Fatalf("%s: a shared anchor must not hard-fail the verdict; regen: %q", tid, v.RegenComplaint)
			}
			joined := strings.Join(ac.Complaints, "\n")
			if !strings.HasPrefix(joined, "WARN:") || !strings.Contains(joined, "mis-split") {
				t.Fatalf("%s: expected a WARN mis-split complaint, got %v", tid, ac.Complaints)
			}
		}
		if got := strings.Join(out["A"].Checks["anchor_consistency"].Complaints, "\n"); !strings.Contains(got, "B") {
			t.Fatalf("A's WARN should name the other citer B; got %q", got)
		}
		if got := strings.Join(out["B"].Checks["anchor_consistency"].Complaints, "\n"); !strings.Contains(got, "A") {
			t.Fatalf("B's WARN should name the other citer A; got %q", got)
		}
	})

	t.Run("same file, different symbol does NOT collide (full-string match)", func(t *testing.T) {
		a := mkPlanItem("A", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:shared.ts:Foo"}, []string{"none"}, []string{"ac"})
		b := mkPlanItem("B", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:shared.ts:Bar"}, []string{"none"}, []string{"ac"})
		out := PrecheckPlan(mkPlan(a, b), th, cm, dir)
		for _, tid := range []string{"A", "B"} {
			if c := out[tid].Checks["anchor_consistency"].Complaints; len(c) != 0 {
				t.Fatalf("%s: different symbols on the same file must not collide; got %v", tid, c)
			}
		}
	})

	t.Run("a unique anchor is never flagged", func(t *testing.T) {
		a := mkPlanItem("A", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:solo.ts"}, []string{"none"}, []string{"ac"})
		b := mkPlanItem("B", "web-app", "single-repo-sequenced", "low", 1, []string{"web-app:shared.ts"}, []string{"none"}, []string{"ac"})
		out := PrecheckPlan(mkPlan(a, b), th, cm, dir)
		for _, tid := range []string{"A", "B"} {
			if c := out[tid].Checks["anchor_consistency"].Complaints; len(c) != 0 {
				t.Fatalf("%s: a unique anchor must not be flagged; got %v", tid, c)
			}
		}
	})
}

// ─────────────────── A2: summary_consistency (skeleton) ───────────────────

func mkSummarizedItem(id, summary string) SkeletonItem {
	it := mkItem(id, "Task", nil, nil, nil, "web-app", 3)
	it.OneLineSummary = summary
	return it
}

func skeletonOf(items ...SkeletonItem) *Skeleton {
	return &Skeleton{PlanID: "p", Requester: "r", Mode: "front_door", Milestones: []Milestone{}, Items: items}
}

// TestSummaryConsistency locks the A2 skeleton-level check: near-duplicate
// one_line_summaries (Jaccard word-set overlap ≥ 0.8) raise a NON-BLOCKING WARN
// naming both items; distinct summaries and empty summaries do not.
func TestSummaryConsistency(t *testing.T) {
	th := loadTestThresholds(t)

	t.Run("near-duplicate summaries WARN both items, non-blocking", func(t *testing.T) {
		s := skeletonOf(
			mkSummarizedItem("i1", "add retry logic to the upload worker"),
			mkSummarizedItem("i2", "add retry logic to the upload worker queue"),
		)
		v := ValidateSkeleton(s, th)
		sc := v.Checks["summary_consistency"]
		if !sc.Pass {
			t.Fatalf("summary_consistency must be NON-BLOCKING; got a fail, complaints=%v", sc.Complaints)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("near-duplicate summaries must not hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(sc.Complaints, "\n")
		if !strings.Contains(joined, "WARN:") || !strings.Contains(joined, "i1") || !strings.Contains(joined, "i2") {
			t.Fatalf("expected a WARN naming i1 and i2, got %v", sc.Complaints)
		}
	})

	t.Run("distinct summaries do not WARN", func(t *testing.T) {
		s := skeletonOf(
			mkSummarizedItem("i1", "add retry logic to the upload worker"),
			mkSummarizedItem("i2", "migrate billing cron to the new scheduler"),
		)
		if c := ValidateSkeleton(s, th).Checks["summary_consistency"].Complaints; len(c) != 0 {
			t.Fatalf("distinct summaries must not be flagged; got %v", c)
		}
	})

	t.Run("empty summaries are skipped", func(t *testing.T) {
		s := skeletonOf(mkSummarizedItem("i1", ""), mkSummarizedItem("i2", ""))
		if c := ValidateSkeleton(s, th).Checks["summary_consistency"].Complaints; len(c) != 0 {
			t.Fatalf("empty summaries must be skipped (nothing to compare); got %v", c)
		}
	})
}

// ─────────────────── A3: micro-leaf min-cost floor ────────────────────────

// TestMicroLeafFloor locks the A3 floor in checkSizingSane (skeleton mode): a
// leaf priced below the min is a NON-BLOCKING fold-candidate WARN; an in-band
// leaf is untouched; a floor of 0 disables the check entirely.
func TestMicroLeafFloor(t *testing.T) {
	th := loadTestThresholds(t) // thresholds.yaml min_leaf is $2.00

	t.Run("leaf below the floor WARNs, non-blocking", func(t *testing.T) {
		s := skeletonOf(mkItem("i1", "Task", nil, nil, nil, "web-app", 1)) // $1 < $2
		v := ValidateSkeleton(s, th)
		ss := v.Checks["sizing_sane"]
		if !ss.Pass {
			t.Fatalf("the floor must be NON-BLOCKING; sizing_sane hard-failed: %v", ss.Complaints)
		}
		if !v.OK || v.HardFail {
			t.Fatalf("a below-floor leaf must not hard-fail the verdict; regen: %q", v.RegenComplaint)
		}
		joined := strings.Join(ss.Complaints, "\n")
		if !strings.Contains(joined, "WARN:") || !strings.Contains(joined, "below the min") ||
			!strings.Contains(joined, "fold candidate") {
			t.Fatalf("expected a fold-candidate WARN below the floor, got %v", ss.Complaints)
		}
	})

	t.Run("leaf at or above the floor is not flagged", func(t *testing.T) {
		s := skeletonOf(mkItem("i1", "Task", nil, nil, nil, "web-app", 3)) // $2 ≤ $3 ≤ $7.5
		if c := ValidateSkeleton(s, th).Checks["sizing_sane"].Complaints; len(c) != 0 {
			t.Fatalf("an in-band leaf must not be flagged by the floor; got %v", c)
		}
	})

	t.Run("a floor of 0 disables the check", func(t *testing.T) {
		disabled := *th // shallow copy; Sizing is all value types
		disabled.Sizing.MinLeafPredictedCostUSD = 0
		s := skeletonOf(mkItem("i1", "Task", nil, nil, nil, "web-app", 0.01)) // tiny, but floor off
		if c := ValidateSkeleton(s, &disabled).Checks["sizing_sane"].Complaints; len(c) != 0 {
			t.Fatalf("a 0 floor must disable the micro-leaf WARN entirely; got %v", c)
		}
	})
}

// TestLoadThresholdsMinLeaf locks the A3 loader semantics: min_leaf is REQUIRED,
// 0 is legal (disabled), and a NEGATIVE value is rejected — the inverse of the
// existing `> 0` bounds, because a floor of 0 is meaningful.
func TestLoadThresholdsMinLeaf(t *testing.T) {
	const base = `sizing:
  max_leaf_predicted_cost_usd: 10.0
  %s
  warn_leaf_predicted_cost_usd: 7.5
  max_tree_leaves: 20
  max_depth: 3
  max_subtasks_per_parent: 5
repos:
  known: [web-app]
  lockstep_marker: cross-repo-lockstep
`
	write := func(t *testing.T, minLine string) string {
		return writeFile(t, t.TempDir(), "thresholds.yaml", fmt.Sprintf(base, minLine))
	}

	t.Run("missing min_leaf is a load error", func(t *testing.T) {
		_, err := LoadThresholds(write(t, ""))
		if err == nil || !strings.Contains(err.Error(), "min_leaf_predicted_cost_usd") {
			t.Fatalf("expected a missing-key error naming min_leaf_predicted_cost_usd, got %v", err)
		}
	})

	t.Run("min_leaf of 0 is legal (disabled)", func(t *testing.T) {
		th, err := LoadThresholds(write(t, "min_leaf_predicted_cost_usd: 0"))
		if err != nil {
			t.Fatalf("a 0 floor must be legal, got %v", err)
		}
		if th.Sizing.MinLeafPredictedCostUSD != 0 {
			t.Fatalf("expected MinLeafPredictedCostUSD 0, got %v", th.Sizing.MinLeafPredictedCostUSD)
		}
	})

	t.Run("negative min_leaf is rejected", func(t *testing.T) {
		_, err := LoadThresholds(write(t, "min_leaf_predicted_cost_usd: -1"))
		if err == nil || !strings.Contains(err.Error(), "min_leaf_predicted_cost_usd") {
			t.Fatalf("expected a >=0 validation error naming min_leaf_predicted_cost_usd, got %v", err)
		}
	})
}
