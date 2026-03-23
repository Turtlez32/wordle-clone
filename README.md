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
SESSION_SECRET=replace-this-with-a-long-random-string
```

For production, set `APP_ORIGIN=https://wordle.turtleware.au`.

## Daily Lock

The daily lock is now enforced server-side in the local SQLite database and keyed by the authenticated user's subject claim.
