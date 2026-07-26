# Database operations

PostgreSQL is mandatory whenever `NODE_ENV=production` or
`VERCEL_ENV=production`. Local JSON storage exists only for development and
smoke testing; production startup and store access fail fast without a
database URL.

## Schema inventory

| Area | PostgreSQL tables | Development JSON fallback |
| --- | --- | --- |
| Players and sessions | `battlecity_players`, `battlecity_sessions`, `battlecity_wallet_challenges` | `server-data/players`, `server-data/sessions`, `server-data/wallet-challenges` |
| Economy | `battlecity_economy_accounts`, `battlecity_ledger_entries` | `server-data/economy`, `server-data/ledger` |
| Matches and seasons | `battlecity_match_results`, `battlecity_seasons`, `battlecity_leaderboard_rows` | `server-data/match-results`, `server-data/seasons`, `server-data/leaderboard-snapshots` |
| Replays | `battlecity_replays` plus Vercel Blob payloads | `server-data/replays` |
| Events and rewards | `battlecity_quest_progress`, `battlecity_event_currency_balances`, `battlecity_airdrop_state`, `battlecity_staking_state` | `server-data/events`, `server-data/airdrops`, `server-data/staking` |
| Trading | `battlecity_trading_volume` | `server-data/trading` |
| WebRTC registry | `battlecity_webrtc_signals`, `battlecity_webrtc_observers` | `server-data/webrtc-signals` |

The migration runner additionally owns `battlecity_schema_migrations`.

## Environment variables

- `DATABASE_URL` is preferred. `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, and
  `POSTGRES_URL_NON_POOLING` remain supported aliases.
- `BATTLECITY_STORAGE_MODE=local` explicitly selects development JSON storage.
  It is rejected in production.
- `BATTLECITY_DATABASE_SSL=disable|require|verify-full` controls TLS. Production
  defaults to `require` for provider compatibility.
- `BATTLECITY_DATABASE_POOL_SIZE` defaults to `10`.
- `BATTLECITY_DATABASE_CONNECT_TIMEOUT_MS` defaults to `5000`.
- `BATTLECITY_DATABASE_IDLE_TIMEOUT_MS` defaults to `30000`.
- `BATTLECITY_TEST_DATABASE_URL` enables the optional live integration test.
- `BLOB_READ_WRITE_TOKEN` is required for production replay payload storage;
  replay routes never fall back to local files in production.

## Deployment procedure

1. Back up the target database.
2. Set `DATABASE_URL` and any TLS/pool variables in the API environment.
3. Run `npm --prefix api-server run db:migrate` once for the release.
4. Run `npm --prefix api-server run db:check`.
5. Deploy the API and verify `GET /api/ready` returns HTTP 200 with
   `storage: "postgres"` and migration `002_constraints`.

Migrations run once, in filename order, inside transactions. Stores verify the
latest migration before using PostgreSQL and never run schema DDL during a
request.
