# Competitions and native client API (0.3.0)

All paths below are relative to `/api`. Authenticated calls use the existing
`battlecity_session` cookie. Admin calls use the existing admin allowlist.
The Unity Shop UI still needs to consume this catalog; this change implements
the API and does not add a Unity tab or an admin dashboard screen.

## Season passes

One 30-minute gaming cycle runs alongside the current season. Everyone eligible
for rankings can enter the cycle without a pass. Seasonal gaming rankings require
a pass for that season. Buying it includes **all eligible matches from the start
of that season**, including matches played before purchase, plus later matches.
Rejected and guest matches never count. Purchasing again does not duplicate points.
The pass expires at the season end and never credits a different season.

- `GET /economy/catalog` (alias `/seasons/pass`): items, SOL/SKR prices, current
  season, pass ownership, scoring policy, and purchase availability. The pass
  descriptor has `id: "season-pass"` and `tab: "SEASON PASS"`.
- `POST /economy/purchase/quote`: `{ "itemId": "season-pass", "currency": "skr",
  "seasonId": "season-1", "walletAddress": "<authenticated wallet>" }`.
  Use `"sol"` for SOL. Sign the returned transaction with the authenticated wallet.
- Submit the signed transaction using the existing wallet flow, then
  `POST /economy/purchase/verify`: `{ "quoteToken": "...", "signature": "..." }`.
  The response contains the entitlement and account. Repeating verification with
  the same payment returns the existing purchase. A quote is valid for two minutes,
  with one minute of clock skew. Sales close three minutes before the season ends.
- `GET /economy/wallet-balance` adds `skrBalance` and `skrBalanceAtomic` as exact
  decimal strings. They are null until SKR is configured. Existing BATC fields remain.

## Admin prices and prizes

`GET /admin/competitions` reads settings. `PUT /admin/competitions` replaces the
complete document. Prices and rewards are decimal strings in whole currency units.
All sales and prize policies start disabled. Example amounts below are illustrative,
not production defaults:

```json
{
  "seasonPass": { "enabled": true, "skrPrice": "500", "solPrice": "0.1" },
  "cycle": { "enabled": true, "prizes": [
    { "fromRank": 1, "toRank": 1, "amount": "1000" },
    { "fromRank": 2, "toRank": 3, "amount": "500" },
    { "fromRank": 4, "toRank": 10, "amount": "250" }
  ] },
  "season": { "enabled": false, "prizes": [] },
  "tradingSeason": { "enabled": false, "prizes": [] },
  "shopSkrPrices": {}
}
```

Cycle prize ranks must be 1–10; season prize ranks can be 1–100, with no overlaps. Prize payments use SKR. Optional
`shopSkrPrices` maps existing catalog item IDs to SKR prices. Null disables that
item's SKR option. Signed checkout prices remain valid if settings change during
checkout. Open competition policies refresh on the next worker tick or live-board
request; closed competitions preserve their policy and allocations.

## Rankings and history

- `GET /leaderboard/rewards`: current cycle, countdown, dynamic prize tiers,
  top ten and current player. Cycles continue across season boundaries.
- `GET /leaderboard/cycles?limit=20&before=<ISO time>`: completed intervals,
  with `nextBefore` pagination. `GET /leaderboard/cycles?id=cycle:<epoch-ms>`:
  standings and payout records. Historical intervals from before this worker was
  enabled can be archived for display but never generate retroactive prizes.
- `GET /leaderboard/payouts?periodId=...&playerId=...&limit=20&before=...`:
  either filter is optional; use the returned `nextBefore` cursor.
- `GET /rankings?scope=gaming|trading&seasonId=season-1`: gaming uses passes;
  trading uses confirmed, verified swap volume within the season. `seasonId=all`
  remains available without a pass. Frozen boards retain the top 100; an unlisted
  player receives `outsideSnapshot: true` and null totals rather than invented zeros.

Payout statuses: `pending`, `wallet_required`, `prepared`, `paid`, `failed`.
`failed` is retryable. Public records include the transaction signature, amount,
rank, wallet and timestamps; signed transaction bytes and internal errors stay private.
Only wallet players enter new competition boards. Historical payout obligations
remain stored; this cleanup does not delete or reallocate them.

## Prize approval and payout worker

Ordinary match submissions are provisional. The legacy metadata-only validator
is insufficient to authorize prizes. `GET /admin/match-reviews` lists unreviewed
results; review trusted evidence before calling `POST /admin/match-reviews`:

```json
{ "resultId": "mtc-...", "decision": "accepted", "reason": "Verified against authoritative match evidence." }
```

Use `rejected` for invalid results. Reviews are audited and final; identical retries
are idempotent. Clients cannot mark a result prize eligible. An authoritative replay
validation worker remains future work: current gaming prize approval is manual.
Provisional public standings may differ from approved prize standings.

