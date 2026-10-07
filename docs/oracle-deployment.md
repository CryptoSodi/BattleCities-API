# Automatic Oracle deployment

Pushes to `main` in `CryptoSodi/BattleCities-API` automatically deploy to **https://api.battlecities.com** after verification. Pull requests run verification without production access. The workflow can also be run manually against `main` from GitHub Actions.

Monitor runs at https://github.com/CryptoSodi/BattleCities-API/actions/workflows/oracle-deploy.yml.

## Deployment sequence

1. GitHub Actions installs locked dependencies, initializes an isolated PostgreSQL 16 CI database from a schema-only baseline, applies later migrations, builds the API, runs the complete test suite including PostgreSQL integration, and runs the HTTP smoke test.
2. Only the latest `main` commit proceeds to deployment. Deployments are serialized and active runs are allowed to finish.
3. GitHub exports a Git archive of that exact commit and uploads it through a dedicated, restricted SSH connection. The server verifies the archive checksum and commit metadata. Archive paths cannot escape the release directory; symlinks, hard links and special files are rejected.
4. Oracle builds the release using an unprivileged build account. Builds do not receive production credentials.
5. Oracle creates a protected database backup, restores it to an isolated validation database with a temporary PostgreSQL role, runs all tests against that copy, and starts a loopback staging server. Financial workers are disabled and production third-party credentials are absent during validation. Existing validation records must remain unchanged.
6. Oracle takes another database backup immediately before the switch, atomically changes the release pointer, and restarts `battlecities-api.service`.
7. Local and public HTTPS health/readiness checks must pass. If they fail, the previous release is restored and restarted. The original production database and configuration remain in place.
8. Temporary validation databases and roles are removed. Protected backups, validation logs, previous releases, and a manual rollback script are retained on Oracle.

The application is stopped only for the final service restart; building, restoring and testing happen while the existing API serves traffic.

## Database migration gate

Automatic deployment **does not modify the production schema**. Every migration recorded in production must still exist unchanged in the incoming release. A pending, removed, or rewritten migration fails deployment before the running API is changed.

Schema changes require a separately reviewed database rollout, with a backup and validation against a database copy. After that migration is applied safely, an administrator records its SQL SHA-256 after normalizing line endings to LF under its migration version in the root-owned `/etc/battlecities/api-migration-approvals.json`, then reruns the workflow. The deployment key cannot modify this approval file. This gate also prevents a code rollback from automatically overwriting newer player data with an older database snapshot.

## Server layout

| Purpose | Location |
| --- | --- |
| Current release | `/opt/battlecities-api/current` |
| Releases | `/opt/battlecities-api/releases/<commit>-<timestamp>` |
| Production environment | `/etc/battlecities/api.env` |
| Production database | PostgreSQL `battlecities` |
| Deployment controller | `/usr/local/sbin/battlecities-api-deploy` |
| Root-owned controller modules | `/usr/local/lib/battlecities-api-deploy/` |
| Deployment backups and private logs | `/var/backups/battlecities/auto-<timestamp>-<commit-prefix>/` |
| Latest successful deployment | `/opt/battlecities-api/last-deployment.json` |

Deployment uses `battlecities-api-deploy`; its key accepts only `deploy <commit> <checksum>` or `status`. It cannot open a shell, forward ports, or use the existing Oracle administrator SSH key. Builds and staging use `battlecities-api-build`. The running API still uses `battlecities`.

GitHub repository configuration:

- Secret `ORACLE_API_DEPLOY_KEY`: dedicated private key.
- Secret `ORACLE_API_SSH_KNOWN_HOSTS`: server host key obtained through the established administrator connection.
- Variable `ORACLE_API_HOST`: Oracle host address.
- Variable `ORACLE_API_USER`: `battlecities-api-deploy`.

Production database passwords, Firebase credentials and payment keys remain on Oracle. Do not commit them or copy them into workflow logs.

## Rollback and diagnosis

To restore the preceding application release, find the relevant protected deployment directory and run on Oracle:

```sh
sudo node /var/backups/battlecities/auto-<timestamp>-<commit-prefix>/rollback.mjs
```

The rollback changes the application release and restarts the API. It does not restore an older database over current player records.

GitHub reports the failed phase and backup directory. Detailed validation output is available to administrators in that directory's `validation.log`. Normal service logs are available with `journalctl -u battlecities-api.service`.

Backups and old releases are retained; the deployment controller refuses a deployment when there is insufficient free space. Their retention can be managed separately after verifying which release and backups are still needed.

## Updating the server controller

The root-owned controller is installed separately from application releases. Changing `scripts/oracle/` in Git does not automatically replace that privileged server code. An administrator must review and install controller changes through the existing Oracle administrator connection. This prevents an uploaded release from changing its own privileged deployment checks.

The initial installation uses `scripts/oracle/install.mjs`, the accompanying controller modules, and a dedicated public key placed in `/tmp/battlecities-api-ci-install/`. The private key belongs only in the GitHub repository secret. The existing service and production configuration are retained by the installer.
