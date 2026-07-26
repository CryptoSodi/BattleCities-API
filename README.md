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

Do not add new HTTP behavior to the root route copies. New API work belongs in
`api-server/src/routes`, with supporting code in `config`, `middleware`,
`stores`, or `services` according to responsibility.
