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
$env:BATTLECITY_EMBED_BROADCASTER = '1'
$env:BROADCASTER_BASE_URL = 'http://127.0.0.1:3001'
$env:BROADCASTER_API_URL = 'http://127.0.0.1:3001'
$env:BROADCASTER_PUBLIC_URL = 'http://127.0.0.1:3001'
npm run server:build
npm run server:start
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

## Production deployment

Production runs natively on Ubuntu as one Node process containing both the API
and authoritative broadcaster. Build both outputs before starting:

```bash
npm run server:build
npm run server:start
```

Configure `DATABASE_URL`, Google/Discord credentials,
`BATTLECITY_WEB_BASE_URL`, and the embedded runtime values in
`/etc/battlecities/api.env`. Use
`BATTLECITY_DATABASE_POOL_SIZE=2` on the 1 GB server.

For the Cherry chat embed, set both values in this same API-only environment:

```env
CHERRY_APP_ID=148185d2-9181-4e2f-9e4d-47e5b5c12f2a
CHERRY_APP_SECRET=<secret created in the Cherry portal>
```

The secret is used exclusively by `POST /api/cherry-embed-token` to mint
five-minute tokens for an authenticated wallet; never put it in the browser
site, a public environment variable, or a commit.

After deployment verify:

```text
https://api.battlecities.com/api/health
https://api.battlecities.com/api/ready
```

The frontend Cloudflare Pages project only needs
`BATTLECITY_API_BASE_URL=https://api.battlecities.com` and be redeployed.

The combined multiplayer values are:

```env
BATTLECITY_EMBED_BROADCASTER=1
BROADCASTER_BASE_URL=http://127.0.0.1:3001
BROADCASTER_API_URL=http://127.0.0.1:3001
BROADCASTER_PUBLIC_URL=https://api.battlecities.com
BROADCASTER_CLIENT_URL=https://play.battlecities.com
```

Embedded mode generates its private route-authorization token automatically at
startup. The native Ubuntu setup is documented in
[Deployment Environment Setup](../docs/environment-setup.md).

### Discord verification

Discord verification is owned by the native API. Configure these variables in
`/etc/battlecities/api.env` only:

```env
# Required for signed Discord HTTP interactions and /verify CODE fallback
DISCORD_APPLICATION_PUBLIC_KEY=<Discord Developer Portal General Information Public Key>
DISCORD_GUILD_ID=<Battle Cities Discord server ID>

# Required when automatic Discord OAuth verification is enabled
DISCORD_CLIENT_ID=<Discord Application ID>
DISCORD_CLIENT_SECRET=<Discord OAuth2 client secret>
DISCORD_OAUTH_STATE_SECRET=<new strong random secret>
DISCORD_OAUTH_REDIRECT_URI=https://api.battlecities.com/api/integrations/discord/oauth/callback

# Shared only with the Discord bot service; never the frontend
DISCORD_BOT_SERVICE_TOKEN=<new strong random secret>

# X OAuth follow connection
X_CLIENT_ID=<X OAuth 2.0 client ID>
X_CLIENT_SECRET=<X OAuth 2.0 client secret>
X_BEARER_TOKEN=<X app-only bearer token>
X_OAUTH_STATE_SECRET=<new strong random secret>
X_OAUTH_REDIRECT_URI=https://api.battlecities.com/api/integrations/x/oauth/callback
X_BATTLECITIES_USERNAME=BattleCitiesHQ
X_BATTLECITIES_USER_ID=<optional stable numeric X user ID>
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

The Discord bot reads role-assignment state through the bot-only endpoint:

```text
GET /api/integrations/discord/verified-users/:discordUserId
Authorization: Bearer <DISCORD_BOT_SERVICE_TOKEN>
```

It returns only `{ ok, discordUserId, verified }`. The bot owns its
`DISCORD_BOT_TOKEN`, role ID, and role assignment; those values must not be
configured on this API.

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
  set it to `https://play.battlecities.com` in production.
- `BATTLECITY_EVENT_ADMIN_SECRET`: bearer token required to approve final event
  prize allocations after an event ends.
- `BROADCASTER_BASE_URL`: loopback broadcaster-control origin; embedded
  production uses `http://127.0.0.1:3001`.
- `BROADCASTER_SERVICE_TOKEN`: generated automatically for embedded mode. Set it
  manually only when running the legacy standalone broadcaster command.

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

GET   /api/admin/session
GET   /api/admin/overview
GET   /api/admin/matches
GET   /api/admin/players
GET   /api/admin/tournaments
POST  /api/admin/tournaments
PATCH /api/admin/tournaments/:id
GET   /api/admin/tournaments/:id/leaderboard
POST  /api/admin/tournaments/:id/prizes/distribute
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
Apply all migrations, including `009_admin_tournaments`, before running the
updated API:

```powershell
npm --prefix api-server run db:migrate
```

### Presale devnet API

The presale frontend reads the live state from `GET /api/presale/state` and
creates and verifies SOL devnet purchases through `POST /api/presale/quote`
and `POST /api/presale/verify`. Apply migrations through `018_presale_token_delivery.sql`
before enabling these routes, then set the following values in the native API
environment:

```text
BATTLECITY_PRESALE_NETWORK=devnet
BATTLECITY_PRESALE_TREASURY_ADDRESS=6wQz66BgRsX6DVHAD3PDCXjKVpe3LLrj3FGiQwCSZV7F
BATTLECITY_PRESALE_TOKEN_MINT=feptDFpEGgFvxDwveWD6opDUCet5ve3f3WHPTBvBLvh
BATTLECITY_PRESALE_SOLANA_RPC_URL=https://api.devnet.solana.com
BATTLECITY_PRESALE_END_AT=2026-09-13T00:00:00.000Z
BATTLECITY_PRESALE_QUOTE_SECRET=<32 random bytes encoded as hex; server only>
BATTLECITY_PRESALE_DISTRIBUTION_ADDRESS=9YpW9nYJaUVhRwqWaJBBh9wkjCYh5RLr6krYvfr7GGKo
BATTLECITY_PRESALE_DISTRIBUTION_KEYPAIR_PATH=/etc/battlecities/secrets/batc-distribution.json
```

Only SOL devnet payments are enabled. BATC stage prices are fixed in SOL, so
quotes do not depend on an external market-price feed. A verified allocation is recorded by
transaction signature and one-time quote ID, so submitting the same confirmed
transaction remains idempotent while a quote cannot allocate BATC twice. Quote
reservations are included in atomic stage-cap checks. After payment verification,
the API creates the buyer's Token-2022 associated account when needed and transfers
the exact BATC allocation from the distribution wallet. The signed delivery is
stored before broadcast, and retries reuse the stored transaction until it expires,
preventing duplicate delivery. Keep the distribution keypair outside the repository
with mode `600`; the API never needs the treasury or mint-authority private key.

Local storage mode writes archive metadata and JSONL frame batches under
`server-data/match-archives`. Override that path with
`BATTLECITY_MATCH_ARCHIVE_DIR` for isolated local tests.

Do not add new HTTP behavior to the root route copies. New API work belongs in
`api-server/src/routes`, with supporting code in `config`, `middleware`,
`stores`, or `services` according to responsibility.
