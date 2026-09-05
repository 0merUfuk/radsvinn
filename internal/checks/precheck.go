package checks

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// jiraKeyRE is the legal shape of plan.epic.existing_key — the general Jira
// issue-key form (PROJECT-123: uppercase alnum project key starting with a
// letter, dash, digits). Mirrors tools/create-tree.mjs's JIRA_KEY_RE, and is
// deliberately WIDER than the schemas' `^[A-Z]+-[0-9]+$`: the create tool honors
// RADSVINN_JIRA_PROJECT, so pinning one project at this gate would reject keys a
// differently-keyed deployment legitimately attaches to.
var jiraKeyRE = regexp.MustCompile(`^[A-Z][A-Z0-9]*-[0-9]+$`)

// planCheckOrder fixes the per-item complaint concatenation order
// plan_structure is the plan-level structural pre-gate
// and always comes first. anchor_consistency (A2) is a non-blocking plan-level
// WARN that reads the whole plan's anchor set, so it sits with anchors_exist.
var planCheckOrder = []string{
	"plan_structure",
	"hierarchy_legal",
	"fields_present",
	"single_repo",
	"anchors_exist",
	"anchor_consistency",
	"zone_routing",
	"sizing_bounds",
}

// PrecheckPlan runs the deterministic per-ticket prechecks over a groomed plan
// and returns a verdict keyed by item temp_id. Any failed check hard-fails that
// item. The coupling map is loaded once; a load failure surfaces as a
// zone_routing complaint on every item (rather than a panic).
//
// A plan-level structural pre-gate (plan_structure, C1) runs first: the verdict
// map is keyed by temp_id, so a duplicate id would let one item's verdict
// silently overwrite its sibling's (last write wins). ANY structural violation
// — duplicate ids, self-parenting, dangling or looping parent chains — stamps
// a failed plan_structure check onto EVERY item (fail-closed: a structurally
// untrustworthy plan gets no per-item attribution).
func PrecheckPlan(p *Plan, th *Thresholds, couplingMapPath, reposRoot string) map[string]*Verdict {
	zones, zoneErr := loadNoGoZones(couplingMapPath)
	structure := checkPlanStructure(p)

	// The sizing band applies to LEAVES only: a parent item's
	// predicted_cost_usd is the roll-up of its children, not a unit of
	// execution. Self-references are ignored: an item naming ITSELF as
	// parent must not launder an over-cap leaf into the parent roll-up WARN —
	// leaf classification stays correct even on structurally-bad input (which
	// plan_structure already hard-fails). Since the 2026-07-13 sizing-warn
	// demotion both wordings are advisory, so this only keeps the WARN honest,
	// but the classification must still be right.
	isParent := make(map[string]bool, len(p.Items))
	for i := range p.Items {
		it := &p.Items[i]
		if pid := it.ParentTempID; pid != nil && *pid != "" && *pid != it.TempID {
			isParent[*pid] = true
		}
	}

	// hierarchy_legal (A-M2) needs to resolve parent_temp_id to the PARENT's
	// type, so it needs its own temp_id -> item lookup plus the epic's
	// temp_id — mirroring skeleton mode's itemByID/epicID (skeleton.go's
	// checkHierarchyLegal/checkParent).
	epicID := ""
	if p.Epic != nil {
		epicID = p.Epic.TempID
	}
	itemByID := make(map[string]*PlanItem, len(p.Items))
	for i := range p.Items {
		itemByID[p.Items[i].TempID] = &p.Items[i]
	}

	// The zero-anchor flag applies to items on multi-item plans
	// only — a one-node plan (a quick single-ticket fix) is exempt by design.
	multiItem := len(p.Items) > 1

	// A1/A4(ii): ONE anchor cache per plan run memoizes the per-repo git probes
	// (origin/main availability + origin/main blob reads) that anchors_exist
	// would otherwise re-spawn once per anchor. Shared by every item's check so
	// N anchors to the same repo/file cost one probe each, not N.
	cache := newAnchorCache()

	// A2: index every anchor (full string, symbol included) to the temp_ids that
	// cite it. anchor_consistency reads this to WARN when one anchor is shared
	// across items — a mis-split smell — attributed per item.
	anchorCiters := indexAnchorCiters(p)

	out := make(map[string]*Verdict, len(p.Items))
	for i := range p.Items {
		it := &p.Items[i]
		results := map[string]CheckResult{
			"plan_structure":     structure,
			"hierarchy_legal":    checkPlanHierarchyLegal(it, epicID, itemByID),
			"fields_present":     checkFieldsPresent(it),
			"single_repo":        checkSingleRepo(it, th),
			"anchors_exist":      checkAnchorsExist(it, reposRoot, cache),
			"anchor_consistency": checkAnchorConsistency(it, anchorCiters),
			"zone_routing":       checkZoneRouting(it, zones, zoneErr, couplingMapPath, multiItem),
			"sizing_bounds":      checkSizingBounds(it, th, !isParent[it.TempID]),
		}
		out[it.TempID] = buildVerdict(planCheckOrder, results)
	}
	return out
}

// ───────────────────────── 0. plan_structure ─────────────────────────────

