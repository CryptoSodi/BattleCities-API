# MagicBlock devnet experiment

Only `https://magic.battlecities.com` enables MagicBlock. It uses `https://test.battlecities.com` for the API and Solana devnet for VRF. Test and play retain ordinary drops. Native builds do not enable the experiment. Magic Photon rooms use a separate `-magic-v2` app version; the initial experiment uses a browser host as authority, not the standard dedicated-server pool.

The new `powerup-drops` program is separate from the old tank movement experiment. Program ID: `8zNbfcBUVCcNkMs4rEKkPv9UsfEwemEdd2bfMerNwd52`. Source lives in `C:/repos/BattleCities-MagicBlock/programs/powerup-drops`. No ER delegation is needed.

## Server configuration

Configure **only the existing test API service**:

```
BATTLECITY_ENVIRONMENT=devnet
BATTLECITY_SOLANA_NETWORK=devnet
BATTLECITY_MAGICBLOCK_ENABLED=1
BATTLECITY_MAGICBLOCK_SESSION_SECRET=<a random secret of at least 32 characters>
BATTLECITY_MAGICBLOCK_PAYER_FILE=<protected devnet-only Solana keypair JSON path>
```

The payer needs devnet SOL for account rent, VRF fees and transactions. Never place its key in Unity, web assets or source control. Setting ENABLED=0 is the kill switch; requests fail closed. The standard test drop endpoint remains available for test.battlecities.com. Origin is a routing gate, not authentication: these endpoints additionally require an authenticated player, HMAC-bound session and rate limits.

## Drop flow

POST `/api/magicblock/session` with width/height creates a signed, one-hour session locked to player, map dimensions and Magic mode. POST `/api/magicblock/drop` with token/index requests or polls that exact onchain drop. Index starts at 0; the program requires sequential indexes, caps matches at 64 drops and enforces two seconds between requests. Duplicate requests resolve the same PDA, including across API restarts. The game queues drops while combat continues, then fails closed after the bounded retry window. It discards late outcomes after a simulation changes or ends.

Equal probabilities apply to defence, freeze, life, shield, speed, upgrade, zoomout and wipeout. Coordinates select the map's 32-unit grid inside the boundary; no obstacle filtering is applied. Type/x/y use separate words from the VRF result. Onchain callbacks authenticate the SDK's scoped VRF identity. The API verifies the account owner, discriminator, session, index, dimensions and result mapping before returning a drop. VRF validates selection, not host combat or pickup honesty.

Replays store `magicpickup` events containing type, x, y and the drop account. Playback is offline and consumes no simulation PRNG values. Experimental replay sessions are excluded from ordinary reward candidacy.

## Publishing

1. Build and deploy `powerup-drops` to Solana devnet using its ignored program key under `keys/powerup-drops-devnet.json`.
2. Deploy the updated API to the test service, configure its payer and secret, and verify a real VRF callback before enabling public play.
3. Point magic.battlecities.com DNS to the existing test host. Install `install-magic-site.py` and copy `deploy-magic-web.py` as `/opt/battlecities-magic/deploy-web.py`.
4. Run `Build-Magic-Web.bat` or `Tools/Publishing/Deploy-MagicWeb.ps1`. Use `-BuildOnly` to prepare without uploading.

No production deployment is required. Do not reuse an old WebGL player; its hostname selector will point Magic at production. Roll back the static Magic symlink and disable the test API flag if needed.

## Verified deployment — 2026-10-13

The program is deployed to devnet and the test API is enabled. A real API request produced `life|768|544` in account `DpqKG5RfsWqTFgDnwhr28qdRVPHKXQheNBoU9A1ykFqu`; retry returned the same account/result. Requests from test, play and a lookalike origin returned 403. Standard test drops returned 200; ordinary random drops from Magic returned 409. The separate API sponsor is `AnPdjgpVEHVS9SAfCq92xqgGJ5tobkA4ct4nZz8oQfvr` (funded with 0.5 devnet SOL).

Guest play prepares API authentication at login, accepting either a new guest session or an existing authenticated cookie. It does not replace an existing authenticated cookie. Wallet sign-in already establishes API authentication. Match loading creates the map-bound MagicBlock session and holds gameplay at tick zero until setup succeeds; failures remain on the existing loading screen. The first drop only requests VRF and never creates a session or logs in. Long lobby waits refresh the session before combat, never during combat. Following multiplayer host recovery, Magic drops stop for that round rather than creating a new random sequence; start a new round to resume. Neither feature changes normal test/play behavior.

Validation: Unity origin/replay checks passed; WebGL built with zero errors; API tests passed (118 passed, 8 database-dependent skipped); deployable SBF build passed; real devnet callback and duplicate request checks passed. End-to-end combat with multiple browser players has not been manually tested.

The original 13 October release was built from local uncommitted integration changes. Its sourceCommit is the base commit, not a commit containing these changes; sourceDirty records this distinction. The API artifact sha256 is `a12c2b8c97ac8e9262ce0da09a312671d6485ac57b66ef67fc51e9c1437c2a60`.

## Pre-match setup — 2026-10-14

Authentication now completes at guest login. Match loading prepares the map-bound session before simulation ticks or multiplayer start. The first drop only requests its VRF outcome. Setup errors keep the existing loading screen visible, with a return-to-menu action. A near-expiry session refreshes only before combat after a long lobby wait. Magic rooms use `-magic-v2` so older clients do not join the revised startup flow.

Unity regression checks passed for existing/new authentication, failed authentication, startup readiness, first-drop request isolation, failed setup, stale match responses and host-recovery behavior. Replay checks passed. API tests: 118 passed, 8 database-dependent skipped. The power-up program compiled with the merged lockfile. Full multi-browser combat testing remains outstanding.
