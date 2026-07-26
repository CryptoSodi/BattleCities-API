# BattleCities API server

This package owns the canonical BattleCities HTTP dispatcher, routes, and
backend modules. Configuration lives in `src/config`, request middleware in
`src/middleware`, persistence in `src/stores`, and domain integrations and
policies in `src/services`. The repository-root `api/router.ts` is only a
compatibility entry for the existing frontend Vercel project. Root `routes/`
and `server/` remain temporarily for the embedded webpack development API and
backend jobs.

## Local development

From the repository root:

```powershell
npm run api:build
npm run api:start
```

With the API running, validate health, CORS, and signaling from another
terminal:

```powershell
npm --prefix api-server run smoke
```

Or build and run the self-contained local smoke lifecycle:

```powershell
npm run api:build
npm --prefix api-server run smoke:local
```

## Vercel deployment

Create a separate Vercel project from this repository with these settings:

- Root Directory: `api-server`
- Framework Preset: `Other`
- Build and Output settings: leave the project defaults unchanged; the
  package's `vercel.json` runs production database migrations and deploys
  `api/router.ts` as a Vercel Function. The minimal `public` directory satisfies
  Vercel's custom-build output requirement without deploying the game UI.
  Preview builds skip migrations so they cannot change the production schema.

Configure `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_OAUTH_STATE_SECRET`, and `BATTLECITY_WEB_BASE_URL` in the API project.
Set `BATTLECITY_WEB_BASE_URL=https://www.battlecities.com`. Production replay
storage also requires `BLOB_READ_WRITE_TOKEN`. A small per-instance pool such
as `BATTLECITY_DATABASE_POOL_SIZE=2` is recommended for Vercel because the Neon
URL is already pooled.

After deployment, assign `api.battlecities.com` to the API project and verify:

```text
https://api.battlecities.com/api/health
https://api.battlecities.com/api/ready
```

The frontend Vercel project must set
`BATTLECITY_API_BASE_URL=https://api.battlecities.com` and be redeployed.

Production migration builds use a PostgreSQL advisory lock, so overlapping
deployments wait for one another instead of applying the same migration
concurrently. Failed migrations stop the deployment before it is published.

Database migrations, readiness checks, and the schema/fallback inventory are
documented in [`docs/database.md`](docs/database.md).

The API listens at `http://127.0.0.1:3001` by default. In a second terminal,
run the frontend through the standalone API proxy:

```powershell
$env:BATTLECITY_USE_STANDALONE_API = '1'
npm start
```

Useful variables:

- `PORT`: API port, default `3001`.
- `BATTLECITY_API_HOST`: bind host, default `127.0.0.1`.
- `BATTLECITY_API_PROXY_TARGET`: frontend development proxy target.
- `BATTLECITY_API_BASE_URL`: browser API origin. Production defaults to
  same-origin until this is set to `https://api.battlecities.com` in the
  frontend Vercel project.
- `BATTLECITY_WEB_BASE_URL`: game origin used after API-hosted OAuth callbacks;
  set it to `https://www.battlecities.com` in production.
- `BATTLECITY_EVENT_ADMIN_SECRET`: bearer token required to approve final event
  prize allocations after an event ends.

## Multiplayer API

Direct matchmaking consumes one unit of the authenticated player's server-side
fuel balance. Event admission consumes the configured event fuel cost once and
is never refundable. Reconnection reuses the existing membership without a new
fuel charge, and public observers never occupy a player slot.

```text
POST /api/multiplayer/direct/start
GET  /api/multiplayer/matches/live
GET  /api/multiplayer/matches/:matchId
POST /api/multiplayer/matches/:matchId/reconnect
POST /api/multiplayer/matches/:matchId/started
POST /api/multiplayer/matches/:matchId/exit
POST /api/multiplayer/matches/:matchId/observe
POST /api/multiplayer/matches/:matchId/score

POST /api/events/:eventId/enter
POST /api/events/:eventId/start
GET  /api/events/:eventId/leaderboard
POST /api/events/:eventId/prizes/approve
```

Normal waiting-room exits refund the fuel charged for that match. Event entry
fuel is not refunded. Submitted scores remain pending validation; event
leaderboards retain each real player's best non-rejected score and give tied
scores the same rank. Prize approval records an explicit administrator-supplied
allocation and does not transfer funds automatically.

Do not add new HTTP behavior to the root route copies. New API work belongs in
`api-server/src/routes`, with supporting code in `config`, `middleware`,
`stores`, or `services` according to responsibility.