// checkPlanStructure is the plan-level structural pre-gate (C1). It rejects:
//
//	(a) duplicate temp_ids — the verdict map is keyed by temp_id, so a
//	    duplicate would collapse two items into one verdict (last write wins)
//	    and a failing item could vanish behind a clean twin;
//	(b) self-parenting (parent_temp_id == temp_id);
//	(c) dangling parent_temp_id references (resolving to neither the epic
//	    nor a declared item);
//	(d) parent chains that loop (A parents B parents A);
//	(e) a malformed epic.existing_key (present but not jiraKeyRE-shaped).
//	    The attach path (tools/create-tree.mjs) puts the key raw in a
//	    GET /issue/{key} URL and dies on a non-key shape at create time
//	    anyway — hard-failing HERE is earlier and cheaper (before groom
//	    spend is compounded by a doomed create). Plan-level like the rest
//	    of this check: the epic belongs to the whole tree, so no single
//	    item can own the complaint.
//
// ANY violation fails this check for the WHOLE plan: PrecheckPlan stamps the
// result onto every item's verdict. Fail-closed by design — on a structurally
// bad plan, per-item attribution itself cannot be trusted.
func checkPlanStructure(p *Plan) CheckResult {
	var complaints []string

	// (a) duplicate temp_ids. The epic's id counts: items share its namespace
	// (parent_temp_id may reference the epic).
	epicID := ""
	seen := make(map[string]bool, len(p.Items)+1)
	if p.Epic != nil && p.Epic.TempID != "" {
		epicID = p.Epic.TempID
		seen[epicID] = true
	}
	for i := range p.Items {
		id := p.Items[i].TempID
		if seen[id] {
			complaints = append(complaints, fmt.Sprintf("plan structure: duplicate temp_id %q — verdicts are keyed by temp_id, so a duplicate overwrites its sibling's verdict", id))
		}
		seen[id] = true
	}

	// (b) self-parenting and (c) dangling parents. Resolvable non-epic edges
	// feed the loop walk in (d).
	parent := make(map[string]string, len(p.Items))
	for i := range p.Items {
		it := &p.Items[i]
		if it.ParentTempID == nil || *it.ParentTempID == "" {
			continue
		}
		pid := *it.ParentTempID
		switch {
		case pid == it.TempID:
			complaints = append(complaints, fmt.Sprintf("plan structure: %s: parent_temp_id references itself", it.TempID))
		case !seen[pid]:
			complaints = append(complaints, fmt.Sprintf("plan structure: %s: parent_temp_id %q does not resolve to the epic or a declared item", it.TempID, pid))
		case pid != epicID:
			parent[it.TempID] = pid
		}
	}

	// (d) parent-chain loops. parent is a functional graph (at most one
	// outgoing edge per node), so a walk that re-enters its own in-progress
	// path has found a loop.
	const (
		unvisited = 0
		walking   = 1
		done      = 2
	)
	state := make(map[string]int, len(p.Items))
	for i := range p.Items {
		start := p.Items[i].TempID
		if state[start] != unvisited {
			continue
		}
		var path []string
		for u := start; ; {
			state[u] = walking
			path = append(path, u)
			next, ok := parent[u]
			if !ok || state[next] == done {
				break
			}
			if state[next] == walking {
				complaints = append(complaints, fmt.Sprintf("plan structure: parent chain loops: %s → %s", strings.Join(path, " → "), next))
				break
			}
			u = next
		}
		for _, v := range path {
			state[v] = done
		}
	}

	// (e) malformed epic.existing_key. A blank/whitespace-only string is
	// treated as "no attach" by the create tool (epicExistingKey trims and
	// nulls it), so only a non-blank value is judged here — same semantics,
	// no false fail on the legacy empty-string shape.
	if p.Epic != nil && p.Epic.ExistingKey != nil {
		if key := strings.TrimSpace(*p.Epic.ExistingKey); key != "" && !jiraKeyRE.MatchString(key) {
			complaints = append(complaints, fmt.Sprintf("plan structure: epic.existing_key %q is not a legal Jira issue key (PROJECT-123 shape, e.g. PROJ-451) — the create tool refuses such a key; fix it or set existing_key to null", key))
		}
	}

	return CheckResult{Pass: len(complaints) == 0, Complaints: complaints}
}

// ─────────────────────── 1. hierarchy_legal ──────────────────────────────