The competition worker freezes standings and allocates prizes five minutes after
each cycle/season ends. Approvals must precede closure to affect that allocation;
later approval may still count for an open season. Closure is transactional and
retryable. Delivery persists exact signed bytes before broadcasting, reuses the
same transaction on retry, and checks finalized expiry/history before replacing it.
Retries visit successive batches so a failed transfer cannot block all older payouts.
Disabling delivery preserves pending obligations; it does not cancel them.

## Native X / Discord

1. Authenticated `POST /integrations/x/oauth/native/start` or
   `/integrations/discord/oauth/native/start`, body `{}` or `{ "returnUrl": "..." }`.
2. Open `authorizationUrl` in the system browser. Keep `flowId` in the app.
3. Poll authenticated `GET /integrations/oauth/native/status?flowId=...`.
   States: `pending`, `exchanging`, `completed`, `failed`, `expired`.

The browser callback does not require the app's session cookie. State is opaque,
single-use, expires in ten minutes and is bound to the original player/session.
Logging out invalidates linking. Discord still requires guild membership. Existing
OAuth callback URLs and provider configuration are reused. Optional return URLs
must exactly match `BATTLECITY_NATIVE_OAUTH_RETURN_URLS` (comma-separated).

## SOL ↔ SKR swaps

`POST /trading/swap/quote`: `{ "from": "sol", "amount": "0.1", "slippageBps": 50 }`.
Use `"skr"` for the reverse direction. Sign the returned versioned transaction,
preserving all message bytes. `POST /trading/swap/execute` with `quoteToken` and
`signedTransaction` (base64). Only the authenticated wallet's valid signature on
the exact quoted message is accepted. Clients retain control of private keys.
This uses [Jupiter's order/execute API](https://github.com/jup-ag/docs/blob/main/swap/order-and-execute.mdx).

After execution, call the existing `POST /trading/verify-swap` with `signature`
to record confirmed volume. Ranking credit requires an approved swap program,
wallet signature, eligible pair and chain timestamp. The default approved program
is Jupiter Metis v6; configure other router programs explicitly if used. Mock/legacy
records are excluded. SOL volume needs an explicitly configured USD conversion;
there is no live price oracle in this change.

Trading prizes additionally require a stored successful execution from the API's
signed Jupiter quote flow. Arbitrary client-submitted transfers cannot authorize
prizes merely by changing wallet balances. Submit `/trading/verify-swap` after
`/trading/swap/execute` succeeds, so its execution receipt exists before ranking credit.

## Deployment configuration

Run `npm run db:migrate` for migration `030_competitions.sql`, then build/restart.
Production requires PostgreSQL. Do not run migrations against a live database
without the normal deployment review. This implementation does not deploy itself.

- `BATTLECITY_SKR_MINT`, `BATTLECITY_SKR_DECIMALS`: actual mainnet token metadata.
- `BATTLECITY_SKR_TOKEN_PROGRAM`: classic Token Program by default; Token-2022 supported.
- Existing `BATTLECITY_SHOP_QUOTE_SECRET` and mainnet shop treasury/RPC configuration.
- `JUPITER_API_KEY`, `BATTLECITY_SWAP_QUOTE_SECRET` (at least 32 characters).
- `BATTLECITY_SOLANA_RPC_URL`: mainnet RPC for swap verification; defaults to public mainnet.
- `BATTLECITY_SOL_PRICE_USD`: explicit SOL conversion rate; update operationally.
- `BATTLECITY_SWAP_PROGRAM_IDS`: comma-separated approved DEX/router program IDs.
- `BATTLECITY_COMPETITIONS_WORKER_ENABLED=1`: track and close periods.
- `BATTLECITY_LEADERBOARD_REWARDS_ENABLED=1`: enable transfer delivery.
- `BATTLECITY_RANKING_REWARD_RPC_URL`: mainnet RPC for prize transfers.
- `BATTLECITY_RANKING_REWARD_KEYPAIR_PATH`, `BATTLECITY_RANKING_REWARD_AUTHORITY_ADDRESS`:
  matching dedicated reward wallet; fund with SKR and SOL for fees/account rent.
  Restrict the key file to mode 600 on Unix. Never expose this key to the client.

The timer runs in the long-lived `src/index.ts` API process. A serverless route
deployment alone does not run it; operate the API process or a scheduled worker
that calls `competitions.tick()`. Intervals entirely missed during downtime are
history-only and do not accrue new automatic payout obligations.

Use `npm run test:competitions` and `npm run test:api` for isolated tests with
mocked provider/RPC calls. No real transactions are sent. Database integration tests
need an explicitly configured `BATTLECITY_TEST_DATABASE_URL` with migrations applied.
