// Package checks holds Mercury's deterministic, code-not-LLM validation that
// gates the Decomposer's skeleton and the Groomer's plan before any LLM judge
// or human sees the output. It is intentionally dependency-light (stdlib +
// gopkg.in/yaml.v3) so it ports verbatim into a future Go service.
//
// Contracts mirrored here:
//   - contracts/skeleton.schema.json  -> Skeleton, Milestone, SkeletonItem
//   - contracts/plan.schema.json      -> Plan, PlanItem, Fields, ...
//
// The JSON tags form the contract shared by the planner and deterministic gate.
package checks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// ─────────────────────────── Skeleton contract ───────────────────────────

// Skeleton is the Break-Down phase output — the shape, not the write-up.
type Skeleton struct {
	PlanID    string `json:"plan_id"`
	Requester string `json:"requester"`
	Mode      string `json:"mode"`
	// OutputLanguage is a narrowly allowlisted Decomposer compatibility
	// metadata field. It is optional and never overrides the request-level
	// language persisted by the service; ValidateSkeleton records its presence
	// as an auditable non-blocking gate warning.
	OutputLanguage *string        `json:"output_language,omitempty"`
	Epic           *Epic          `json:"epic"`
	Milestones     []Milestone    `json:"milestones"`
	Items          []SkeletonItem `json:"items"`
}

// Epic is the optional L1 root. Nil (JSON null) for a standalone small ask.
type Epic struct {
	TempID      string  `json:"temp_id"`
	Summary     string  `json:"summary"`
	Why         string  `json:"why"`
	ExistingKey *string `json:"existing_key,omitempty"`
}

// Milestone is a shippable checkpoint grouping ordered leaves.
type Milestone struct {
	MilestoneID string `json:"milestone_id"`
	Name        string `json:"name"`
	Goal        string `json:"goal"`
	Order       int    `json:"order"`
}

// SizeEstimate is the Decomposer's rough right-sizing band for an item.
type SizeEstimate struct {
	Tier             string  `json:"tier"`
	PredictedCostUSD float64 `json:"predicted_cost_usd"`
	Rationale        string  `json:"rationale"`
}

// SkeletonItem is a node in the tree. parent_temp_id and milestone_id are
// pointers because the schema allows JSON null (nil == null; an absent key is
// caught by contract validation).
type SkeletonItem struct {
	TempID         string       `json:"temp_id"`
	Type           string       `json:"type"`
	ParentTempID   *string      `json:"parent_temp_id"`
	DependsOn      []string     `json:"depends_on"`
	MilestoneID    *string      `json:"milestone_id"`
	Repo           string       `json:"repo"`
	SizeEstimate   SizeEstimate `json:"size_estimate"`
	OneLineSummary string       `json:"one_line_summary"`
}

// ─────────────────────────── Flexible strings ────────────────────────────

// FlexStrings is a []string that decodes from EITHER a JSON array of strings
// (["a","b"] -> as-is), a single JSON string ("a" -> ["a"]), or JSON null
// (-> nil). It exists because an LLM realistically emits a one-element string
// array as a bare scalar (`"coupling_zones": "none"` instead of `["none"]`;
// observed live on ~57 groomed tickets). The deterministic gate must judge the
// VALUES, not reject the SHAPE, so a scalar is normalized to a one-element slice
// and every downstream check (enum/existence/zone) runs on the normalized
// value unchanged — FlexStrings IS a []string underneath.
//
// ONLY the scalar-vs-array shape is tolerated. There is no custom MarshalJSON,
// so a value always round-trips OUT as an array. A non-string scalar (number,
// bool, object) or a non-string array element still fails to decode with the
// stdlib's own error — and a scalar with a bad VALUE (e.g. "banana") still
// fails the enum check downstream. The contract stays strict about genuinely
// unknown fields (DisallowUnknownFields applies to sibling keys as before).
type FlexStrings []string

