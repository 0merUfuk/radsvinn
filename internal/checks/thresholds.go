package checks

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Sizing holds the right-sizing bounds the deterministic checks enforce
// (thresholds.yaml `sizing`). Logic lives in Go; the numbers live in YAML so a
// calibration run can move them without a rebuild.
type Sizing struct {
	MaxLeafPredictedCostUSD  float64
	MinLeafPredictedCostUSD  float64 // A3: micro-leaf fold-candidate floor; 0 disables.
	WarnLeafPredictedCostUSD float64
	MaxTreeLeaves            int
	MaxDepth                 int
	MaxSubtasksPerParent     int
}

// Repos holds the single-repo rule universe (thresholds.yaml `repos`).
type Repos struct {
	Known          []string
	LockstepMarker string
}

// Thresholds is the validated subset of thresholds.yaml this package consumes.
// (The `verdicts`/`weights` blocks feed the LLM judge, not these deterministic
// checks, so they are intentionally not modelled here.)
type Thresholds struct {
	Sizing Sizing
	Repos  Repos
}

// rawThresholds mirrors the YAML with pointers so a missing key is detectable
// (nil) rather than silently defaulting to a zero value.
type rawThresholds struct {
	Sizing *struct {
		MaxLeafPredictedCostUSD  *float64 `yaml:"max_leaf_predicted_cost_usd"`
		MinLeafPredictedCostUSD  *float64 `yaml:"min_leaf_predicted_cost_usd"`
		WarnLeafPredictedCostUSD *float64 `yaml:"warn_leaf_predicted_cost_usd"`
		MaxTreeLeaves            *int     `yaml:"max_tree_leaves"`
		MaxDepth                 *int     `yaml:"max_depth"`
		MaxSubtasksPerParent     *int     `yaml:"max_subtasks_per_parent"`
	} `yaml:"sizing"`
	Repos *struct {
		Known          []string `yaml:"known"`
		LockstepMarker *string  `yaml:"lockstep_marker"`
	} `yaml:"repos"`
}

// LoadThresholds reads and validates thresholds.yaml at path. It fails loudly:
// any required key that is missing, empty, or non-positive is reported by name.
func LoadThresholds(path string) (*Thresholds, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read thresholds %q: %w", path, err)
	}
	var raw rawThresholds
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse thresholds %q: %w", path, err)
	}

	var missing []string
	if raw.Sizing == nil {
		missing = append(missing, "sizing")
	} else {
		if raw.Sizing.MaxLeafPredictedCostUSD == nil {
			missing = append(missing, "sizing.max_leaf_predicted_cost_usd")
		}
		if raw.Sizing.MinLeafPredictedCostUSD == nil {
			missing = append(missing, "sizing.min_leaf_predicted_cost_usd")
		}
		if raw.Sizing.WarnLeafPredictedCostUSD == nil {
			missing = append(missing, "sizing.warn_leaf_predicted_cost_usd")
		}
		if raw.Sizing.MaxTreeLeaves == nil {
			missing = append(missing, "sizing.max_tree_leaves")
		}
		if raw.Sizing.MaxDepth == nil {
			missing = append(missing, "sizing.max_depth")
		}
		if raw.Sizing.MaxSubtasksPerParent == nil {
			missing = append(missing, "sizing.max_subtasks_per_parent")
		}
	}
	if raw.Repos == nil {
		missing = append(missing, "repos")
	} else {
		if len(raw.Repos.Known) == 0 {
			missing = append(missing, "repos.known")
		}
		if raw.Repos.LockstepMarker == nil || strings.TrimSpace(*raw.Repos.LockstepMarker) == "" {
			missing = append(missing, "repos.lockstep_marker")
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("thresholds %q missing required keys: %s", path, strings.Join(missing, ", "))
	}

	th := &Thresholds{
		Sizing: Sizing{
			MaxLeafPredictedCostUSD:  *raw.Sizing.MaxLeafPredictedCostUSD,
			MinLeafPredictedCostUSD:  *raw.Sizing.MinLeafPredictedCostUSD,
			WarnLeafPredictedCostUSD: *raw.Sizing.WarnLeafPredictedCostUSD,
			MaxTreeLeaves:            *raw.Sizing.MaxTreeLeaves,
			MaxDepth:                 *raw.Sizing.MaxDepth,
			MaxSubtasksPerParent:     *raw.Sizing.MaxSubtasksPerParent,
		},
		Repos: Repos{
			Known:          raw.Repos.Known,
			LockstepMarker: *raw.Repos.LockstepMarker,
		},
	}

	// Sanity: values must be usable (a zero bound would silently pass everything).
	var bad []string
	if th.Sizing.MaxLeafPredictedCostUSD <= 0 {
		bad = append(bad, "sizing.max_leaf_predicted_cost_usd must be > 0")
	}
	// A3 — INVERTED semantics vs the bounds above: min_leaf is a FLOOR, not a
	// cap/count, so 0 is legal and means "disabled" (no micro-leaf WARN). Only a
	// NEGATIVE floor is nonsensical.
	if th.Sizing.MinLeafPredictedCostUSD < 0 {
		bad = append(bad, "sizing.min_leaf_predicted_cost_usd must be >= 0 (0 disables)")
	}
	if th.Sizing.WarnLeafPredictedCostUSD <= 0 {
		bad = append(bad, "sizing.warn_leaf_predicted_cost_usd must be > 0")
	}
	if th.Sizing.MaxTreeLeaves <= 0 {
		bad = append(bad, "sizing.max_tree_leaves must be > 0")
	}
	if th.Sizing.MaxDepth <= 0 {
		bad = append(bad, "sizing.max_depth must be > 0")
	}
	if th.Sizing.MaxSubtasksPerParent <= 0 {
		bad = append(bad, "sizing.max_subtasks_per_parent must be > 0")
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("thresholds %q invalid: %s", path, strings.Join(bad, "; "))
	}

	return th, nil
}

// repoKnown reports whether a repo is in the known set or is the lockstep
// marker. (The needs-human gate on the lockstep marker is a plan precheck,
// not a sizing concern.)
func (th *Thresholds) repoKnown(repo string) bool {
	if repo == th.Repos.LockstepMarker {
		return true
	}
	for _, k := range th.Repos.Known {
		if k == repo {
			return true
		}
	}
	return false
}
