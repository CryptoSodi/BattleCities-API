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
`GOOGLE_OAUTH_STATE_SECRET`, `BATTLECITY_WEB_BASE_URL`,
`BROADCASTER_BASE_URL`, and `BROADCASTER_SERVICE_TOKEN` in the API project.
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

The multiplayer deployment-specific values are:

```env
# Vercel API project only
BROADCASTER_BASE_URL=https://broadcaster.battlecities.com
BROADCASTER_SERVICE_TOKEN=replace-with-a-strong-random-secret
```

The service token must exactly match the headless broadcaster token and must
never be configured in the frontend Vercel project. The complete three-project
setup is documented in
[Deployment Environment Setup](../docs/environment-setup.md).

### Discord verification

Discord verification is owned by the Vercel API. Configure these variables on
the **battle-cities-api** Vercel project only:

```env
# Required for signed Discord HTTP interactions and /verify CODE fallback
DISCORD_APPLICATION_PUBLIC_KEY=<Discord Developer Portal General Information Public Key>
DISCORD_GUILD_ID=<Battle Cities Discord server ID>

# Required when automatic Discord OAuth verification is enabled
DISCORD_CLIENT_ID=<Discord Application ID>
DISCORD_CLIENT_SECRET=<Discord OAuth2 client secret>
DISCORD_OAUTH_STATE_SECRET=<new strong random secret>
DISCORD_OAUTH_REDIRECT_URI=https://api.battlecities.com/api/integrations/discord/oauth/callback
```

`DISCORD_APPLICATION_PUBLIC_KEY` is public application metadata, but every
other Discord value above must remain private. Do not add any of them to the
frontend Vercel project. `DISCORD_BOT_TOKEN` belongs only to the separate bot
project and is not needed by the API for verification.

`DISCORD_APP_PUBLIC_KEY` and `DISCORD_PUBLIC_KEY` are accepted as aliases for
`DISCORD_APPLICATION_PUBLIC_KEY` to support existing Vercel configuration.

In Discord Developer Portal configure these URLs after the API is deployed:

```text
Interactions Endpoint URL
https://api.battlecities.com/api/integrations/discord/interactions

OAuth2 Redirect URL
https://api.battlecities.com/api/integrations/discord/oauth/callback
```

The signed interactions endpoint keeps `/verify CODE` as a fallback. The game
uses the automatic OAuth flow at `/integrations/discord/oauth/start`; it uses
`identify` and `guilds.members.read` to confirm that the logged-in player
belongs to `DISCORD_GUILD_ID`.

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
- `BROADCASTER_BASE_URL`: private API-to-broadcaster service origin; production
  uses `https://broadcaster.battlecities.com`.
- `BROADCASTER_SERVICE_TOKEN`: shared bearer secret used only by the Vercel API
  and broadcaster service. Never configure it in the frontend project.

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
POST /api/multiplayer/matches/:matchId/result  (broadcaster only)

GET  /api/multiplayer/archives                    (broadcaster only)
GET  /api/multiplayer/archives/:matchId           (broadcaster only)
GET  /api/multiplayer/archives/:matchId/frames    (broadcaster only)
POST /api/multiplayer/archives/:matchId/start     (broadcaster only)
POST /api/multiplayer/archives/:matchId/frames    (broadcaster only)
POST /api/multiplayer/archives/:matchId/complete  (broadcaster only)

POST /api/events/:eventId/enter
POST /api/events/:eventId/start
GET  /api/events/:eventId/leaderboard
POST /api/events/:eventId/prizes/approve
```

Normal waiting-room exits refund the fuel charged for that match. Event entry
fuel is not refunded. The broadcaster submits both authoritative player scores;
player-authenticated score submissions are rejected. Event leaderboards retain
each real player's best accepted score and give tied scores the same rank. Prize
approval records an explicit administrator-supplied allocation and does not
transfer funds automatically.

The headless broadcaster records every authoritative host frame in contiguous,
idempotent PostgreSQL batches. Archive metadata includes both players, game
type, level, seed, simulation configuration, final result, and score details.
Apply migration `005_match_archives` before running the updated broadcaster:

```powershell
npm --prefix api-server run db:migrate
```

Local storage mode writes archive metadata and JSONL frame batches under
`server-data/match-archives`. Override that path with
`BATTLECITY_MATCH_ARCHIVE_DIR` for isolated local tests.

Do not add new HTTP behavior to the root route copies. New API work belongs in
`api-server/src/routes`, with supporting code in `config`, `middleware`,
`stores`, or `services` according to responsibility.