// checkPlanHierarchyLegal enforces the same type-vs-parent shape rules as
// skeleton mode's checkParent (skeleton.go, l0Types) — a Groomer can re-type
// an item (e.g. parent a Story under another Story, or chain Sub-tasks)
// without touching temp_id/parent_temp_id, so checkPlanStructure's purely
// structural checks (duplicate/self/dangling/loop — none of which read
// item.Type) never catch it (A-M2). A parent reference that does not resolve
// to the epic or a declared item is plan_structure's job — it already
// fails the whole plan closed on that (C1), so judging type legality against
// a nonexistent item here would be meaningless; this check assumes a
// resolvable reference and judges its TYPE legality:
//
//   - Sub-task: parent_temp_id must be non-null and resolve to an L0-typed
//     item (Story|Task|Feature|Request|Bug|Test) — never another Sub-task,
//     never the epic directly.
//   - L0-typed item: parent_temp_id must be null or the epic's temp_id —
//     never another item (so, in particular, never a Sub-task).
//
// Named checkPlanHierarchyLegal (not checkHierarchyLegal) to avoid colliding
// with skeleton.go's whole-skeleton checkHierarchyLegal; both surface under
// the same "hierarchy_legal" check-result key in their respective verdicts.
func checkPlanHierarchyLegal(it *PlanItem, epicID string, itemByID map[string]*PlanItem) CheckResult {
	isSub := it.Type == "Sub-task"

	if it.ParentTempID == nil || *it.ParentTempID == "" {
		if isSub {
			return CheckResult{
				Pass:       false,
				Complaints: []string{fmt.Sprintf("%s: Sub-task has no parent — a Sub-task needs exactly one L0 parent", it.TempID)},
			}
		}
		return CheckResult{Pass: true} // L0 standalone is legal.
	}

	pid := *it.ParentTempID
	isEpicParent := epicID != "" && pid == epicID
	parentItem := itemByID[pid]

	if !isEpicParent && parentItem == nil {
		// Dangling/unresolved reference: checkPlanStructure already fails the
		// whole plan closed on this (C1); defer to it rather than double-
		// complain about a nonexistent item's "type".
		return CheckResult{Pass: true}
	}

	if isSub {
		switch {
		case isEpicParent:
			return CheckResult{
				Pass:       false,
				Complaints: []string{fmt.Sprintf("%s: Sub-task parent %s is the epic — a Sub-task needs an L0 parent, never the epic", it.TempID, pid)},
			}
		case parentItem.Type == "Sub-task":
			return CheckResult{
				Pass:       false,
				Complaints: []string{fmt.Sprintf("%s: Sub-task parent %s is itself a Sub-task — a Sub-task needs exactly one L0 parent", it.TempID, pid)},
			}
		case !l0Types[parentItem.Type]:
			return CheckResult{
				Pass:       false,
				Complaints: []string{fmt.Sprintf("%s: Sub-task parent %s has type %q — a Sub-task needs an L0 parent", it.TempID, pid, parentItem.Type)},
			}
		}
		return CheckResult{Pass: true}
	}

	// L0 item: parent must be the epic (or null, handled above).
	if !isEpicParent {
		return CheckResult{
			Pass:       false,
			Complaints: []string{fmt.Sprintf("%s: L0 item is parented by %s — L0 items are parented by the epic or stand alone, never by another item", it.TempID, pid)},
		}
	}
	return CheckResult{Pass: true}
}

// ───────────────────────── 2. fields_present ─────────────────────────────

// checkFieldsPresent verifies the 5 fields carry content: why / DoD /
// technical_analysis.prose are non-empty, acceptance_criteria has >=1 entry
// (and every entry is itself non-blank after trimming). related_links is a
// required object (guaranteed present by the contract gate; empty arrays are
// allowed).
func checkFieldsPresent(it *PlanItem) CheckResult {
	var complaints []string
	f := &it.Fields
	if strings.TrimSpace(f.Why) == "" {
		complaints = append(complaints, fmt.Sprintf("%s: fields.why is empty", it.TempID))
	}
	if strings.TrimSpace(f.DefinitionOfDone) == "" {
		complaints = append(complaints, fmt.Sprintf("%s: fields.definition_of_done is empty", it.TempID))
	}
	if strings.TrimSpace(f.TechnicalAnalysis.Prose) == "" {
		complaints = append(complaints, fmt.Sprintf("%s: fields.technical_analysis.prose is empty", it.TempID))
	}
	if len(f.AcceptanceCriteria) == 0 {
		complaints = append(complaints, fmt.Sprintf("%s: fields.acceptance_criteria is empty — needs at least one criterion", it.TempID))
	}
	for i, ac := range f.AcceptanceCriteria {
		if strings.TrimSpace(ac) == "" {
			complaints = append(complaints, fmt.Sprintf("%s: fields.acceptance_criteria[%d] is empty", it.TempID, i))
		}
	}
	return CheckResult{Pass: len(complaints) == 0, Complaints: complaints}
}

// ────────────────────────── 3. single_repo ───────────────────────────────

// checkSingleRepo verifies repo is in the known set; the lockstep marker is
// legal only when tier1_decomposition == needs-human.
func checkSingleRepo(it *PlanItem, th *Thresholds) CheckResult {
	repo := it.Repo
	if repo == th.Repos.LockstepMarker {
		if it.Fields.TechnicalAnalysis.Tier1Decomposition != "needs-human" {
			return CheckResult{
				Pass:       false,
				Complaints: []string{fmt.Sprintf("%s: repo is %q but tier1_decomposition is %q — the lockstep marker is legal only with needs-human routing", it.TempID, repo, it.Fields.TechnicalAnalysis.Tier1Decomposition)},
			}
		}
		return CheckResult{Pass: true}
	}
	for _, k := range th.Repos.Known {
		if k == repo {
			return CheckResult{Pass: true}
		}
	}
	return CheckResult{
		Pass:       false,
		Complaints: []string{fmt.Sprintf("%s: repo %q is not in the known repo set", it.TempID, repo)},
	}
}

