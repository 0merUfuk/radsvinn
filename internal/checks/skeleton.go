package checks

import (
	"fmt"
	"strings"
)

// skeletonCheckOrder fixes the order complaints are concatenated into the
// RegenComplaint. summary_consistency is a
// non-blocking WARNs appended last — they never change a verdict.
var skeletonCheckOrder = []string{
	"acyclic",
	"hierarchy_legal",
	"order_consistent",
	"milestone_shippable",
	"sizing_sane",
	"summary_consistency",
	"output_language_metadata",
}

// summaryJaccardThreshold is the word-set overlap at or above which two item
// one_line_summaries are flagged as near-duplicate (A2). A Go const, NOT a
// thresholds.yaml tunable: it is a linguistic heuristic, not a calibration
// band, and lives with the logic that reads it.
const summaryJaccardThreshold = 0.8

// l0Types are the L0 item types. Sub-task is L−1; Epic (L1) is not an
// item type.
var l0Types = map[string]bool{
	"Story": true, "Task": true, "Feature": true,
	"Request": true, "Bug": true, "Test": true,
}

// ValidateSkeleton runs the five deterministic structural checks over a parsed
// skeleton and returns the aggregate verdict. HardFail is any check failing;
// coverage (check 6) is semantic and deliberately not here.
func ValidateSkeleton(s *Skeleton, th *Thresholds) *Verdict {
	results := map[string]CheckResult{
		"acyclic":                  checkAcyclic(s),
		"hierarchy_legal":          checkHierarchyLegal(s),
		"order_consistent":         checkOrderConsistent(s),
		"milestone_shippable":      checkMilestoneShippable(s),
		"sizing_sane":              checkSizingSane(s, th),
		"summary_consistency":      checkSummaryConsistency(s),
		"output_language_metadata": checkOutputLanguageMetadata(s),
	}
	return buildVerdict(skeletonCheckOrder, results)
}

// ─────────────────────────── 1. acyclic ──────────────────────────────────

