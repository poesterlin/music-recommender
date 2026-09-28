# Public deployment

This path uses the repository's `compose.yaml`, the published images, and an existing Traefik network. Run the commands from the repository root.

## 1. Write the configuration

```sh
cp .env.example .env
```

Then edit `.env`. The settings that matter on this path:

| Setting | What it is |
|---|---|
| `DOMAIN` | The hostname Traefik routes to this app. It also defaults `ORIGIN` for you. |
| `MUSIC_LIBRARY_PATH` | The folder on this host holding your music. It is mounted read-only into the app. |
| `MUSIC_HOST` / `MA_TOKEN` | Your Music Assistant server: the base URL, and an access token from its settings. |
| `DATABASE_URL` | A PostgreSQL URL with pgvector, used by commands you run on this host. |
| `DATABASE_INTERNAL_URL` | The same database as the containers see it, usually a Compose service name. Leave it unset if the host URL already works from inside the network. |
| `WORKER_TOKEN` | A shared secret for anything that talks to the worker API or triggers the timed jobs. The two job endpoints accept only this value; the worker API also accepts a scoped Worker key from the UI. Generate a long random string. |

## 2. Make sure the database is running

If you want the Compose-managed database rather than your own, it lives behind a profile so it does not start by accident:

```sh
docker network create "${TRAEFIK_NETWORK:-traefik_web}" 2>/dev/null || true
docker compose --profile database up -d postgres
```

Traefik must already exist as a Docker network; the first line creates it only if it is missing.

## 3. Prepare the host tools, then the schema

```sh
bun install --frozen-lockfile
```

That installs the packages the next commands use on the host. Then:

```sh
bun run db:migrate
```

which enables the pgvector extension and applies everything in `drizzle/`. A brand-new database has no centered embedding space until at least two tracks are analysed — that happens later, in the app.

## 4. Check before you expose it

```sh
bun run doctor -- --strict
```

It reads your `.env`, connects to the database, and reports anything missing without changing a thing. Fix what it flags rather than starting a stack that will fail quietly later.

## 5. Start it

```sh
docker compose up -d
```

This brings up the app, the Music Assistant sync, the analyzer, and a local embedding loop. The analyzer and sync run on their own timers, so a new library fills in without you babysitting it.

Open your domain, register an account, and follow **Setup**. The centering and clustering steps that follow are covered in [First playable vibe](/guides/first-play).

::: warning The database port is published
`${POSTGRES_PORT:-5432}` is mapped on every interface, so anyone who can reach this host can attempt to reach PostgreSQL. Set a real `POSTGRES_PASSWORD`, or drop the `ports:` entry from the `postgres` service in `compose.yaml` — nothing else needs it, and containers still reach the database by service name.
:::