// ───────────────────────── 4. anchors_exist ──────────────────────────────

// anchorCache memoizes the per-repo git probes anchors_exist would otherwise
// re-spawn once per anchor (A4-ii). Two facts are cached, both keyed so a plan
// citing N anchors against the same repo/file pays for one probe, not N:
//
//   - originMain: repoDir -> does origin/main resolve? (was one `git rev-parse`
//     per anchor inside the loop; now at most one per repoDir.)
//   - blob: repoDir\x00path -> the file's bytes on origin/main (read via
//     `git show origin/main:<path>` for the A1 symbol check). Only the
//     origin/main treeish is ever read here, so repoDir+path is a sufficient
//     key. Read-once: N anchors to the same file cost a single `git show`.
//
// A single *anchorCache is created in PrecheckPlan and threaded through every
// item's checkAnchorsExist. Not safe for concurrent use — PrecheckPlan runs
// its items sequentially, which is the only caller.
type anchorCache struct {
	originMain map[string]bool
	blob       map[string][]byte
}

func newAnchorCache() *anchorCache {
	return &anchorCache{
		originMain: make(map[string]bool),
		blob:       make(map[string][]byte),
	}
}

// originMainAvailable memoizes the free-function originMainAvailable per
// repoDir (A4-ii). A false is cached exactly like a true — a non-repo answers
// "no" once, not once per anchor.
func (c *anchorCache) originMainAvailable(repoDir string) bool {
	if v, ok := c.originMain[repoDir]; ok {
		return v
	}
	v := originMainAvailable(repoDir)
	c.originMain[repoDir] = v
	return v
}

// blobOnOriginMain returns the bytes of path on origin/main of the repo at
// repoDir, memoized per (repoDir, path). Only successful reads are cached; the
// error path is rare (the file already resolved via cat-file -e before this is
// called) and callers degrade to a non-blocking WARN rather than retrying.
func (c *anchorCache) blobOnOriginMain(repoDir, path string) ([]byte, error) {
	key := repoDir + "\x00" + path
	if b, ok := c.blob[key]; ok {
		return b, nil
	}
	out, err := exec.Command("git", "-C", repoDir, "show", "origin/main:"+path).Output()
	if err != nil {
		return nil, err
	}
	c.blob[key] = out
	return out, nil
}

// checkAnchorsExist verifies every code anchor (repo:path[:symbol]) resolves
// against the repo's last-pushed mainline (origin/main via `git cat-file -e`).
// The local working tree is never a valid substitute: it may sit on a stale
// feature branch or contain unpushed files. When origin/main is unavailable
// (not a git repo, no such ref, no git binary), the check hard-fails without
// reading the working tree. Traversal rejection happens before any resolution.
// A malformed or unresolvable anchor is also a hard complaint.
//
// A1 — SYMBOL verification (WARN-first): the FILE resolving proves only file
// granularity. When an anchor names a :symbol (repo:path:symbol), the symbol
// is verified by a lenient case-insensitive substring search of the file's
// bytes; a miss is a NON-BLOCKING WARN, never a hard fail. This mirrors zero-anchor safeguard's
// precedent exactly (checkZoneRouting hardcodes its FLAG with a documented
// one-line promotion path and no config toggle): promote the symbol miss to a
// hard BLOCK only once a measured baseline shows named symbols are reliably
// present — hard-failing now would reject Opus-valid plans against no baseline
// by design. Lenient substring matching (not parsing) errs toward accepting so a
// legitimately-present symbol is never flagged.
func checkAnchorsExist(it *PlanItem, reposRoot string, cache *anchorCache) CheckResult {
	var complaints []string
	hard := false
	for _, anchor := range it.Fields.RelatedLinks.CodeAnchors {
		repo, path, symbol, ok := parseAnchor(anchor)
		if !ok {
			complaints = append(complaints, fmt.Sprintf("%s: code anchor %q is malformed or escapes the repos root — expected repo:path[:symbol] inside the repo", it.TempID, anchor))
			hard = true
			continue
		}
		repoDir := filepath.Join(reposRoot, repo)
		if !cache.originMainAvailable(repoDir) {
			complaints = append(complaints, fmt.Sprintf("%s: code anchor %q cannot be verified because origin/main is unavailable for repo %q — anchor validation is fail-closed", it.TempID, anchor, repo))
			hard = true
			continue
		}
		if !anchorOnOriginMain(repoDir, path) {
			complaints = append(complaints, fmt.Sprintf("%s: code anchor %q does not resolve on origin/main — %s/%s is absent from the last-pushed mainline", it.TempID, anchor, repo, path))
			hard = true
			continue
		}
		// File resolves on origin/main. A1: if the anchor names a :symbol,
		// verify it against the origin/main blob — WARN-first, never hard.
		if symbol != "" {
			if blob, err := cache.blobOnOriginMain(repoDir, path); err != nil {
				complaints = append(complaints, symbolUncheckableWarn(it.TempID, anchor, symbol, "on origin/main", err))
			} else if !symbolInBlob(blob, symbol) {
				complaints = append(complaints, symbolMissingWarn(it.TempID, anchor, symbol, repo, path, "on origin/main"))
			}
		}
	}
	return CheckResult{Pass: !hard, Complaints: complaints}
}