// checkAcyclic reports whether the depends_on graph has a cycle, naming the
// cycle path when found. Edges to undeclared ids are ignored here (the
// hierarchy check reports dangling references).
func checkAcyclic(s *Skeleton) CheckResult {
	idSet := make(map[string]bool, len(s.Items))
	for i := range s.Items {
		idSet[s.Items[i].TempID] = true
	}
	adj := make(map[string][]string, len(s.Items))
	for i := range s.Items {
		it := &s.Items[i]
		for _, dep := range it.DependsOn {
			if idSet[dep] {
				adj[it.TempID] = append(adj[it.TempID], dep)
			}
		}
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(s.Items))
	var stack []string
	var cycle []string

	var dfs func(u string) bool
	dfs = func(u string) bool {
		color[u] = gray
		stack = append(stack, u)
		for _, v := range adj[u] {
			switch color[v] {
			case gray:
				// Back edge: the cycle is stack[idx..] followed by v.
				idx := indexOf(stack, v)
				cycle = append(cycle, stack[idx:]...)
				cycle = append(cycle, v)
				return true
			case white:
				if dfs(v) {
					return true
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[u] = black
		return false
	}

	for i := range s.Items {
		id := s.Items[i].TempID
		if color[id] == white {
			if dfs(id) {
				return CheckResult{
					Pass:       false,
					Complaints: []string{"depends_on cycle detected: " + strings.Join(cycle, " → ")},
				}
			}
		}
	}
	return CheckResult{Pass: true}
}

func indexOf(xs []string, target string) int {
	for i, x := range xs {
		if x == target {
			return i
		}
	}
	return -1
}

// ─────────────────────── 2. hierarchy_legal ──────────────────────────────

// checkHierarchyLegal enforces id uniqueness, reference resolution, the
// team-managed parenting rules, and milestone presence/contiguity.
func checkHierarchyLegal(s *Skeleton) CheckResult {
	var complaints []string

	// Build lookup tables and detect duplicate ids.
	epicID := ""
	seenTemp := map[string]bool{}
	if s.Epic != nil {
		epicID = s.Epic.TempID
		seenTemp[epicID] = true
	}
	itemByID := make(map[string]*SkeletonItem, len(s.Items))
	for i := range s.Items {
		it := &s.Items[i]
		if seenTemp[it.TempID] {
			complaints = append(complaints, fmt.Sprintf("%s: duplicate temp_id", it.TempID))
		}
		seenTemp[it.TempID] = true
		itemByID[it.TempID] = it
	}

	milestoneByID := make(map[string]*Milestone, len(s.Milestones))
	seenMS := map[string]bool{}
	for i := range s.Milestones {
		m := &s.Milestones[i]
		if seenMS[m.MilestoneID] {
			complaints = append(complaints, fmt.Sprintf("milestone %s: duplicate milestone_id", m.MilestoneID))
		}
		seenMS[m.MilestoneID] = true
		milestoneByID[m.MilestoneID] = m
	}

	hasMilestones := len(s.Milestones) > 0

	for i := range s.Items {
		it := &s.Items[i]

		// depends_on references must resolve to declared items.
		for _, dep := range it.DependsOn {
			if _, ok := itemByID[dep]; !ok {
				complaints = append(complaints, fmt.Sprintf("%s: depends_on %q does not resolve to a declared item", it.TempID, dep))
			}
		}

		// Parent resolution + hierarchy legality.
		complaints = append(complaints, checkParent(it, epicID, itemByID)...)

		// Milestone presence + resolution.
		complaints = append(complaints, checkItemMilestone(it, hasMilestones, milestoneByID)...)
	}

	// Milestone order values: unique, start at 1, contiguous 1..N.
	complaints = append(complaints, checkMilestoneOrders(s.Milestones)...)

	return CheckResult{Pass: len(complaints) == 0, Complaints: complaints}
}

// checkParent validates a single item's parent_temp_id against the
// team-managed rules.
func checkParent(it *SkeletonItem, epicID string, itemByID map[string]*SkeletonItem) []string {
	isSub := it.Type == "Sub-task"

	if it.ParentTempID == nil {
		if isSub {
			return []string{fmt.Sprintf("%s: Sub-task has no parent — a Sub-task needs exactly one L0 parent", it.TempID)}
		}
		return nil // L0 standalone is legal.
	}

	pid := *it.ParentTempID
	isEpicParent := epicID != "" && pid == epicID
	parentItem := itemByID[pid]

	// Reference must resolve to the epic or a declared item.
	if !isEpicParent && parentItem == nil {
		return []string{fmt.Sprintf("%s: parent_temp_id %q does not resolve to the epic or a declared item", it.TempID, pid)}
	}

	if isSub {
		switch {
		case isEpicParent:
			return []string{fmt.Sprintf("%s: Sub-task parent %s is the epic — a Sub-task needs an L0 parent, never the epic", it.TempID, pid)}
		case parentItem.Type == "Sub-task":
			return []string{fmt.Sprintf("%s: Sub-task parent %s is itself a Sub-task — a Sub-task needs exactly one L0 parent", it.TempID, pid)}
		case !l0Types[parentItem.Type]:
			return []string{fmt.Sprintf("%s: Sub-task parent %s has type %q — a Sub-task needs an L0 parent", it.TempID, pid, parentItem.Type)}
		}
		return nil
	}

	// L0 item: parent must be the epic (or null, handled above).
	if !isEpicParent {
		return []string{fmt.Sprintf("%s: L0 item is parented by %s — L0 items are parented by the epic or stand alone, never by another item", it.TempID, pid)}
	}
	return nil
}

// checkItemMilestone validates milestone_id presence and resolution.
func checkItemMilestone(it *SkeletonItem, hasMilestones bool, milestoneByID map[string]*Milestone) []string {
	if !hasMilestones {
		if it.MilestoneID != nil {
			return []string{fmt.Sprintf("%s: milestone_id %q set but the skeleton declares no milestones", it.TempID, *it.MilestoneID)}
		}
		return nil // null milestone_id is legal when there are no milestones.
	}
	if it.MilestoneID == nil {
		return []string{fmt.Sprintf("%s: milestone_id is null but milestones are declared — every item must belong to a milestone", it.TempID)}
	}
	if _, ok := milestoneByID[*it.MilestoneID]; !ok {
		return []string{fmt.Sprintf("%s: milestone_id %q does not resolve to a declared milestone", it.TempID, *it.MilestoneID)}
	}
	return nil
}

// checkMilestoneOrders verifies orders are exactly {1..N}, unique.
func checkMilestoneOrders(ms []Milestone) []string {
	if len(ms) == 0 {
		return nil
	}
	n := len(ms)
	seen := make(map[int]bool, n)
	var complaints []string
	for i := range ms {
		o := ms[i].Order
		if o < 1 || o > n {
			complaints = append(complaints, fmt.Sprintf("milestone %s: order %d out of range 1..%d", ms[i].MilestoneID, o, n))
			continue
		}
		if seen[o] {
			complaints = append(complaints, fmt.Sprintf("milestone %s: duplicate order %d", ms[i].MilestoneID, o))
			continue
		}
		seen[o] = true
	}
	// If no per-value complaint fired but a value in 1..N is unused, orders are
	// non-contiguous (a gap). Report the first gap.
	if len(complaints) == 0 {
		for want := 1; want <= n; want++ {
			if !seen[want] {
				complaints = append(complaints, fmt.Sprintf("milestone orders are not contiguous: missing order %d in 1..%d", want, n))
				break
			}
		}
	}
	return complaints
}

// ────────────────────── 3. order_consistent ──────────────────────────────

// checkOrderConsistent verifies every dependency appears earlier in the items
// array (the array order is the proposed execution sequence). Unresolved
// dependencies are skipped (the hierarchy check reports them).
func checkOrderConsistent(s *Skeleton) CheckResult {
	index := make(map[string]int, len(s.Items))
	for i := range s.Items {
		index[s.Items[i].TempID] = i
	}
	var complaints []string
	for i := range s.Items {
		it := &s.Items[i]
		for _, dep := range it.DependsOn {
			depIdx, ok := index[dep]
			if !ok {
				continue
			}
			if depIdx >= i {
				complaints = append(complaints, fmt.Sprintf("%s: depends_on %s which appears later in the items array (index %d ≥ %d) — a prerequisite must come first", it.TempID, dep, depIdx, i))
			}
		}
	}
	return CheckResult{Pass: len(complaints) == 0, Complaints: complaints}
}

// ────────────────────── 4. milestone_shippable ───────────────────────────

// checkMilestoneShippable verifies no depends_on edge points forward across a
// milestone boundary: milestone_order(dep) <= milestone_order(item). Trivially
// passes when there are no milestones.
func checkMilestoneShippable(s *Skeleton) CheckResult {
	if len(s.Milestones) == 0 {
		return CheckResult{Pass: true}
	}
	order := make(map[string]int, len(s.Milestones))
	for i := range s.Milestones {
		order[s.Milestones[i].MilestoneID] = s.Milestones[i].Order
	}
	itemOrder := make(map[string]int, len(s.Items))
	for i := range s.Items {
		it := &s.Items[i]
		if it.MilestoneID != nil {
			if o, ok := order[*it.MilestoneID]; ok {
				itemOrder[it.TempID] = o
			}
		}
	}

	var complaints []string
	for i := range s.Items {
		it := &s.Items[i]
		itOrd, ok := itemOrder[it.TempID]
		if !ok {
			continue // unresolved/absent milestone — hierarchy check owns it.
		}
		for _, dep := range it.DependsOn {
			depOrd, ok := itemOrder[dep]
			if !ok {
				continue
			}
			if depOrd > itOrd {
				complaints = append(complaints, fmt.Sprintf("%s (milestone order %d): depends_on %s in a later milestone (order %d) — a dependency must not point forward across a milestone boundary", it.TempID, itOrd, dep, depOrd))
			}
		}
	}
	return CheckResult{Pass: len(complaints) == 0, Complaints: complaints}
}

// ─────────────────────────── 5. sizing_sane ──────────────────────────────

// checkSizingSane enforces the sizing bounds. Cost checks apply to
// leaves (items with no children) and are ADVISORY: an over-cap or warn-band
// leaf appends a non-fatal "WARN:" complaint but never sets `hard` (2026-07-13
// sizing-warn demotion — the $10 leaf cap is a work-SIZE estimate, not metered
// money: developers execute on a flat subscription, so an oversized leaf is a
// "consider splitting" nudge, not a blocker). The tree-width conventions
// max_tree_leaves and max_subtasks_per_parent are likewise advisory: a larger
// valid tree can still be the right operational plan. Only the safety bounds —
// max_depth and an unknown repo — hard-fail. Pass = !hard.
func checkSizingSane(s *Skeleton, th *Thresholds) CheckResult {
	isParent := make(map[string]bool, len(s.Items))
	for i := range s.Items {
		if p := s.Items[i].ParentTempID; p != nil {
			isParent[*p] = true
		}
	}

	var complaints []string
	hard := false
	leafCount := 0

	for i := range s.Items {
		it := &s.Items[i]

		if !isParent[it.TempID] { // leaf
			leafCount++
			c := it.SizeEstimate.PredictedCostUSD
			switch {
			case c > th.Sizing.MaxLeafPredictedCostUSD:
				// ADVISORY, NON-BLOCKING (2026-07-13 sizing-warn demotion): an
				// over-cap leaf no longer HARD-fails the shape gate — it rides
				// through as a WARN, exactly like the warn-band case below, so the
				// human still sees "this looks feature-sized; split it". Does NOT
				// set `hard`; only the STRUCTURAL bounds below do.
				complaints = append(complaints, fmt.Sprintf("WARN: %s: leaf predicted_cost_usd $%.2f exceeds $%.2f — consider splitting (advisory)", it.TempID, c, th.Sizing.MaxLeafPredictedCostUSD))
			case c > th.Sizing.WarnLeafPredictedCostUSD:
				complaints = append(complaints, fmt.Sprintf("WARN: %s: leaf predicted_cost_usd $%.2f is in the warn band (> $%.2f) — consider splitting", it.TempID, c, th.Sizing.WarnLeafPredictedCostUSD))
			}
			// A3: micro-leaf floor. A leaf priced below the floor is a fold
			// candidate — too small to warrant its own ticket. NON-BLOCKING
			// (WARN, no hard). A floor of 0 disables the check. Skeleton mode
			// ONLY: the Groomer is forbidden from restructuring the approved
			// skeleton (groomer.md), so a plan-phase floor WARN would be inert —
			// nothing downstream could act on it after the shape is frozen.
			if th.Sizing.MinLeafPredictedCostUSD > 0 && c < th.Sizing.MinLeafPredictedCostUSD {
				complaints = append(complaints, fmt.Sprintf("WARN: %s: leaf predicted_cost_usd $%.2f is below the min $%.2f — a leaf this small is a fold candidate; consider merging it into a sibling or parent (non-blocking)", it.TempID, c, th.Sizing.MinLeafPredictedCostUSD))
			}
		}

		if !th.repoKnown(it.Repo) {
			complaints = append(complaints, fmt.Sprintf("%s: repo %q is not in the known set and is not the lockstep marker", it.TempID, it.Repo))
			hard = true
		}

		if lvl := itemLevel(it.Type); lvl > th.Sizing.MaxDepth {
			complaints = append(complaints, fmt.Sprintf("%s: depth %d exceeds max_depth %d (epic=1, L0=2, Sub-task=3)", it.TempID, lvl, th.Sizing.MaxDepth))
			hard = true
		}
	}

	if leafCount > th.Sizing.MaxTreeLeaves {
		complaints = append(complaints, fmt.Sprintf("WARN: tree has %d leaves, exceeds max_tree_leaves %d — over-fragmented; consider splitting (advisory)", leafCount, th.Sizing.MaxTreeLeaves))
	}

	// Sub-tasks per parent. Count, then report in items order for determinism.
	subCount := map[string]int{}
	for i := range s.Items {
		it := &s.Items[i]
		if it.Type == "Sub-task" && it.ParentTempID != nil {
			subCount[*it.ParentTempID]++
		}
	}
	reported := map[string]bool{}
	for i := range s.Items {
		pid := s.Items[i].TempID
		if subCount[pid] > th.Sizing.MaxSubtasksPerParent && !reported[pid] {
			reported[pid] = true
			complaints = append(complaints, fmt.Sprintf("WARN: %s: has %d sub-tasks, exceeds max_subtasks_per_parent %d — split or promote (advisory)", pid, subCount[pid], th.Sizing.MaxSubtasksPerParent))
		}
	}

	return CheckResult{Pass: !hard, Complaints: complaints}
}

// itemLevel maps a type to its tree depth: L0 = 2, Sub-task = 3.
func itemLevel(t string) int {
	if t == "Sub-task" {
		return 3
	}
	return 2
}

// ───────────────── 7. output_language_metadata (compatibility) ──────────

// checkOutputLanguageMetadata makes the sole skeleton-level compatibility
// allowance visible in the persisted gate result. The strict contract already
// accepts only en|tr|both and rejects every other unknown field or type; this
// check deliberately does not reinterpret the request-level language.
func checkOutputLanguageMetadata(s *Skeleton) CheckResult {
	if s.OutputLanguage == nil {
		return CheckResult{Pass: true}
	}
	return CheckResult{
		Pass:       true,
		Complaints: []string{fmt.Sprintf("WARN: skeleton.output_language %q accepted as allowlisted compatibility metadata; the service request remains authoritative", *s.OutputLanguage)},
	}
}

// ────────────────────── 6. summary_consistency (A2) ──────────────────────

// checkSummaryConsistency flags pairs of items whose one_line_summaries are
// near-duplicates (Jaccard word-set overlap ≥ summaryJaccardThreshold) — a
// mis-split smell (two "tickets" describing the same slice of work). Placed in
// SKELETON mode by field lifecycle: one_line_summary is contract-REQUIRED on a
// SkeletonItem (it is in skeletonItemKeys) but Groomer-DISCOURAGED carryover on
// a PlanItem (usually empty at plan phase), so a plan-phase title check would
// be inert. NON-BLOCKING: Pass is always true; the WARN rides the same
// non-fatal pattern as the sizing warn band. Items with an empty summary are
// skipped (nothing to compare). Comparison is stdlib-only: lowercase, split on
// whitespace, set intersection over union.
func checkSummaryConsistency(s *Skeleton) CheckResult {
	type summarized struct {
		id  string
		set map[string]bool
	}
	sets := make([]summarized, 0, len(s.Items))
	for i := range s.Items {
		ws := wordSet(s.Items[i].OneLineSummary)
		if len(ws) == 0 {
			continue // empty/whitespace summary — nothing to compare against.
		}
		sets = append(sets, summarized{id: s.Items[i].TempID, set: ws})
	}

	var complaints []string
	for i := 0; i < len(sets); i++ {
		for j := i + 1; j < len(sets); j++ {
			if jac := jaccard(sets[i].set, sets[j].set); jac >= summaryJaccardThreshold {
				complaints = append(complaints, fmt.Sprintf("WARN: one_line_summary of %s and %s overlap %.0f%% (≥ %.0f%% word-set) — near-duplicate titles are a mis-split smell; verify they are distinct work (non-blocking)", sets[i].id, sets[j].id, jac*100, summaryJaccardThreshold*100))
			}
		}
	}
	return CheckResult{Pass: true, Complaints: complaints}
}

// wordSet lowercases s and returns the set of whitespace-delimited words.
func wordSet(s string) map[string]bool {
	fields := strings.Fields(strings.ToLower(s))
	m := make(map[string]bool, len(fields))
	for _, w := range fields {
		m[w] = true
	}
	return m
}

// jaccard is |a ∩ b| / |a ∪ b| over two word sets; 0 when both are empty.
func jaccard(a, b map[string]bool) float64 {
	inter := 0
	for w := range a {
		if b[w] {
			inter++
		}
	}
	union := len(a) + len(b) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}