// UnmarshalJSON accepts a JSON string, an array of strings, or null.
func (fs *FlexStrings) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		*fs = nil
		return nil
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return err
		}
		*fs = FlexStrings{s}
		return nil
	}
	// Anything else must decode as a JSON array of strings. A scalar
	// number/bool/object — or an array with a non-string element — fails here
	// exactly as a plain []string target would: the shape tolerance is scalar
	// STRING vs array, never a bad element type.
	var arr []string
	if err := json.Unmarshal(trimmed, &arr); err != nil {
		return err
	}
	*fs = arr
	return nil
}

// ───────────────────────────── Plan contract ─────────────────────────────

// Plan is the Groom phase output — the full 5-field ticket tree.
type Plan struct {
	PlanID     string      `json:"plan_id"`
	Requester  string      `json:"requester"`
	RoleLens   string      `json:"role_lens"`
	Mode       string      `json:"mode"`
	Epic       *Epic       `json:"epic"`
	Milestones []Milestone `json:"milestones"`
	Items      []PlanItem  `json:"items"`
	TreeScore  *TreeScore  `json:"tree_score,omitempty"`
}

// PlanItem carries the routing metadata plus the 5 groomed fields.
type PlanItem struct {
	TempID           string   `json:"temp_id"`
	Type             string   `json:"type"`
	ParentTempID     *string  `json:"parent_temp_id"`
	DependsOn        []string `json:"depends_on"`
	MilestoneID      *string  `json:"milestone_id"`
	Repo             string   `json:"repo"`
	EffortTier       string   `json:"effort_tier"`
	PredictedCostUSD float64  `json:"predicted_cost_usd"`
	Fields           Fields   `json:"fields"`
	Score            *Score   `json:"score,omitempty"`

	// Tolerated skeleton-field carryover: the Groomer occasionally copies these
	// two SKELETON-only fields onto a plan item. They are harmless here (extra
	// metadata; no semantic or safety check reads them) — so they are ACCEPTED
	// and IGNORED rather than fail-closing the WHOLE plan over a benign format
	// quirk (DisallowUnknownFields would otherwise reject the plan → every
	// ticket blocked, a false negative on ~15/20 real plans). The Groomer prompt
	// instructs against emitting them; this is the resilience net. Genuinely-
	// unknown fields still trip DisallowUnknownFields and fail closed.
	SizeEstimate   *SizeEstimate `json:"size_estimate,omitempty"`
	OneLineSummary string        `json:"one_line_summary,omitempty"`
}

// Fields is the two-sided 5-field ticket template.
type Fields struct {
	Why                string            `json:"why"`
	RelatedLinks       RelatedLinks      `json:"related_links"`
	DefinitionOfDone   string            `json:"definition_of_done"`
	TechnicalAnalysis  TechnicalAnalysis `json:"technical_analysis"`
	AcceptanceCriteria FlexStrings       `json:"acceptance_criteria"`
}

// RelatedLinks holds external context plus code anchors (repo:path[:symbol]).
type RelatedLinks struct {
	External    FlexStrings `json:"external"`
	CodeAnchors FlexStrings `json:"code_anchors"`
}

// TechnicalAnalysis is the repo/coupling-aware approach plus routing metadata.
type TechnicalAnalysis struct {
	Prose                string      `json:"prose"`
	AffectedRepos        FlexStrings `json:"affected_repos"`
	CouplingZones        FlexStrings `json:"coupling_zones"`
	Tier1Decomposition   string      `json:"tier1_decomposition"`
	ReadOnlyRepos        FlexStrings `json:"read_only_repos"`
	InferredReposFlagged *bool       `json:"inferred_repos_flagged,omitempty"`
}

// Score is attached by the harness after the per-ticket judge pass.
type Score struct {
	Total   float64            `json:"total"`
	ByField map[string]float64 `json:"by_field"`
	Verdict string             `json:"verdict"`
}

// TreeScore is attached by the harness after the tree-level judge pass.
type TreeScore struct {
	Total       float64            `json:"total"`
	ByDimension map[string]float64 `json:"by_dimension"`
	Verdict     string             `json:"verdict"`
}