// symbolInBlob reports whether symbol appears case-insensitively as a substring
// of blob. Deliberately lenient (A1): a substring hit — not a real parse — is
// enough to clear the WARN. Erring toward ACCEPTING keeps this WARN-first check
// from flagging a symbol that is genuinely present in an unexpected form.
func symbolInBlob(blob []byte, symbol string) bool {
	return strings.Contains(strings.ToLower(string(blob)), strings.ToLower(symbol))
}

// symbolMissingWarn builds the non-blocking A1 complaint for a resolved file
// whose named symbol was not found. resolvedVia locates the proof
// ("on origin/main").
func symbolMissingWarn(tempID, anchor, symbol, repo, path, resolvedVia string) string {
	return fmt.Sprintf("WARN: %s: code anchor %q: file resolves %s but symbol %q was not found in %s/%s — the named symbol may be fabricated; verify by hand (non-blocking)", tempID, anchor, resolvedVia, symbol, repo, path)
}

// symbolUncheckableWarn builds the non-blocking A1 complaint for the rare case
// where the file resolved but its bytes could not be read to check the symbol.
// Never a hard fail: a read error must not block a plan.
func symbolUncheckableWarn(tempID, anchor, symbol, resolvedVia string, err error) string {
	return fmt.Sprintf("WARN: %s: code anchor %q: file resolves %s but its contents could not be read to verify symbol %q (%v) — verify by hand (non-blocking)", tempID, anchor, resolvedVia, symbol, err)
}

// originMainAvailable reports whether repoDir is a git repository whose
// origin/main ref resolves to a commit. Invoked via exec.Command (argv only,
// no shell); ANY failure — not a repo, missing ref, missing git binary — means
// "no", and the caller hard-fails anchor verification. Memoized per repoDir
// by anchorCache.originMainAvailable (A4-ii); call that, not this, in a loop.
func originMainAvailable(repoDir string) bool {
	return exec.Command("git", "-C", repoDir, "rev-parse", "--verify", "--quiet", "origin/main^{commit}").Run() == nil
}

// anchorOnOriginMain reports whether path exists on origin/main of the git
// repo at repoDir. `cat-file -e origin/main:<path>` resolves blobs AND trees,
// so directory anchors work; path is already filepath.Clean'ed by parseAnchor
// (no trailing slash, which would break tree lookup). A non-zero exit (path
// absent on origin/main) is a hard anchor failure at the caller.
func anchorOnOriginMain(repoDir, path string) bool {
	return exec.Command("git", "-C", repoDir, "cat-file", "-e", "origin/main:"+path).Run() == nil
}

// ─────────────────── 4b. anchor_consistency (A2) ─────────────────────────

// indexAnchorCiters maps each code anchor (the FULL string, symbol included) to
// the temp_ids that cite it, in plan order, deduped within a single item (an
// item repeating the same anchor counts once). checkAnchorConsistency reads
// this to WARN when one anchor is shared across items.
func indexAnchorCiters(p *Plan) map[string][]string {
	citers := make(map[string][]string)
	for i := range p.Items {
		it := &p.Items[i]
		seen := make(map[string]bool, len(it.Fields.RelatedLinks.CodeAnchors))
		for _, anchor := range it.Fields.RelatedLinks.CodeAnchors {
			if seen[anchor] {
				continue
			}
			seen[anchor] = true
			citers[anchor] = append(citers[anchor], it.TempID)
		}
	}
	return citers
}

// checkAnchorConsistency (A2) flags anchors cited by more than one item —
// full-string match INCLUDING the :symbol half, since two items pointing at the
// exact same file+symbol usually means the work was mis-split and belongs on
// one item. NON-BLOCKING (Pass always true; the WARN rides the same non-fatal
// pattern as the zero-anchor safeguard FLAG): a shared anchor is a smell to eyeball, not a
// correctness violation the machine can adjudicate. Attributed PER ITEM (unlike
// plan_structure, which stamps one shared verdict onto every item): each item's
// WARN names the OTHER citers, so the complaint reads correctly on whichever
// item's verdict a human is looking at.
func checkAnchorConsistency(it *PlanItem, anchorCiters map[string][]string) CheckResult {
	var complaints []string
	seen := make(map[string]bool, len(it.Fields.RelatedLinks.CodeAnchors))
	for _, anchor := range it.Fields.RelatedLinks.CodeAnchors {
		if seen[anchor] {
			continue
		}
		seen[anchor] = true
		citers := anchorCiters[anchor]
		if len(citers) <= 1 {
			continue
		}
		others := make([]string, 0, len(citers)-1)
		for _, id := range citers {
			if id != it.TempID {
				others = append(others, id)
			}
		}
		if len(others) == 0 {
			continue
		}
		complaints = append(complaints, fmt.Sprintf("WARN: %s: code anchor %q is also cited by %s — the same anchor on multiple items is a mis-split smell (the work may belong on one item); verify by hand (non-blocking)", it.TempID, anchor, strings.Join(others, ", ")))
	}
	return CheckResult{Pass: true, Complaints: complaints}
}

