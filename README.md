# Neon Wordle

A colorful Wordle-inspired game built with Bun, Vite, React, and TypeScript.

## Run

```bash
cp .env.example .env
bun install
bun run dev
```

## Build

```bash
bun run build
```

## Preview

Build the client, then run the Bun server so the auth and daily-lock API routes are available:

```bash
bun run build
bun run preview
```

## Docker

The container builds the Vite client and runs the Bun server that serves `dist` plus the `/api` routes.

Build a local image:

```bash
docker build -t neon-wordle:local .
```

Build and push a multi-arch image for swarm:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/neon-wordle:latest \
  --push .
```

Run it with your production environment:

```bash
docker run --rm -p 3001:3001 --env-file .env your-registry/neon-wordle:latest
```

For production or swarm, set `APP_ORIGIN` to the public URL for the deployed service, for example `https://wordle.turtleware.au`.

## Authentik OIDC Setup

The app now expects OIDC settings in the Bun server environment and blocks gameplay until the user signs in.

1. In authentik, go to `Applications > Applications` and choose `Create with provider`.
2. Create an application for Wordle and pick a slug such as `wordle`.
3. Choose `OAuth2/OIDC` as the provider type.
4. Set the client type to `Public`.
5. Add strict redirect URIs for:
   `http://localhost:5173/api/auth/callback`
   `https://wordle.turtleware.au/api/auth/callback`
6. Add post-logout redirect URIs for:
   `http://localhost:5173/`
   `https://wordle.turtleware.au/`
7. Keep scopes at least `openid profile email`.
8. Save the provider and application, then note the `Client ID` and the application slug.
9. In this repo, create `.env` from `.env.example` and fill in:

```bash
PORT=3001
APP_ORIGIN=http://localhost:5173
OIDC_ISSUER=https://auth.turtleware.au/application/o/wordle/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=
REDIS_URL=redis://:your-redis-password@redis.turtleware.au:6379
SESSION_SECRET=replace-this-with-a-long-random-string
SESSION_TTL_HOURS=24
```

For production, set `APP_ORIGIN=https://wordle.turtleware.au`.

## Daily Lock

The daily lock is now enforced server-side in Redis and keyed by the authenticated user's subject claim.

## Redis Keys

The Bun server is the only component that talks to Redis.

- `session:<sessionId>` stores the authenticated session payload and expiry.
- `user:<userId>:daily:<dayIndex>` stores that day's completion record with the date, word, solved flag, and completion time.
- `<userId>:stats` stores per-user aggregate stats such as:

```json
{
  "user": "user-id",
  "streak": 4,
  "totalSolved": 12,
  "updatedAt": "2026-03-23T09:15:00.000Z",
  "lastSolvedDate": "2026-03-23",
  "lastSolvedWord": "LIGHT",
  "solvedWords": [
    {
      "date": "2026-03-23",
      "word": "LIGHT"
    }
  ]
}
```