// ─────────────────────────────── Verdicts ────────────────────────────────

// CheckResult is the outcome of a single named check. A passing check may still
// carry a (non-fatal) complaint — e.g. a "WARN:" sizing warning.
type CheckResult struct {
	Pass       bool     `json:"pass"`
	Complaints []string `json:"complaints,omitempty"`
}

// Verdict aggregates the named checks for one gate (a whole skeleton, or one
// plan item). RegenComplaint is the ordered concatenation of every complaint,
// fed verbatim into the bounded-regen prompt.
type Verdict struct {
	OK             bool                   `json:"ok"`
	Checks         map[string]CheckResult `json:"checks"`
	HardFail       bool                   `json:"hard_fail"`
	RegenComplaint string                 `json:"regen_complaint"`
}

// buildVerdict assembles a Verdict from named results in a stable order so the
// RegenComplaint concatenation is deterministic. HardFail is true when any
// named check failed; OK is its negation.
func buildVerdict(order []string, results map[string]CheckResult) *Verdict {
	hardFail := false
	var complaints []string
	for _, name := range order {
		r := results[name]
		if !r.Pass {
			hardFail = true
		}
		complaints = append(complaints, r.Complaints...)
	}
	return &Verdict{
		OK:             !hardFail,
		Checks:         results,
		HardFail:       hardFail,
		RegenComplaint: strings.Join(complaints, "\n"),
	}
}

// ContractFailVerdict wraps a JSON/contract parse failure as a hard-BLOCK
// verdict (a single failed "contract_valid" check) so the CLI never emits a
// stack trace on malformed input.
func ContractFailVerdict(complaints []string) *Verdict {
	return buildVerdict([]string{"contract_valid"}, map[string]CheckResult{
		"contract_valid": {Pass: false, Complaints: complaints},
	})
}

// ───────────────────────── Contract validation ───────────────────────────
//
// The deterministic structural gate the CLI runs before any check: malformed
// JSON, unknown fields (additionalProperties:false), and missing required keys
// are all a hard BLOCK.

var (
	skeletonTopKeys  = []string{"plan_id", "requester", "mode", "epic", "milestones", "items"}
	skeletonItemKeys = []string{"temp_id", "type", "parent_temp_id", "depends_on", "milestone_id", "repo", "size_estimate", "one_line_summary"}
	milestoneKeys    = []string{"milestone_id", "name", "goal", "order"}
	epicKeys         = []string{"temp_id", "summary", "why"}

	planTopKeys    = []string{"plan_id", "requester", "role_lens", "mode", "epic", "milestones", "items"}
	planItemKeys   = []string{"temp_id", "type", "parent_temp_id", "depends_on", "milestone_id", "repo", "effort_tier", "predicted_cost_usd", "fields"}
	planFieldsKeys = []string{"why", "related_links", "definition_of_done", "technical_analysis", "acceptance_criteria"}
)

// Enum sets mirroring contracts/*.schema.json EXACTLY. The contract gate is
// deliberately self-contained: these are hardcoded here (NOT read from
// thresholds.yaml), so a thresholds edit can never widen the contract. repoEnum
// is the canonical runtime contract; TestSupportedRepoUniverseStaysAligned
// locks the two JSON-schema wire artifacts and thresholds.yaml to it.
//
// ENUMS only — the schemas' string PATTERNS are not mirrored here: the one
// pattern they declare (epic.existing_key `^[A-Z]+-[0-9]+$`) is enforced by the
// plan gate as the deliberately wider project-agnostic Jira key shape
// (precheck.go jiraKeyRE — the create tool honors MERCURY_JIRA_PROJECT, so a
// project-pinned mirror would reject other deployments' keys).
//
// repoEnum / zoneEnum are the seed's NEUTRAL example vocabulary — a clean,
// internally-consistent placeholder set a new instance replaces with its own
// repos and no-go zones (see docs/GETTING-STARTED.md). Making the enum truly
// config-driven at runtime is documented in docs/ROADMAP.md R1/R2; for
// now it is a hardcoded example kept in lockstep with the wire schemas and
// thresholds.yaml by TestSupportedRepoUniverseStaysAligned.
var (
	modeEnum           = []string{"front_door", "groom_existing"}
	outputLanguageEnum = []string{"en", "tr", "both"}
	itemTypeEnum       = []string{"Story", "Task", "Feature", "Request", "Bug", "Test", "Sub-task"}
	tierEnum           = []string{"low", "medium", "high", "max"}
	repoEnum           = []string{
		"web-app", "api-service", "worker-service", "shared-lib", "cross-repo-lockstep",
	}
	roleLensEnum = []string{"business", "tech"}
	tier1Enum    = []string{"single-repo-sequenced", "needs-human"}
	zoneEnum     = []string{"none", "shared-write"}
	verdictEnum  = []string{"PASS", "FLAG", "BLOCK"}
)