// ───────────────────────── 5. zone_routing ───────────────────────────────

// checkZoneRouting enforces coupling-map routing:
//
//	(a) internal consistency — if coupling_zones names a real zone (anything
//	    other than "none"), tier1_decomposition must be needs-human AND
//	    effort_tier in {high, max}.
//	(b) map consistency — if a code anchor falls under a no-go-zone member's
//	    repo + path-prefix, coupling_zones must include that zone's id.
//	(c) zero-anchor FLAG — non-blocking; see below.
func checkZoneRouting(it *PlanItem, zones []noGoZone, zoneErr error, couplingMapPath string, multiItem bool) CheckResult {
	if zoneErr != nil {
		return CheckResult{
			Pass:       false,
			Complaints: []string{fmt.Sprintf("%s: could not load coupling map %q: %v", it.TempID, couplingMapPath, zoneErr)},
		}
	}

	var complaints []string
	ta := &it.Fields.TechnicalAnalysis

	// (a) internal consistency.
	declared := map[string]bool{}
	var realZones []string
	for _, z := range ta.CouplingZones {
		declared[z] = true
		if z != "none" {
			realZones = append(realZones, z)
		}
	}
	if len(realZones) > 0 {
		if ta.Tier1Decomposition != "needs-human" {
			complaints = append(complaints, fmt.Sprintf("%s: coupling_zones %v but tier1_decomposition is %q — a coupled ticket must route needs-human", it.TempID, realZones, ta.Tier1Decomposition))
		}
		if it.EffortTier != "high" && it.EffortTier != "max" {
			complaints = append(complaints, fmt.Sprintf("%s: coupling_zones %v but effort_tier is %q — a coupled ticket must be high or max", it.TempID, realZones, it.EffortTier))
		}
	}

	// (b) map consistency.
	for _, anchor := range it.Fields.RelatedLinks.CodeAnchors {
		repo, path, _, ok := parseAnchor(anchor) // symbol is irrelevant to zone membership.
		if !ok {
			continue // anchors_exist reports malformed anchors.
		}
		for zi := range zones {
			z := &zones[zi]
			if anchorInZone(repo, path, z) && !declared[z.id] {
				complaints = append(complaints, fmt.Sprintf("%s: code anchor %q falls in no-go zone %q but coupling_zones does not include it", it.TempID, anchor, z.id))
			}
		}
	}

	// Pass is decided by the HARD complaints above, BEFORE the flag below is
	// appended: the flag must never change the verdict.
	pass := len(complaints) == 0

	// (c) zero-anchor safeguard: both (a) and (b)
	// only ever bite on DECLARED anchors/zones — an item carrying zero
	// code_anchors gives (b) nothing to match and makes `zones: none` look
	// plausible, so coupled work could dodge the coupling-zone gate
	// entirely by omission. On a multi-item plan (a one-node quick fix is
	// exempt by design) zero anchors is therefore FLAGGED to the human —
	// NON-BLOCKING (Pass unchanged; the complaint rides the same non-fatal
	// pattern as sizing_bounds' WARN): promote to a
	// hard fail only after a measured baseline shows anchors are reliably
	// present — hard-failing now would reject otherwise valid plans
	// against no measured baseline.
	if multiItem && len(it.Fields.RelatedLinks.CodeAnchors) == 0 {
		complaints = append(complaints, fmt.Sprintf("FLAG: %s: zero code anchors on a multi-item plan — zone routing has nothing to match, so no-go-zone work cannot be machine-checked; verify the touched code paths by hand (non-blocking)", it.TempID))
	}

	return CheckResult{Pass: pass, Complaints: complaints}
}

// ───────────────────────── 6. sizing_bounds ──────────────────────────────

// checkSizingBounds surfaces predicted_cost_usd over the leaf cap as an
// ADVISORY, NON-BLOCKING WARN: the $10 cap is
// a work-SIZE estimate, not metered money, so it no longer BLOCKS a plan. A
// LEAF over the cap gets the "consider splitting" advisory; a non-leaf over the
// cap gets the roll-up-is-informational note (the band gates
// leaves; a parent's cost is a roll-up). Both Pass — leaf classification now
// only changes the WARN wording, never the verdict.
func checkSizingBounds(it *PlanItem, th *Thresholds, isLeaf bool) CheckResult {
	if it.PredictedCostUSD > th.Sizing.MaxLeafPredictedCostUSD {
		if isLeaf {
			return CheckResult{
				Pass:       true,
				Complaints: []string{fmt.Sprintf("WARN: %s: predicted_cost_usd $%.2f exceeds $%.2f — consider splitting (advisory)", it.TempID, it.PredictedCostUSD, th.Sizing.MaxLeafPredictedCostUSD)},
			}
		}
		return CheckResult{
			Pass:       true,
			Complaints: []string{fmt.Sprintf("WARN: %s: parent roll-up predicted_cost_usd $%.2f exceeds the leaf max $%.2f — informational, leaves are the gated units", it.TempID, it.PredictedCostUSD, th.Sizing.MaxLeafPredictedCostUSD)},
		}
	}
	return CheckResult{Pass: true}
}

