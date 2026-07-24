.PHONY: demo test gate public-scan check status help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

demo: ## Run the planner against the fake engine with a sample ask
	@echo "Running fake-engine demo..."
	node service/demo.mjs fixtures/demo/ask.md

test: ## Run all tests (Go + service + dashboard)
	@echo "Running Go tests..."
	go test -count=1 ./...
	@echo "Running service tests (fake engine)..."
	MERCURY_ENGINE=fake MERCURY_SKIP_PLAN_ANCHORS=1 node --test service/test/*.test.mjs
	@echo "Running dashboard tests..."
	cd dashboard && node --test test/*.test.mjs

gate: ## Run the deterministic skeleton gate on a bundled fixture
	@echo "Running deterministic skeleton gate..."
	go run ./cmd/treecheck -mode=skeleton < fixtures/e2e-sample/skeleton.json

public-scan: ## Scan releasable files for forbidden terms and local paths
	@echo "Scanning releasable files for forbidden terms and local paths..."
	@internal_tracked="$$(git ls-files --cached -- \
		':(glob)tasks/**' \
		':(glob).agents/**' \
		'CODEX-HANDOFF.md' \
		'CODEX_HANDOFF.md' \
		2>&1)"; \
	internal_status=$$?; \
	if [ "$$internal_status" -ne 0 ]; then \
		printf '%s\n' "$$internal_tracked" >&2; \
		echo "Public leak scan failed to inspect internal-artifact tracking state." >&2; \
		exit 2; \
	elif [ -n "$$internal_tracked" ]; then \
		printf '%s\n' "$$internal_tracked"; \
		echo "Public leak scan failed: internal-only artifacts are tracked or staged." >&2; \
		exit 1; \
	fi; \
	scan_pattern='try''pix|try''pixai|T''PX|user-''credits|fe-''category|b2fb''2993|/Use''rs/|mercury-''product|calib-fixture-o''mer|dod-corpus-o''mer|(^|[^[:alnum:]_])o''mer([^[:alnum:]_]|$$)|Ö''mer'; \
	content_output="$$(git grep --untracked --exclude-standard -nIiE "$$scan_pattern" -- \
		. \
		':(exclude,glob).git/**' \
		':(exclude,glob)tasks/**' \
		':(exclude,glob).agents/**' \
		':(exclude,glob)**/node_modules/**' \
		':(exclude,glob)**/results/**' \
		':(exclude)CODEX-HANDOFF.md' \
		':(exclude)CODEX_HANDOFF.md' \
		2>&1)"; \
	content_status=$$?; \
	if [ "$$content_status" -eq 0 ]; then \
		printf '%s\n' "$$content_output"; \
		echo "Public leak scan failed: forbidden terms or local paths found." >&2; \
		exit 1; \
	elif [ "$$content_status" -ne 1 ]; then \
		printf '%s\n' "$$content_output" >&2; \
		echo "Public leak scan failed to complete." >&2; \
		exit 2; \
	fi; \
	path_output="$$(git ls-files --cached --others --exclude-standard -- \
		. \
		':(exclude,glob).git/**' \
		':(exclude,glob)tasks/**' \
		':(exclude,glob).agents/**' \
		':(exclude,glob)**/node_modules/**' \
		':(exclude,glob)**/results/**' \
		':(exclude)CODEX-HANDOFF.md' \
		':(exclude)CODEX_HANDOFF.md' \
		2>&1)"; \
	path_status=$$?; \
	if [ "$$path_status" -ne 0 ]; then \
		printf '%s\n' "$$path_output" >&2; \
		echo "Public leak filename scan failed to list releasable files." >&2; \
		exit 2; \
	fi; \
	path_matches="$$(printf '%s\n' "$$path_output" | grep -iE -- "$$scan_pattern" 2>&1)"; \
	path_scan_status=$$?; \
	if [ "$$path_scan_status" -eq 0 ]; then \
		printf '%s\n' "$$path_matches"; \
		echo "Public leak scan failed: forbidden terms or local paths found in releasable filenames." >&2; \
		exit 1; \
	elif [ "$$path_scan_status" -ne 1 ]; then \
		printf '%s\n' "$$path_matches" >&2; \
		echo "Public leak filename scan failed to complete." >&2; \
		exit 2; \
	fi
	@echo "Public leak scan passed."

check: ## Full release check: demo + tests + gate + public leak scan
	@echo "Running full release check..."
	$(MAKE) demo
	$(MAKE) test
	$(MAKE) gate
	$(MAKE) public-scan

status: ## Collation health check
	@echo "Git status:"
	@git status --short
	@echo "HEAD: $$(git rev-parse --short HEAD)"
	@echo "Branch: $$(git branch --show-current)"
	@echo "Worktrees:"
	@git worktree list
	@echo "Go build:"
	@go build ./... && echo "  OK"
