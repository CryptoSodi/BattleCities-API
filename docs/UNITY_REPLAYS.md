# Unity input replay API contract

The backend implements authenticated Unity recording sessions, uploads, owner libraries/status, and public profile WATCH. The 115-test suite includes PostgreSQL ownership and concurrent retry checks. Production rollout requires migration 032 before deploying this API version; GitHub Actions and the Oracle controller validate each release before activation.

## Existing behavior and verification boundary

The legacy `/api/replays` route stores browser recordings. Its metadata consistency check previously marked data `verified`; this local change keeps new consistent legacy uploads `pending` instead. Existing rows are preserved. Unity uploads remain `pending`; simulation reproduction is reported separately. An upload, a client hash, or two matching client reports must never grant points, prizes, inventory or `accepted` status.

Authentication uses the existing `battlecity_session` cookie for guest and wallet accounts. Player identity comes from that authenticated session. Recording sessions, uploads, owner library/status and admin routes do not accept a caller-provided player ID or the legacy replay guest cookie as ownership. Profile WATCH is a public read exception: other players and anonymous guests may retrieve playback for a saved recording attached to a public match-history row.

## Recommended routes

| Route | Purpose |
| --- | --- |
| `POST /api/replay-sessions` | Issue an authenticated recording session before simulation starts (`single`, `coop`, or `versus`). |
| `GET /api/replay-sessions?id=urs-...` | Resume/read an owned session and its upload/verification state. |
| `POST /api/replays/unity` | Submit the complete input recording once, idempotently by server session ID. |
| `GET /api/replays/unity?id=urp-...` | Retrieve an owned recording. |
| `GET /api/replays/unity?limit=20` | List own recent summaries (default 20, maximum 50, no payloads). |
| `GET /api/replays/unity/status?id=urp-...` | Retrieve an owned verification summary without the large input payload. |
| `GET /api/admin/replays/unity?id=urp-...` | Admin-authenticated evidence retrieval. |
| `GET /api/players/<playerId>/profile/matches/<matchId>/replay` | Public WATCH for a saved recording attached to that player's visible match-history row; no login required. |

### Start session

```json
{
  "simulationVersion": "unity-sim-v1",
  "buildVersion": "0.1.10",
  "levelNumber": 1,
  "levelHash": "64 lowercase SHA256 hex characters",
  "configHash": "64 lowercase SHA256 hex characters",
  "tickRate": 60,
  "mode": "single"
}
```

Response `201`:

```json
{
  "ok": true,
  "session": {
    "id": "urs-<cryptographically random ID>",
    "seed": 123456789,
    "simulationVersion": "unity-sim-v1",
    "buildVersion": "0.1.10",
    "levelNumber": 1,
    "levelHash": "...",
    "configHash": "...",
    "mode": "single",
    "tickRate": 60,
    "issuedAt": "2026-10-07T06:00:00.000Z",
    "expiresAt": "2026-10-08T06:00:00.000Z",
    "status": "active",
    "verificationStatus": "pending"
  },
  "limits": {
    "maxBytes": 2097152,
    "maxTicks": 108000,
    "maxCheckpoints": 1801
  }
}
```

The server chooses the nonzero uint32 seed and issuance/expiry times (24-hour upload window). Unity must start with the returned parameters; mismatched seed, version, level/hash, config hash, mode or tick rate is rejected at upload. Supported simulation version is currently `unity-sim-v1`. Version/content hashes bind the recording to a session, but do not establish that submitted content is approved or scores are true. A trusted simulator still needs approved build/content. Duration cannot exceed elapsed server session time plus 15 seconds of tolerance. Device `createdAt` is informational; server timestamps govern ownership/expiry.

### Submit recording

Concrete envelope:

```json
{
  "sessionId": "urs-...",
  "replay": {
    "format": "battlecities-unity-input-v1",
    "simulationVersion": "unity-sim-v1",
    "buildVersion": "0.1.10",
    "id": "0123456789abcdef0123456789abcdef",
    "createdAt": "2026-10-07T06:00:00.000Z",
    "seed": 123456789,
    "levelNumber": 1,
    "levelHash": "...",
    "configHash": "...",
    "mode": "single",
    "map": { "field": { "widthTiles": 13, "heightTiles": 13 }, "terrain": { "regions": [] }, "objects": [], "spawn": null, "base": null },
    "config": { "normalReload": 0.12, "upgradedReload": 0.08, "playerTier": 0, "turretRange": 640, "turretDamage": 4, "turretCooldown": 0.1, "turretReload": 0.5, "turretTurn": 0.2, "turretMuzzle": 32, "turretHealth": 10, "turretDeploy": 0.5, "landDrone": {} },
    "tickRate": 60,
    "durationTicks": 1200,
    "inputs": [{ "tick": 1, "count": 1200, "commands": [0, 0, 0, 0], "secondaries": [0, 0, 0, 0], "enemyFire": true }],
    "events": [],
    "checkpoints": [{ "tick": 0, "stateHash": "..." }, { "tick": 60, "stateHash": "..." }, { "tick": 120, "stateHash": "..." }, { "tick": 1200, "stateHash": "..." }],
    "claimedResult": { "score": 1000, "lives": 0, "remaining": 10, "won": false, "lost": true, "winnerSlot": -1 },
    "completion": "completed",
    "debugUsed": false
  }
}
```

