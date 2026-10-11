# Native Unity Android notifications

The existing notification API sends FCM HTTP v1 messages for the native Unity
Android app. It uses the existing push device table and wallet-admin endpoints.
Firebase Authentication and Capacitor are not involved in player login.

## Deployment configuration

- Firebase project: `battle-cities-84acd` (project number `295482350041`).
- Android package: `sol.battle.cities`.
- Firebase Android app: `1:295482350041:android:f745e7401010eea5fce1c8` (Battle Cities Android).
- The native client creates channel `battle-cities-notifications`.
- Enable the Firebase Cloud Messaging API for this Firebase project and grant the
  sending service account permission to send FCM messages (Firebase Cloud
  Messaging API Admin role).
- Set **one** server secret: `FIREBASE_SERVICE_ACCOUNT_JSON` with the full service
  account JSON, or `FIREBASE_SERVICE_ACCOUNT_BASE64` with that JSON encoded as
  base64. Base64 takes precedence when both are set.
- Credentials must contain this exact project ID, `client_email`, and an RSA
  `private_key`. Credentials from another project are rejected.
- Apply the existing database migrations through `031_guest_wallet_auth` using
  `npm run db:migrate`. Migrations 025/027 already provide the device table and
  nullable ownership; this notification update needs no new schema migration.
- Build/restart the API (`npm run build`, `npm start`), then check
  `GET /api/admin/notifications` using an allowlisted wallet-admin session.
  `{ "configured": true, "enabledDevices": ... }` confirms local credential
  validation and device count; it does not prove Firebase IAM or device delivery.
- The same status response reports `androidPackage` and `firebaseProjectId` so
  the admin dashboard can display the deployed notification target.

Keep credentials in the hosting platform's secret environment configuration.
Never put private keys in Git, logs, Android assets, or `google-services.json`.
That Unity file contains only public Firebase client configuration. Server OAuth
tokens are minted with the Firebase messaging scope and cached until near expiry.
A rejected OAuth token is refreshed once; other send failures are reported without
exposing provider response bodies or device tokens in errors.

## Device registration

`POST /api/notifications/devices`:

```json
{ "token": "<FCM registration token>", "platform": "android", "permission": "granted" }
```

Returns HTTP 201 and `{ "ok": true }`. Send `permission: "denied"` on opt-out.
Tokens are bounded to 20–2048 ASCII characters; whitespace is rejected.
Ownership is resolved from the HTTP-only `battlecity_session` cookie, for either
a guest or wallet session. A supplied `playerId` is ignored. After logout, register
the same token without the session cookie to clear the previous owner association.
An anonymous device with permission granted can receive public announcements but
cannot receive notifications addressed to its previous player.

Repeated registration updates one token record. Rotated tokens are registered as
new records; several devices may belong to one player. Old tokens are removed when
FCM identifies them as unregistered or explicitly invalid. Generic payload,
configuration, quota, network and sender-mismatch errors do not delete devices.
Cleanup checks the registration timestamp so it cannot remove a concurrently
refreshed registration. Only granted Android devices are selected, and permission
and targeted ownership are rechecked immediately before each send. The native
client also suppresses rendering after local opt-out.

## Admin sending and targeted testing

All admin endpoints require the existing allowlisted wallet session.
`POST /api/admin/notifications` accepts `audience: "all"`, `"player"` or `"device"`.
For a player, include `playerId`; for a device, include its registered `token`.
Optional `playerId` with a device target additionally checks ownership. Tokens are
never sent to FCM unless they are already registered and granted.

```json
{
  "audience": "player",
  "playerId": "ply-...",
  "title": "Battle Cities",
  "message": "A new event is available.",
  "route": "home",
  "type": "event",
  "imageUrl": "https://example.com/event.png",
  "actionLabel": "Open"
}
```

`body` is also accepted for message text; `message` preserves the existing admin
dashboard contract. Title/message/action label limits are 80/240/32 characters.
URLs must be HTTPS, contain no credentials and be at most 2048 characters.
Total encoded data is limited to 4096 UTF-8 bytes. Invalid input returns 400;
missing or invalid Firebase credentials return 503.

`POST /api/admin/notifications/test` with `{ "playerId": "ply-..." }` sends a fixed
connection-test message to that player's enabled devices. With
`{ "token": "<registered token>" }`, it targets exactly that enabled device.
An optional `playerId` checks its owner. The test endpoint cannot broadcast; a
request with no explicit player/device target fails with 400.

Delivery uses batches of at most 25. Responses contain `ok`, `sent`, `failed`,
`removed`, `skipped`, and `devices`. `sent` means FCM accepted the message, not that
the device displayed it. Empty audiences return 404. No accepted sends with
provider failures return 502; an audience that opted out before sending returns
409. Partial success returns 200 with failure counts. There is no durable retry
queue; an explicit resend may duplicate messages already accepted by FCM.

## Data-only message contract

The sender provides only string-valued `message.data`: `title`, `body`, `route`,
`type`, and optional `imageUrl`, `externalUrl`, `actionLabel`. Android configuration
sets high priority and restricts the token to the native package. Neither the
top-level message nor Android configuration contains a `notification` object;
the native Unity service creates the notification in its own channel.

| Route | Action after the player taps |
| --- | --- |
| `home` or unknown | Play tab |
| `play` | Tank selection / battle preparation |
| `shop` | Shop |
| `rewards` | Quarters |
| `social` | Socials |
| `external` | Required HTTPS `externalUrl` |
| `share` | Android share chooser |

Types are `announcement`, `reward`, `event`, `social`, `share`; the default is
`announcement`. Unknown routes become `home`. A notification never starts a paid
battle or signs in, claims rewards, or buys an item automatically.

## Verification and remaining deployment checks

`npm test` runs isolated ownership, permission, targeting, FCM payload,
authentication and invalid-token checks with generated test credentials, mocked
provider calls and temporary local storage. No production messages are sent by
these tests. The optional PostgreSQL check needs `BATTLECITY_TEST_DATABASE_URL`.

No automatic notification triggers exist outside the current admin sender.
Future reward/event triggers should reuse this sender and device selection rules.
Real FCM delivery still needs deployed server credentials and a device running an
APK with the native Unity notification integration. Verify foreground/background
display, cold/warm taps, opt-out, account switching/logout and token rotation with
an explicitly targeted test device before using a production broadcast.

References: [FCM HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api),
[message schema](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages),
[FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes).
