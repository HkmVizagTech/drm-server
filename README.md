# DRM — HKM Vizag Donor Relationship Manager

One repository, one deployable service: an Express + PostgreSQL API and a
Next.js admin UI, served by a single Node process on a single port.

```
drm/
├── client/     Next.js 16 admin UI (App Router, Tailwind v4)
├── server/     Express 5 + TypeScript API, and the process that serves both
├── package.json    npm workspaces, build and start scripts
└── .npmrc          forces devDependencies to install (see "Deploying")
```

## How the two halves fit together

In production the server process does both jobs. Requests to `/api/*` and
`/health` are answered by Express; everything else is handed to Next.js. That
means one origin, so the browser calls `/api/...` relatively and there is no
CORS to configure and no API host baked into the client at build time.

In development they run separately, because `next dev` needs its own port for
hot reload:

```bash
npm install          # once, at the repo root
npm run dev          # API on :4000, UI on :3000
```

`npm run dev` starts both. To run just one: `npm run dev:api` / `npm run dev:web`.

## Building and running as one service

```bash
npm run build        # builds the client, then compiles the server
npm start            # node server/dist/index.js — serves API and UI on $PORT
```

The server decides whether to serve the UI from `SERVE_CLIENT`, which defaults
to on when `NODE_ENV=production` and off otherwise.

## Deploying (Railway)

One service, built from the repository root:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Start command | `npm start` |
| Root directory | *(leave default — the repo root)* |

Variables: `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`, plus the
`HKMV_*` and `ANNADAN_*` pairs listed in `.env.example`. Do **not** set
`NEXT_PUBLIC_API_URL` — leaving it unset is what makes the client use the same
origin.

### Why there is an `.npmrc`

Railway sets `NODE_ENV=production`, and npm then skips `devDependencies`. The
client build needs several of them (`typescript`, `tailwindcss`,
`@tailwindcss/postcss`), so `next build` fails with a postcss error that does
not mention the real cause. The committed `.npmrc` sets `include=dev`, which
fixes it for every host rather than relying on a variable someone has to
remember to set. Deleting that file will break the deploy.

## Database

```bash
npm run db:schema    # applies server/src/db/schema.sql; safe to re-run
```

Set `DATABASE_URL` to the target database first. The schema is idempotent
throughout (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Donation page attribution

Which page produced a donation is classified in one place,
`server/src/utils/pageGroups.ts`, into three buckets: the `/donations` family
(prefix-matched, so new nested festival pages are picked up automatically), the
`/donate` seva campaign pages (an explicit list), and everything else. The
"Donation pages" screen shows the full breakdown and warns if the buckets ever
stop adding up to the site total. Read that file before changing how a page is
counted.