// ────────────────────────── coupling map ─────────────────────────────────

// noGoZone is a parsed no-go zone: its id plus the (repo, path-prefixes) that
// define membership.
type noGoZone struct {
	id      string
	members []zoneMember
}

type zoneMember struct {
	repo         string
	pathPrefixes []string
}

// rawNoGoZone mirrors one entry in coupling-map.yaml's no_go_zones sequence.
// Other per-zone keys are intentionally tolerated as human-facing context,
// except Anchors: that common object-shaped typo must not silently replace the
// gate's string-valued Members contract.
type rawNoGoZone struct {
	ID      string    `yaml:"id"`
	Members []string  `yaml:"members"`
	Anchors yaml.Node `yaml:"anchors"`
}

// loadNoGoZones parses coupling-map.yaml and returns the no-go zones with
// members decomposed into repo + path prefixes. The exact no_go_zones key is
// required and must contain a YAML sequence; an explicit empty sequence is
// legal. Every declared zone must have a non-empty id and at least one valid
// member. An invalid shape, zone, or member is a load error (W3): a silently
// dropped zone/member would leave writers un-enumerated, so a malformed map
// fails closed exactly like a missing one — zone_routing hard-fails every item.
func loadNoGoZones(path string) ([]noGoZone, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read coupling map: %w", err)
	}

	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("coupling map malformed: parse YAML: %w", err)
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("coupling map malformed: top level must be a YAML mapping containing no_go_zones")
	}

	root := document.Content[0]
	var zonesNode *yaml.Node
	for i := 0; i+1 < len(root.Content); i += 2 {
		key := root.Content[i]
		if key.Kind != yaml.ScalarNode || key.Value != "no_go_zones" {
			continue
		}
		if zonesNode != nil {
			return nil, fmt.Errorf("coupling map malformed: duplicate no_go_zones key")
		}
		zonesNode = root.Content[i+1]
	}
	if zonesNode == nil {
		return nil, fmt.Errorf("coupling map malformed: required no_go_zones key is missing")
	}
	if zonesNode.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("coupling map malformed: no_go_zones must be a YAML sequence (use [] for an empty map)")
	}

	var rawZones []rawNoGoZone
	if err := zonesNode.Decode(&rawZones); err != nil {
		return nil, fmt.Errorf("coupling map malformed: decode no_go_zones: %w", err)
	}
	zones := make([]noGoZone, 0, len(rawZones))
	seenIDs := make(map[string]bool, len(rawZones))
	for _, z := range rawZones {
		id := strings.TrimSpace(z.ID)
		if id == "" {
			return nil, fmt.Errorf("coupling map malformed: declared no-go zone has an empty id")
		}
		if !legalNoGoZoneID(id) {
			return nil, fmt.Errorf(
				"coupling map malformed: zone id %q is not a legal non-none coupling zone (allowed: %s)",
				id, strings.Join(nonNoneZoneIDs(), ", "),
			)
		}
		if seenIDs[id] {
			return nil, fmt.Errorf("coupling map malformed: duplicate no-go zone id %q", id)
		}
		seenIDs[id] = true
		if z.Anchors.Kind != 0 {
			return nil, fmt.Errorf("coupling map malformed: zone %q uses unknown key \"anchors\"; use repo:path strings under \"members\"", id)
		}
		if len(z.Members) == 0 {
			return nil, fmt.Errorf("coupling map malformed: zone %q must declare at least one repo:path member", id)
		}
		nz := noGoZone{id: id}
		for _, m := range z.Members {
			repo, prefixes := parseZoneMember(m)
			if repo == "" || len(prefixes) == 0 {
				return nil, fmt.Errorf("coupling map malformed: zone %q member %q is not repo:path", id, m)
			}
			nz.members = append(nz.members, zoneMember{repo: repo, pathPrefixes: prefixes})
		}
		zones = append(zones, nz)
	}
	return zones, nil
}

// nonNoneZoneIDs derives the legal map-zone vocabulary from the plan contract.
// "none" is a plan-item sentinel meaning no zone; declaring it as a map zone
// would let an anchor match while the item still appears uncoupled.
func nonNoneZoneIDs() []string {
	ids := make([]string, 0, len(zoneEnum))
	for _, id := range zoneEnum {
		if id != "none" {
			ids = append(ids, id)
		}
	}
	return ids
}

func legalNoGoZoneID(id string) bool {
	for _, legal := range nonNoneZoneIDs() {
		if id == legal {
			return true
		}
	}
	return false
}

