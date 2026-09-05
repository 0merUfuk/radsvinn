# Migrating to Radsvinn

Radsvinn replaces the Mercury product identity. The repository/module is
`github.com/0merUfuk/radsvinn`; the private Node packages are
`radsvinn-dashboard` and `radsvinn-harness`. The gate remains `treecheck`.
This source change does not publish packages, rename a remote, redeploy services,
or rewrite data. Repository and hosting metadata require separate operator cutover.

## Configuration

Use `RADSVINN_` for new configuration. All 54 previously accepted `MERCURY_`
settings remain deprecated aliases; the [frozen inventory](../fixtures/identity/legacy-env-keys.json)
lists each previous key and its consumers, including computed model/effort seats
and supervisor commands. `DASH_`, Slack, GitHub and provider-native settings keep
their names.

Resolution is per key: a present canonical setting wins, including an empty
string. An invalid canonical value never recovers the legacy alias. Each
consumer retains its prior types, defaults and validation: blank allowed-tools
stays blank, an unknown runtime/provider fails, and blank or invalid numeric
budget settings retain existing defaults. Read timing is unchanged: fake fault
switches and breakers remain dynamic; State pins its root at construction;
dashboard config snapshots at boot.

For example, `RADSVINN_SERVICE_TOKEN=''` with `MERCURY_SERVICE_TOKEN` populated
resolves to an empty bearer and fails required-auth boot. Set canonical values
before removing old aliases. Keep old settings available when rolling back to
an older image, which cannot read the new prefix. Do not print credentials while
comparing configurations.

Four baked planner-image defaults deliberately retain legacy names:
`MERCURY_TREECHECK_BIN`, `MERCURY_REQUIRE_AUTH`,
`MERCURY_REQUIRE_ENV_ONLY_TOKEN`, and `MERCURY_FETCH_BEFORE_PLAN`.
Docker merges operator variables before Node runs; canonical image defaults
would mask old operator overrides. Canonical operator settings still win.
The deploy entrypoint still forces `/data/results` and `/data/repos`.

The single resolver lives in `dashboard/lib/env.mjs` so the independent dashboard
image and private package include it. Other Node entrypoints import that same
implementation. The harness remains a repository-local instrument, as before.

## Retained contracts

| Contract | Migration behavior |
| --- | --- |
| Plans, audit and spend | Keep `results/service/plans`, `results/service/audit`, daily spend files and the telemetry lock. Existing JSON fields and stored text are unchanged. |
| Artifacts and tracker recovery | Keep `results/agent/svc-<id>` and `created-record.json`, including partial-write records, `created` and `attached_epic` markers. These prevent duplicate creation and preserve cancel/verify recovery. No ticket data is rewritten. New comments name Radsvinn; no branded Jira idempotency label exists in the writer. |
| JSON schemas | Keep the historical `$id` URLs under `/mercury/contracts/`; only display titles change. |
| Browser cookies | Keep `__Host-mercury_dash`, `__Host-mercury_oauth` and `__Host-mercury_return_to`. HMAC format, signing input and OAuth PKCE derivation stay unchanged. |
| CSRF | Browser and BFF keep `X-Mercury-CSRF`, preserving old/new browser-server compatibility without an alternate security protocol. |
| GitHub authorization | Default teams remain `mercury-planners`, `mercury-approvers` and `mercury-creators`. Coordinate membership and set `DASH_TEAM_PLANNERS`, `DASH_TEAM_APPROVERS` and `DASH_TEAM_CREATORS` explicitly when renaming teams. The server never implicitly authorizes both sets. |
| Local Jira token | Use `~/.config/radsvinn/jira-token`; `~/.config/mercury/jira-token` remains a read-only compatibility fallback only when the canonical path is absent. A resolved nonempty env token wins. The env-only boot guard rejects either path, even with env auth populated. |
| Operator env file | The optional shell example now uses `~/.config/radsvinn/service.env`. It is manually sourced, never auto-loaded; existing operator-chosen paths still work. |

Sessions remain in memory; a process restart already ends them. Retained cookie
names do not promise session survival across redeploys. There is no browser
plan/session local-storage or IndexedDB migration to perform.

Both secret prefixes are denied to model children, including the standalone
harness, and checked by browser secret scanners. Child diagnostics redact both
conflicting credential values before truncation. Deterministic writer and Git
children retain the configuration needed for their existing responsibilities.

## Verification and eventual removal

`make identity-scan` enumerates residual case-insensitive content/path references
with categories and reasons. The [allowlist](identity-reference-allowlist.json)
binds exceptions to exact lines using SHA-256 and occurrence counts; a changed
line, added old-brand filename, duplicate occurrence, or unused allowance fails.
Historical changelog text and the old forbidden-token public-leak guard remain.
Dependencies, font binaries, Git internals, secrets and private local task
artifacts are explicitly outside the reference audit.

Identity tests cover every alias, precedence, dynamic reads, boot rejection,
writer/supervisor entrypoints, persisted records, browser contracts, child secret
denial/redaction, container defaults, and injected audit failures. Existing
fake-engine suites remain the lifecycle checks; run `make check` and
`npm test --prefix harness` before integration. No live model/tracker call is
required. Claude and Codex adapters share orchestration; synthetic adapter tests
do not prove full live Codex plan validity, and absent currency telemetry remains
unknown.

## Local Jira token migration and rollback

New laptop installations use `~/.config/radsvinn/jira-token` with mode `600`.
Environment alias selection stays unchanged: after that selection, a nonempty
token wins over files. Otherwise, the canonical file wins by presence, including
an empty file. An unreadable canonical file produces a content-free warning and
does not fall through to the legacy file. Loose file permissions still warn.
No credential file is automatically written, moved, or removed.

For an existing laptop installation, stop local writer/service processes first.
To opt in, run this locally only if the canonical destination does not already
exist. These commands move the existing file without displaying its contents:

```sh
mkdir -p "$HOME/.config/radsvinn"
mv -n "$HOME/.config/mercury/jira-token" "$HOME/.config/radsvinn/jira-token"
chmod 600 "$HOME/.config/radsvinn/jira-token"
```

`mv -n` prevents overwriting an existing destination. If both paths already
exist, stop and resolve which credential to retain locally; Radsvinn selects the
canonical file. Do not copy credential values into logs or support messages.

Before rolling back to an older image that only understands the legacy path,
stop local processes and reverse the move only if the legacy destination is
absent:

```sh
mkdir -p "$HOME/.config/mercury"
mv -n "$HOME/.config/radsvinn/jira-token" "$HOME/.config/mercury/jira-token"
chmod 600 "$HOME/.config/mercury/jira-token"
```

Restart only after the intended path and permissions are in place. Servers with
`RADSVINN_REQUIRE_ENV_ONLY_TOKEN=1` must have neither file: the presence of either
path is fatal even if the other is absent or environment auth is populated.
The local-file migration above is for laptop use, not env-only server setup.

Alias or retained-contract removal requires a documented breaking release,
evidence of remaining legacy usage, and an explicit migration/rollback procedure.
This migration supplies no date-based removal promise.