Response `201` for first upload, `200` for an identical retry:

```json
{
  "ok": true,
  "item": {
    "id": "urp-...",
    "sessionId": "urs-...",
    "payloadHash": "server-calculated SHA256",
    "validationStatus": "pending",
    "verificationStatus": "pending",
    "verification": { "method": "none", "reproducibilityStatus": "pending", "checkedAt": null, "reason": null },
    "competitiveApproval": "review_required",
    "rewardCandidate": true,
    "claimedResult": { "score": 1000, "lives": 0, "remaining": 10, "won": false, "lost": true, "winnerSlot": -1 }
  }
}
```

After submission the session is immutable. Changed payload for the same session returns `409`; no duplicate replay or match result is created. Session ownership, expiration, byte/array/numeric bounds, strictly ordered ticks and allowed input bits are enforced. A cryptographic payload hash identifies stored evidence; it does not certify gameplay.

Inputs are RLE intervals starting at tick 1, contiguous and covering every tick through `durationTicks` (1–108000). Four command/secondary slots are required. Movement bits 0–2 and aim bits 3–5 each encode 0–4; Fire/PowerShot/SecondaryFire are bits 6/7/8. No other bits are accepted. Secondaries range 0–4. Single mode allows commands only in slot 0; ignored secondary slots may repeat the selected weapon as the recorder currently does.

Events are ordered by nondecreasing tick, applied before that tick: `{tick,kind,value,slot,connected}`. Kinds: `pickup`, `powerup`, `participant`, `begin`. Power-up names: `shield`, `upgrade`, `speed`, `life`, `freeze`, `wipeout`, `zoomout`, `defence`; pickup additionally accepts `batc100`, `batc200`, or null for a deterministic random choice. `participant`/`begin` require null value. Slot is 0–3, connected is boolean; single mode allows only pickup/powerup in slot 0. Maximum 4096 events. Events are untrusted until server receipts/authority are independently established.

Checkpoints are required at 0, every 60 ticks strictly before the terminal tick, and the terminal tick (no duplicates); the abbreviated sample above omits intermediate entries for readability. Hashes are lowercase SHA256 hex. Completion is `completed`, `aborted`, or `truncated`; `debugUsed` is boolean. Only completed single recordings with a terminal won/lost result and debug disabled can be match candidates. Multiplayer, aborted, truncated, and debug evidence can be stored/playable but cannot enter the single-player match board through this API.

Transport is bounded at 8 MiB before buffering, the replay payload at 2 MiB (plus 16 KiB allowed for the upload envelope), session creation at 16 KiB. Map/config numeric/depth/array/terrain complexity bounds are enforced. Disabled enemy fire in any input frame also marks a recording as debug evidence even if its caller reports `debugUsed:false`. No caller-provided approval/status fields are accepted. Owner GET includes `item.replay`; owner status GET omits it and requires an ID. Direct native recording access remains private to its owner/admin. Public profile WATCH returns playback data for attached visible matches; existing public legacy browser playback remains compatible.

## Match integration

Keep `/api/matches/submit` compatible for legacy clients. A Unity submission includes the returned `replayId`; the server checks that the replay exists, belongs to the authenticated player, and was issued for that player. Claims must agree with the stored recording, and the same recording can attach to only one match. The result starts `pending`; the existing prize approval gates remain in force. No public client route can change verification status to accepted/verified.

Exact request after a completed, debug-free single recording uploads successfully:

```json
{ "mode": "single", "levelNumber": 1, "score": 1000, "won": false, "replayId": "urp-<ID returned in upload item>" }
```

Take level/score/won from the uploaded replay; do not send gamePoints. Response `200`: `{ok:true,result:{id:"mtc-...",replayId:"urp-...",validationStatus:"pending",...}}`. An identical retry returns that same match ID.

## Public profile WATCH

`GET /api/players/<playerId>/profile/matches/<matchId>/replay` is public, including anonymous guests and other signed-in players. A pending or accepted single-player match may be watched when it has a saved, non-rejected replay belonging to that same player. Missing/wrong-player match IDs, rejected matches or recordings, missing payloads and recordings without a public match attachment return `404`.