// checkEnum reports a complaint when val is not one of the legal enum values.
func checkEnum(prefix, field, val string, legal []string) []string {
	for _, l := range legal {
		if val == l {
			return nil
		}
	}
	return []string{fmt.Sprintf("%s: %s %q is not one of [%s]", prefix, field, val, strings.Join(legal, "|"))}
}

// ValidateSkeletonContract strictly decodes the raw skeleton JSON and reports
// every contract violation (malformed JSON, unknown fields, missing required
// keys). A non-empty complaint slice means the input is a hard BLOCK.
func ValidateSkeletonContract(raw []byte) (*Skeleton, []string) {
	var s Skeleton
	if err := decodeStrict(raw, &s); err != nil {
		return nil, []string{"malformed skeleton JSON: " + err.Error()}
	}
	top, ok := objectKeys(raw)
	if !ok {
		return nil, []string{"skeleton root is not a JSON object"}
	}
	var complaints []string
	complaints = append(complaints, missingKeys("skeleton", top, skeletonTopKeys)...)
	if er, present := top["epic"]; present && !isJSONNull(er) {
		ek, _ := objectKeys(er)
		complaints = append(complaints, missingKeys("skeleton.epic", ek, epicKeys)...)
	}
	complaints = append(complaints, arrayObjectKeys("skeleton.milestones", top["milestones"], milestoneKeys, false)...)
	complaints = append(complaints, arrayObjectKeys("skeleton.items", top["items"], skeletonItemKeys, true)...)

	// Enum values (M1) — mirrors skeleton.schema.json. Runs on the decoded
	// struct; a missing key also yields an enum complaint for its zero value,
	// which is redundant with the missing-key complaint but never wrong (both
	// are the same hard BLOCK).
	complaints = append(complaints, checkEnum("skeleton", "mode", s.Mode, modeEnum)...)
	if s.OutputLanguage != nil {
		complaints = append(complaints, checkEnum("skeleton", "output_language", *s.OutputLanguage, outputLanguageEnum)...)
	}
	for i := range s.Items {
		it := &s.Items[i]
		prefix := fmt.Sprintf("skeleton.items[%d]", i)
		complaints = append(complaints, checkEnum(prefix, "type", it.Type, itemTypeEnum)...)
		complaints = append(complaints, checkEnum(prefix, "size_estimate.tier", it.SizeEstimate.Tier, tierEnum)...)
		complaints = append(complaints, checkEnum(prefix, "repo", it.Repo, repoEnum)...)
	}
	return &s, complaints
}

