# Public deployment

Use the repository Compose stack for a source checkout behind Traefik.
For published images without Traefik, start with [Local install](/getting-started/local).

## Requirements

Provide a domain, TLS termination, and a running Traefik proxy.
The stack expects the external network `traefik_web` by default.
Set `TRAEFIK_NETWORK` if your proxy uses another network.
Install Bun for the host migration and diagnostic commands.

The web app listens on container port `3000`.
Set `ORIGIN` to the exact public URL. A mismatch causes login POST requests to return `403`.
Worker audio returns `404` if the music mount does not match indexed file paths.

## Install from a checkout

```sh
git clone https://github.com/poesterlin/sole.git
cd sole
cp .env.example .env
chmod 600 .env
${EDITOR:-vi} .env
```

Set these values before starting containers:

- `DOMAIN` and `ORIGIN`, such as `sole.example.com` and `https://sole.example.com`.
- `MUSIC_LIBRARY_PATH`, `MUSIC_HOST`, and `MA_TOKEN` for your existing library.
- Random `POSTGRES_PASSWORD` and `WORKER_TOKEN` values.
- `DATABASE_URL` for host commands.
- `DATABASE_INTERNAL_URL` for containers. Use the `postgres` hostname for the
  optional database service.

Generate each secret with `openssl rand -hex 24`.
Check the database `ports` entry before exposing the stack.
Remove it if host access is unnecessary, or bind it to localhost for host migrations.

```sh
docker compose --profile database up -d postgres
bun install --frozen-lockfile
bun run db:migrate
bun run doctor -- --strict
docker compose config --quiet
docker compose up -d --wait
bun run auth:create-user --username admin
```

Open your public URL and follow [Your first playable vibe](/guides/first-play).
For an external database, omit the PostgreSQL startup command.
Set both database URLs to addresses reachable from their respective callers.

## Other ways

To build images from the checkout, replace the final Compose startup command with:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait
```

For another proxy, remove Traefik labels and route requests to web port `3000`.
Allow worker uploads of at least `512 KB` and pass bearer authorization headers.

## Reference

The [Compose file](https://github.com/poesterlin/sole/blob/main/compose.yaml)
defines routing, health checks, and service profiles.
`GET /api/health` checks HTTP availability. It does not check pipeline readiness.
Use `bun run doctor -- --strict` for database and configuration checks.

Keep the `postgres-data` and `cluster-artifacts` volumes.
The latter stores clustering artifacts used for apply and rollback.
See the [Rust CLI](https://github.com/poesterlin/sole/blob/main/clustering-rs/README.md)
for those commands.

See [Authentication and configuration](/reference/application) for account limits
and service credentials. The default stack runs web and the API worker.
Maintenance runs inside the web process.
