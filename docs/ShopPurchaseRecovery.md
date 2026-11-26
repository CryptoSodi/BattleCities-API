# Shop purchase recovery

Before opening a wallet for a new purchase, supported game builds call
`POST /api/economy/purchase/track` with the signed quote. The authenticated
player and wallet must match the quote. The API records the attempt in
PostgreSQL before the client may open the wallet. A pending record means a
wallet was about to be opened; it does not prove the player approved or paid.

The API process runs a recovery worker every 30 seconds by default. Workers
lease due rows with `SKIP LOCKED`, verify the exact purchase on Solana using
the existing quote and signature or unique memo, and grant through the existing
idempotent payment store. RPC failures and missing evidence remain pending;
checks use exponential backoff capped at one hour. The worker never opens a
wallet, creates a fresh transaction, or broadcasts a payment. Set
`BATTLECITY_SHOP_RECOVERY_WORKER_ENABLED=0` to disable the worker temporarily.
PostgreSQL is required for durable tracking, including in development.

Older clients can migrate locally saved receipts by sending them to the
existing `/api/economy/purchase/verify` endpoint with `recover: true`; that
request now registers the receipt before checking. The updated Android game
also imports previously deferred and active local receipts when its shop opens.
Receipts on devices that never reconnect cannot be imported automatically.
An older client cannot guarantee a server record before opening a wallet until
it is updated; its subsequent recovery request still imports the receipt.

Administrators can inspect pending attempts through
`GET /api/admin/pending-purchases` and the dashboard. The endpoint requires
the existing admin session and does not return quote tokens or signed bytes.
Pending includes abandoned wallet prompts, and a missing signature or an
expired blockhash by itself is not proof that no payment occurred.

## Rollout

1. Back up the production database, validate migration 037 against a protected
   production copy, then apply it and record its checksum in the deployment
   controller's migration approval map. See `oracle-deployment.md`.
2. Deploy and verify the API and recovery worker before distributing a game
   build that requires the tracking endpoint. The migration is additive; older
   game clients remain compatible with the updated API.
3. Deploy the matching admin dashboard and distribute a separately requested
   game build. Verify admin authorization, pending attempts and a test-network
   purchase with the wallet crash/interruption scenario before production use.

Local verification: the API test suite can use a baseline database via
`BATTLECITY_TEST_DATABASE_URL`. The purchase recovery PostgreSQL integration
checks also accept a separate isolated baseline database in
`BATTLECITY_SHOP_RECOVERY_TEST_DATABASE_URL`. Never point either variable at
production.
