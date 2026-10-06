# Battle Cities API 0.3.0

Standalone HTTP API for the current single-player game and command center.
Node.js 18+; PostgreSQL is required in production. Local JSON storage is for
development and tests. Admin reporting and replay review require PostgreSQL.

## Run

```sh
npm ci
npm run db:migrate
npm run build
npm start
```

The listener defaults to `127.0.0.1:3001`. Configure `DATABASE_URL`,
`BATTLECITY_DATABASE_SSL`, `BATTLECITY_API_HOST`, `PORT` and
`BATTLECITY_WEB_BASE_URL`. Use `BATTLECITY_STORAGE_MODE=local` only for local
development. `npm test` builds and runs the retained test suite; `npm run
smoke:local` starts an isolated temporary API for read-only contract checks.

## Guest and wallet login

Calls are relative to `/api`. Session responses set an HTTP-only
`battlecity_session` cookie; clients must retain/send that cookie.

- `POST /session` with `{ "provider": "guest" }` creates a server-generated
  guest player. Repeating this call with a valid session resumes that identity.
  Client-supplied player IDs cannot select another player's account.
- `PUT /session` with `{ "walletAddress": "..." }` returns a five-minute
  challenge (`nonce`, `message`). Sign the exact UTF-8 message with the wallet.
- `POST /session` with `provider: "wallet"`, `walletAddress`, `nonce`, `message`
  and the base64 `signature` authenticates a wallet. Challenges are single-use.
- `GET /session` reads the session; `DELETE /session` logs out.
- `GET/PUT /player` reads progress or merges personal high scores.
- `GET /players/{id}/profile` reads the profile and paginated recent battles.
  `/players/{id}/profile/matches/{resultId}/replay` reads saved replay stages.

Guests have personal progress, inventory and powerup consumption. On-chain
purchases, competition rankings/prizes, swaps and social rewards require a wallet.
Guest history is separate from wallet history. Logout does not delete the player.

## Retained game API

- `POST /matches/submit`: stores single-player facts and derives game points.
  Client-supplied approval or points are ignored; prize approval remains manual.
- `GET/POST /replays`, `POST /replays/validate`: recordings and metadata checks.
- `GET /rankings`, `/leaderboard/rewards`, `/leaderboard/cycles`,
  `/leaderboard/payouts`, `/seasons/current`, `/seasons/pass`: current cycles,
  seasons, pass ownership, prize policy and history.
- `GET /economy/catalog`, `GET/PUT /economy/account`, `GET /economy/ledger`,
  `/economy/wallet-balance`, `POST /economy/purchase/quote`,
  `/economy/purchase/verify`: catalog, balances, inventory/loadouts and checkout.
- `POST /economy/powerups/consume`, `/economy/drops/roll`,
  `/economy/drops/claim`: idempotent consumption and powerup drop delivery.
- X and Discord linking, verification and fuel rewards, including native OAuth.
- `/trading/tokens`, `/trading/verify-swap`, `/trading/swap/quote`,
  `/trading/swap/execute`: shop swaps and verified trading rankings; no combat perks.
- Presence, notification device registration, health and readiness.

See [COMPETITIONS.md](COMPETITIONS.md) for SOL/SKR season pass pricing, full-season
backfill, reward policy, approval gates and payout worker configuration.

## Admin

The web command center at `/admin/` uses wallet challenge login. Only the wallet
allowlist in `src/middleware/admin.ts` can access admin routes. Guest sessions
and legacy Google sessions cannot authorize an administrator.

Retained controls: overview, single-player matches/replays, player search,
X social tasks/connections, push notifications and live-user visibility.
`GET/PUT /admin/competitions` controls pass prices and cycle/season prize tiers.
`GET/POST /admin/match-reviews` lists and audits prize approval decisions.
Settings/review APIs are available; their dashboard forms are future work.

Firebase push delivery uses a service account (`FIREBASE_SERVICE_ACCOUNT_JSON`
or `FIREBASE_SERVICE_ACCOUNT_BASE64`) independently of player authentication.
No Google player login SDK or OAuth routes remain.

## Migration and retired systems

Apply `031_guest_wallet_auth` before starting this release. It changes active
provider constraints to guest/wallet. It preserves existing rows and historical
migrations; legacy Google identities become inaccessible through login or profiles.
No production data is deleted by this cleanup.

Shop configuration now uses only `BATTLECITY_SHOP_*` settings. Rename any
legacy `BATTLECITY_PRESALE_*` checkout settings before deploying. In particular,
set `BATTLECITY_SHOP_QUOTE_SECRET` to a secret of at least 32 characters.

Google login, multiplayer matchmaking/results/tournaments, WebRTC signaling,
broadcaster/headless integration, diagnostic sockets, staking, airdrops,
quests/campaigns, presale, combat boosts and Cherry token routes are retired.
Requests to those routes return 404. Old web multiplayer clients must not point
at this API. Separate legacy game/headless projects outside `api-server` remain
outside this cleanup.
