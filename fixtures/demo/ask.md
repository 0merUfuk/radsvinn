<!-- SAMPLE for deterministic fake-demo plumbing — NOT part of the held-out 20-ask DoD set -->
---
id: demo
requester: demo-requester
role_lens: business
mode: front_door
stratum: big
---

Our web application's generation-history page is an undifferentiated list. Users who remember part of an old prompt cannot quickly find the generation they want, so we need prompt-text search for each user's own history.

The search must remain responsive for large histories. Add the appropriate prompt-text index through the web-app's normal database migration path before enabling the filtered queries.

Extend the existing generation-history endpoint with an optional, case-insensitive prompt substring filter. It must stay scoped to the authenticated user, preserve the existing soft-delete behavior, keep the count endpoint consistent, and work with both cursor and offset pagination. An absent or empty search term must preserve today's behavior.

On the history page, add a debounced prompt-search input wired to that filter. Clearing it restores the full history, pagination continues to work while searching, and the page has clear loading, error, empty-history, and no-results states.

Keep this additive and contained to the web-app. Do not change generation creation, credit handling, or unrelated history behavior.