// ValidatePlanContract strictly decodes the raw plan JSON and reports every
// contract violation. A non-empty complaint slice means a hard BLOCK.
func ValidatePlanContract(raw []byte) (*Plan, []string) {
	var p Plan
	if err := decodeStrict(raw, &p); err != nil {
		return nil, []string{"malformed plan JSON: " + err.Error()}
	}
	top, ok := objectKeys(raw)
	if !ok {
		return nil, []string{"plan root is not a JSON object"}
	}
	var complaints []string
	complaints = append(complaints, missingKeys("plan", top, planTopKeys)...)
	if er, present := top["epic"]; present && !isJSONNull(er) {
		ek, _ := objectKeys(er)
		complaints = append(complaints, missingKeys("plan.epic", ek, epicKeys)...)
	}
	if ir, present := top["items"]; present {
		var arr []json.RawMessage
		if json.Unmarshal(ir, &arr) == nil {
			if len(arr) == 0 {
				complaints = append(complaints, "plan.items must contain at least one item")
			}
			for i, it := range arr {
				prefix := fmt.Sprintf("plan.items[%d]", i)
				ik, ok := objectKeys(it)
				if !ok || isJSONNull(it) {
					complaints = append(complaints, prefix+" is not a JSON object")
					continue
				}
				complaints = append(complaints, missingKeys(prefix, ik, planItemKeys)...)
				if fr, present := ik["fields"]; present && !isJSONNull(fr) {
					fk, _ := objectKeys(fr)
					complaints = append(complaints, missingKeys(prefix+".fields", fk, planFieldsKeys)...)
				}
			}
		}
	}

	// Enum values (M1) — mirrors plan.schema.json.
	complaints = append(complaints, checkEnum("plan", "role_lens", p.RoleLens, roleLensEnum)...)
	complaints = append(complaints, checkEnum("plan", "mode", p.Mode, modeEnum)...)
	for i := range p.Items {
		it := &p.Items[i]
		prefix := fmt.Sprintf("plan.items[%d]", i)
		complaints = append(complaints, checkEnum(prefix, "type", it.Type, itemTypeEnum)...)
		complaints = append(complaints, checkEnum(prefix, "repo", it.Repo, repoEnum)...)
		complaints = append(complaints, checkEnum(prefix, "effort_tier", it.EffortTier, tierEnum)...)
		complaints = append(complaints, checkEnum(prefix, "technical_analysis.tier1_decomposition",
			it.Fields.TechnicalAnalysis.Tier1Decomposition, tier1Enum)...)
		for _, z := range it.Fields.TechnicalAnalysis.CouplingZones {
			complaints = append(complaints, checkEnum(prefix, "coupling_zones entry", z, zoneEnum)...)
		}
		if it.Score != nil {
			complaints = append(complaints, checkEnum(prefix, "score.verdict", it.Score.Verdict, verdictEnum)...)
		}
	}
	if p.TreeScore != nil {
		complaints = append(complaints, checkEnum("plan.tree_score", "verdict", p.TreeScore.Verdict, verdictEnum)...)
	}
	return &p, complaints
}

// decodeStrict decodes exactly one JSON value with unknown fields rejected
// (mirrors additionalProperties:false) and no trailing data allowed.
func decodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("unexpected trailing data after top-level JSON value")
	}
	return nil
}

// objectKeys unmarshals a JSON object into a key->rawvalue map.
func objectKeys(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, false
	}
	return m, true
}

// arrayObjectKeys checks required keys on every object element of a JSON array.
// When requireNonEmpty is set, an empty array is itself a complaint.
func arrayObjectKeys(prefix string, raw json.RawMessage, required []string, requireNonEmpty bool) []string {
	if len(raw) == 0 {
		return nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	var complaints []string
	if requireNonEmpty && len(arr) == 0 {
		complaints = append(complaints, prefix+" must contain at least one item")
	}
	for i, el := range arr {
		p := fmt.Sprintf("%s[%d]", prefix, i)
		ek, ok := objectKeys(el)
		if !ok || isJSONNull(el) {
			complaints = append(complaints, p+" is not a JSON object")
			continue
		}
		complaints = append(complaints, missingKeys(p, ek, required)...)
	}
	return complaints
}

// missingKeys reports each required key absent from present.
func missingKeys(prefix string, present map[string]json.RawMessage, required []string) []string {
	var out []string
	for _, k := range required {
		if _, ok := present[k]; !ok {
			out = append(out, fmt.Sprintf("%s: missing required key %q", prefix, k))
		}
	}
	return out
}

// isJSONNull reports whether raw is the literal JSON null.
func isJSONNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}
