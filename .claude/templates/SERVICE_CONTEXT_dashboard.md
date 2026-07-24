# Service Context: Dashboard (`dashboard/`)

## Purpose
GitHub-OAuth BFF + client renderer for the human approval UI.

## Public interface
- `/` — landing / login.
- `/oauth/callback` — GitHub OAuth callback.
- `/plan/:id` — plan approval view.
- `/api/plan/:id` — BFF proxy to planner.

## Key files
- `server.mjs` — BFF.
- `lib/oauth.mjs`, `lib/sessions.mjs`, `lib/rbac.mjs` — auth.
- `public/app.js` — client renderer.

## Env
- `DASH_GITHUB_ORG`
- `DASH_ROLE_BOOTSTRAP`
- `DASH_PLANNER_URL`

## Tests
```bash
cd dashboard && node --test test/*.test.mjs
```
