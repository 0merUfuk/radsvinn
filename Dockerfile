# Dockerfile — Mercury planner, one container for Railway.
#
# Two processes inside (service/server.mjs + service/slack.mjs), supervised
# by service/supervise.mjs, booted through deploy/entrypoint.mjs (volume
# layout at /data + grounding-repo sync). No public ingress: the server
# binds 127.0.0.1 (the bridge is its only client) and the bridge connects
# OUTBOUND to Slack via Socket Mode — see docs/OPERATIONS.md.

# ---- stage 1: treecheck — the deterministic gate, built once, static ------
# golang:1.25, not 1.24 — this repo's go.mod declares `go 1.25` and the
# official image ships GOTOOLCHAIN=local, so a 1.24 builder refuses it.
FROM golang:1.25 AS treecheck
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -o /treecheck ./cmd/treecheck

# ---- stage 2: runtime ------------------------------------------------------
FROM node:22-slim

# git — grounding clones/fetches + `git cat-file` anchor resolution;
# ca-certificates — HTTPS to Slack/Anthropic/Jira/GitHub.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The real engine shells `claude` headlessly (service/engine.mjs).
# PINNED: an unpinned global install would float the CLI under the service
# on every image rebuild — invocation flags (engine.mjs buildClaudeArgs) are
# validated against a specific CLI, so bumps must be deliberate. Check the
# current release with `npm view @anthropic-ai/claude-code version`.
RUN npm install -g @anthropic-ai/claude-code@2.1.207

WORKDIR /app
# .dockerignore keeps results/, VCS/internal-session artifacts, and service
# tests out; fixtures/, prompts/, .claude/, tools/, contracts/, and
# coupling-map.yaml all ride in.
COPY . .
COPY --from=treecheck /treecheck /usr/local/bin/treecheck

# MERCURY_REQUIRE_AUTH / MERCURY_REQUIRE_ENV_ONLY_TOKEN: the fail-closed
# boot gates are ON inside the container — even the loopback-bound server
# must carry real bearer auth, and the Jira token must be env-only (no
# file fallback on a server). MERCURY_FETCH_BEFORE_PLAN: fetch-before-plan — refresh
# grounding repos before every plan, degrade visibly when that fails.
ENV MERCURY_TREECHECK_BIN=/usr/local/bin/treecheck \
  NODE_ENV=production \
  MERCURY_REQUIRE_AUTH=1 \
  MERCURY_REQUIRE_ENV_ONLY_TOKEN=1 \
  MERCURY_FETCH_BEFORE_PLAN=1

# Runs as ROOT — a tested tradeoff, not an omission. Railway mounts the
# /data volume root-owned, and the entrypoint's first act is to require a
# writable /data. Verified locally (2026-07-10) against a fresh root-owned
# named volume:
#   docker run --user node -v <vol>:/data <img>  → FATAL "/data is missing
#                                                  or not writable", exit 1
#   docker run             -v <vol>:/data <img>  → "volume ready", boot
#                                                  proceeds
# `USER node` alone therefore bricks every boot. Dropping privileges only
# for the claude child is not cheap either: the agent needs $HOME=/data/home
# (the persistent session store) writable, which is root-owned on the
# volume, and a chown -R of a volume full of grounding repos on every boot
# is its own failure mode. Compensating controls: no public ingress, the
# agent subprocess runs env-stripped (sandboxedEnv) under permission-mode
# default with Read/Grep/Glob only, and the container is single-tenant.
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]
