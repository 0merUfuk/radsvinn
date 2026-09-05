// Command treecheck runs Radsvinn's deterministic validation over a skeleton or
// a groomed plan read from stdin and emits the verdict as JSON on stdout.
//
// Usage:
//
//	treecheck -mode=skeleton [-thresholds=<path>] < skeleton.json
//	treecheck -mode=plan [-thresholds=<path>] [-coupling-map=<path>] [-repos-root=<path>] < plan.json
//
// Exit codes:
//
//	0  OK — no hard failure
//	1  hard fail (a failed check, or a contract/parse BLOCK)
//	2  usage or configuration error (bad flags, unreadable stdin, bad thresholds)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/0merUfuk/radsvinn/internal/checks"
)

func main() {
	os.Exit(run())
}

func run() int {
	mode := flag.String("mode", "", "validation mode: skeleton | plan (required)")
	thresholdsPath := flag.String("thresholds", "internal/checks/thresholds.yaml", "path to thresholds.yaml (default: relative to the radsvinn module root / CWD)")
	couplingMapPath := flag.String("coupling-map", "coupling-map.yaml", "path to coupling-map.yaml (plan mode; default: relative to CWD)")
	reposRoot := flag.String("repos-root", "..", "root under which <repo>/<path> code anchors are resolved (plan mode; default: the grounding workspace, one level above the radsvinn CWD)")

	flag.Usage = usage
	flag.Parse()

	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "treecheck: read stdin:", err)
		return 2
	}

	th, err := checks.LoadThresholds(*thresholdsPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "treecheck:", err)
		return 2
	}

	switch *mode {
	case "skeleton":
		return runSkeleton(input, th)
	case "plan":
		return runPlan(input, th, *couplingMapPath, *reposRoot)
	default:
		fmt.Fprintln(os.Stderr, "treecheck: -mode must be 'skeleton' or 'plan'")
		flag.Usage()
		return 2
	}
}

// runSkeleton validates a skeleton and emits its verdict.
func runSkeleton(input []byte, th *checks.Thresholds) int {
	s, complaints := checks.ValidateSkeletonContract(input)
	if len(complaints) > 0 {
		emitJSON(checks.ContractFailVerdict(complaints))
		return 1
	}
	v := checks.ValidateSkeleton(s, th)
	emitJSON(v)
	if v.OK {
		return 0
	}
	return 1
}

// runPlan validates a plan and emits a per-item verdict map plus an overall ok.
func runPlan(input []byte, th *checks.Thresholds, couplingMapPath, reposRoot string) int {
	p, complaints := checks.ValidatePlanContract(input)
	if len(complaints) > 0 {
		emitJSON(checks.ContractFailVerdict(complaints))
		return 1
	}
	verdicts := checks.PrecheckPlan(p, th, couplingMapPath, reposRoot)
	allOK := true
	for _, v := range verdicts {
		if !v.OK {
			allOK = false
			break
		}
	}
	emitJSON(map[string]any{"items": verdicts, "ok": allOK})
	if allOK {
		return 0
	}
	return 1
}

// emitJSON writes v as indented JSON to stdout.
func emitJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, "treecheck: encode output:", err)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `treecheck — Radsvinn deterministic skeleton/plan validation (stdin → stdout JSON)

Usage:
  treecheck -mode=skeleton [-thresholds=<path>] < skeleton.json
  treecheck -mode=plan [-thresholds=<path>] [-coupling-map=<path>] [-repos-root=<path>] < plan.json

Flags:
  -mode          skeleton | plan (required)
  -thresholds    path to thresholds.yaml   (default "internal/checks/thresholds.yaml")
  -coupling-map  path to coupling-map.yaml (default "coupling-map.yaml", plan mode)
  -repos-root    root for resolving <repo>/<path> code anchors
                 (default "..", the grounding workspace above the radsvinn CWD, plan mode)

Defaults assume the process runs from the radsvinn module root.

Output:
  skeleton  a single Verdict object
  plan      {"items": {"<temp_id>": Verdict, ...}, "ok": <all items ok>}

Exit codes:
  0  OK          no hard failure
  1  hard fail   a failed check, or a malformed/contract-invalid input (BLOCK)
  2  usage error bad flags, unreadable stdin, or bad thresholds
`)
}