Successful Unity response (`200`):

```json
{ "item": { "replay": "<complete Unity input recording object>", "replays": ["<the same recording object>"] } }
```

The placeholders above are objects in the actual JSON, not strings. `item.replay` is the direct Unity payload; `item.replays` retains the compatible array for older WATCH clients. Only playback fields are returned: format/version, map/config, seed, input frames/events/checkpoints and claimed result. No server session ID, owner library record, upload metadata, payloadHash, validation/verification record, or competitive approval fields are exposed. The recording's own client ID and client creation time remain part of the playback payload. Legacy browser responses retain `item.replays` without a singular Unity field.

Public profile `item.recentMatches` rows contain both `hasReplay` and `replayAvailable` with the same boolean value. They are true only when a saved non-rejected replay belonging to the row's player exists; `replayId` is then its recording ID. Otherwise both flags are false and `replayId` is null. Use the row's match `id`, not `replayId`, in the WATCH URL. These flags do not imply fair-play verification or prize approval.

`GET /api/replays/unity`, `GET /api/replays/unity?id=...`, `GET /api/replays/unity/status?id=...`, session reads and all writes retain authentication and ownership checks. Anonymous requests to those private routes receive `401`; other players' direct session/recording reads receive `404`, even when the attached match is publicly watchable. Unattached recordings remain private. Admin evidence still requires admin access.

## Trusted verification

Backend exposes honest status and internal `unityReplayStore.recordReproduction(replayId, evidence)` for the matching Unity/headless verifier. This function is not an HTTP route. Evidence must include `payloadHash`, `simulationVersion`, `status` (`matched`, `diverged`, `unsupported`, `error`), optional bounded `reason`, and a complete `result` matching `claimedResult` for `matched`.

`matched` updates `verification.reproducibilityStatus` but keeps overall `verificationStatus`/`validationStatus` pending and competitive approval `review_required`. Client-owned map/config/events can reproduce cheating, so this never approves prizes. `diverged` rejects the recording and any still-pending attached match. Final audited match decisions are not silently overwritten. Unsupported/error results remain pending. Matched/diverged reproduction decisions are immutable. No arbitrary client URL is fetched or client executable run; deployment of the matching trusted verifier is separate.

## Rollout

Migration `032_unity_input_replays.sql` adds server sessions and enforces one Unity replay per match. Payloads remain in the existing replay table so admin evidence retrieval works. Legacy rows and users are preserved. Startup readiness now requires migration 032. Apply this additive migration separately after validating it on a protected production database copy. Retain a production backup and record its LF-normalized SHA256 in the root-owned migration approval map. The deployment controller checks the exact migration ledger and checksums, then runs tests against an isolated database copy before switching the live service.

The optional operator verifier is `node scripts/verify-unity-replay.mjs urp-<ID>`. Set `BATTLECITY_UNITY_REPLAY_VERIFIER` to an absolute trusted `ReplayVerifier.dll` path built from the Unity project's `Tools/ReplayVerifier/ReplayVerifier.csproj`, alongside its .NET runtime files. Set `BATTLECITY_DOTNET_BINARY` when `dotnet` is not on PATH. The server supplies only a generated private temporary JSON path to the configured executable. Execution has a 30-second timeout and 64 KiB output cap; no caller selects an executable or path. CLI exit codes: 0 matched, 1 another recorded outcome, 2 configuration/execution failure. This is an operator command, not an automatic verification worker. Deploying the replay APIs does not configure or start the trusted verifier.

Verified locally:

- Existing isolated test baseline at migration 031, followed by successful additive migration 032.
- Owner/admin access, public profile WATCH by other players and anonymous guests, private library/session/status boundaries, expired sessions, content/seed binding, upload limits and immutable retries.
- Public history flags agree with playback availability for saved, missing, wrong-owner and rejected recordings in local/file storage and PostgreSQL.
- Five concurrent PostgreSQL uploads create one replay; five concurrent match submissions create one match. The database also rejects a second direct result for the same Unity replay.
- The real C# fixture ingests, links to history, survives PostgreSQL JSONB storage, and reproduces through the shared .NET verifier. It stays pending for separate fair-play review.
- Divergence rejects evidence and its pending match without granting rewards. The full existing API suite passes.

Evidence is in `ReplayApiWork/Postgres/tests.log` and `migrations.log` in the shared workspace. The temporary PostgreSQL cluster and password are removed after testing. Approved production content/configuration and authoritative powerup/event receipt checks remain separate requirements before automatic competitive approval. Reproducing caller-supplied content alone is not proof that gameplay was legitimate.
