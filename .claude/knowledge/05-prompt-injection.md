# 05 — Prompt Injection & Sandbox

Mercury's service reads untrusted request text in a process that also coordinates credentials.
The threat model assumes an injected request may influence the planning agent, so current
controls reduce its tools and credential exposure.

## Current v0.1.0 controls

1. **Restricted agent tools** — default permission mode with `Read,Grep,Glob`; no shell or
   write tool.
2. **Argument-array spawn** — untrusted text is passed as an argv value, never interpolated
   into a shell command.
3. **Child environment deny-set** — `sandboxedEnv()` copies the inherited environment, then
   strips Jira, Slack, service, GitHub, OpenRouter, and Railway credential/metadata keys.
   This is not an explicit keep-set.
4. **Budget breakers** — per-plan and daily checks run before every planning call.
5. **Boot checks for the controls that exist** — direct service boot rejects unauthenticated
   non-loopback exposure (or any missing token when `MERCURY_REQUIRE_AUTH=1`) and can reject
   the local Jira-token fallback when env-only token posture is required.

## Future hardening

- Replace the child environment deny-set with an explicit keep-set.
- Add an enforceable network-egress allowlist.
- Add an operator kill switch.
- Decide which missing hardening controls must block boot, then implement and test those
  checks. v0.1.0 does not refuse boot merely because these future controls are absent.