// parseZoneMember splits a member string like
//
//	"worker-service:src/payment/services/ + src/subscription/services/ (9 sites)"
//
// into its repo and the path prefixes before any parenthetical. A brace glob
// {a,b} inside a part expands to one prefix per alternative (so a future map
// edit using braces cannot silently regress zone routing — B1). Prefixes are
// cleaned (filepath.Clean, trailing slash dropped) so anchorInZone matches on
// path-segment boundaries, and LOWERCASED — zone matching is case-insensitive
// (C2); see anchorInZone for the rationale.
func parseZoneMember(member string) (string, []string) {
	idx := strings.Index(member, ":")
	if idx < 0 {
		return "", nil
	}
	repo := strings.TrimSpace(member[:idx])
	if !validBareRepo(repo) {
		return "", nil
	}
	repo = strings.ToLower(repo)
	rest := member[idx+1:]
	if p := strings.Index(rest, "("); p >= 0 {
		rest = rest[:p]
	}
	var prefixes []string
	for _, part := range strings.Split(rest, "+") {
		p := strings.TrimSpace(part)
		if p == "" {
			continue
		}
		for _, expanded := range expandBraces(p) {
			cleaned, ok := cleanRepoRelativePath(strings.TrimSpace(expanded))
			// A member resolving to "." names the repository root, but the
			// segment-boundary matcher cannot match it. Reject it instead of
			// silently loading a zone that can never be enforced.
			if !ok || cleaned == "." {
				return "", nil
			}
			prefixes = append(prefixes, strings.ToLower(cleaned))
		}
	}
	return repo, prefixes
}

// expandBraces expands the first {a,b,...} group into one string per
// alternative, recursing so multiple groups multiply out. A string without
// braces (or with an unbalanced brace) is returned as-is.
func expandBraces(s string) []string {
	open := strings.Index(s, "{")
	if open < 0 {
		return []string{s}
	}
	closeRel := strings.Index(s[open:], "}")
	if closeRel < 0 {
		return []string{s}
	}
	closeIdx := open + closeRel
	var out []string
	for _, alt := range strings.Split(s[open+1:closeIdx], ",") {
		out = append(out, expandBraces(s[:open]+strings.TrimSpace(alt)+s[closeIdx+1:])...)
	}
	return out
}

// anchorInZone reports whether a (repo, cleaned path) anchor falls under any
// of a zone's member repo + path-prefixes. Prefixes are cleaned at load time,
// so membership is an exact match or a path-segment-boundary prefix (never a
// partial filename match).
//
// Matching is case-INSENSITIVE (C2) as a conservative defense in depth:
// anchors_exist independently proves the exact case-sensitive origin/main
// object, while zone routing must not let a casing variant dodge a safety
// boundary. A case-collision false POSITIVE on a coupling zone is the acceptable
// direction. Member prefixes are lowercased at parse time; the anchor is
// lowercased here at match time.
func anchorInZone(anchorRepo, anchorPath string, z *noGoZone) bool {
	anchorRepo = strings.ToLower(anchorRepo)
	anchorPath = strings.ToLower(anchorPath)
	for _, m := range z.members {
		if m.repo != anchorRepo {
			continue
		}
		for _, pre := range m.pathPrefixes {
			if anchorPath == pre || strings.HasPrefix(anchorPath, pre+"/") {
				return true
			}
		}
	}
	return false
}

// parseAnchor splits "repo:path" or "repo:path:symbol" into repo, CLEANED
// path, and symbol. symbol is the trimmed third colon-part when present
// (repo:path:symbol) and "" otherwise (repo:path) — A1 uses it to verify the
// named symbol actually appears in the resolved file. ok is false when the
// anchor is malformed, when the repo is not a bare directory name, or when the
// cleaned path escapes the repo root (absolute, "..", or "../"-prefixed) — a
// traversal anchor must never stat outside the repos root nor dodge zone
// prefix matching via embedded "..". Case is PRESERVED here (path AND symbol):
// anchors_exist resolves against git's case-sensitive object store, symbol
// matching lowercases both sides at compare time (symbolInBlob), and zone
// matching lowercases both sides itself (anchorInZone).
func parseAnchor(anchor string) (repo, anchorPath, symbol string, ok bool) {
	parts := strings.SplitN(anchor, ":", 3)
	if len(parts) < 2 {
		return "", "", "", false
	}
	repo = strings.TrimSpace(parts[0])
	raw := strings.TrimSpace(parts[1])
	if repo == "" || raw == "" {
		return "", "", "", false
	}
	if !validBareRepo(repo) {
		return "", "", "", false
	}
	cleaned, validPath := cleanRepoRelativePath(raw)
	if !validPath {
		return "", "", "", false
	}
	if len(parts) == 3 {
		symbol = strings.TrimSpace(parts[2])
	}
	return repo, cleaned, symbol, true
}

// validBareRepo reports whether repo can name exactly one directory beneath
// reposRoot. Both anchors and coupling-map members use this same constraint so
// a member cannot declare a repo value that no valid anchor could ever match.
func validBareRepo(repo string) bool {
	return repo != "" && repo != "." && repo != ".." && !strings.ContainsAny(repo, `/\`)
}

// cleanRepoRelativePath cleans a repo-relative file/directory path and rejects
// absolute or escaping paths. Sharing this validation between anchors and
// coupling-map members keeps their matchable path universes identical.
func cleanRepoRelativePath(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	cleaned := filepath.Clean(raw)
	if filepath.IsAbs(cleaned) || cleaned == ".." ||
		strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", false
	}
	return cleaned, true
}
