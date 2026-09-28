# Public deployment

Getting a container behind TLS and pointing DNS at it is your business. What follows is only what will bite you with this app.

## Served over HTTPS, or logins do not stick

In production the session cookie is named `__Host-music-auth-session`. Browsers only accept a `__Host-` cookie that is `Secure`, so the app must see the request as `https` — terminating TLS at a proxy that does not forward `X-Forwarded-Proto` produces a login that appears to succeed and then bounces straight back to the login page.

Set `ORIGIN` to the exact public URL and stop guessing:

```sh
ORIGIN=https://sole.example.com
```

SvelteKit compares the browser's `Origin` against this on every form post. Get it wrong and the login returns **403**, with nothing in the app wrong.

## Proxy and network

`compose.yaml` carries Traefik labels for a router and service named `sole`, and expects an **external** network named by `TRAEFIK_NETWORK` (default `traefik_web`). Docker Compose refuses to start if that network does not exist. Either create it, point `TRAEFIK_NETWORK` at one you already have, or set `TRAEFIK_EXTERNAL=false` to have Compose create and manage it for you. Using another proxy means deleting the `traefik.*` labels and the `traefik_web` entry, then publishing the port yourself.

For probes, `GET /api/health` returns `{"status":"ok"}` with `Cache-Control: no-store`. The container also has a healthcheck, so `up --wait` and orchestrators see readiness.

## The music path must match Music Assistant

The web service reads your library through a read-only bind of `MUSIC_LIBRARY_PATH` at `/music`, and resolves each track by matching the path Music Assistant reports. If the mount contains a different tree than MA's paths describe, everything looks healthy while worker audio 404s and nothing ever gets analysed. `ffmpeg` is already in the image.

Named volumes to keep: `postgres-data`, `cluster-artifacts`, `embedding-artifacts`. Clustering writes artifacts and rollback data into `cluster-artifacts`, so treat it as state rather than a cache.

## Open by default

- **Registration is open.** Anyone who can reach the app can create an account; there is no flag to turn this off. If that is not acceptable, put access control in front of it.
- **The worker API is app-authenticated.** `/api/worker/*` uses its own bearer token. If you also put interactive auth (or an SSO gate) in front of it, remote workers break.
- **PostgreSQL is published.** The `database` profile maps `${POSTGRES_PORT:-5432}` on every interface. Remove that `ports` entry — containers reach the database by service name anyway — or at least replace the `change-me` default password.
- **Request bodies are capped at 512 KB.** `POST /api/worker/embeddings` answers **413** above that, so a proxy with a smaller limit stalls embedding uploads.

## Credentials

| Value | What it is for |
|---|---|
| `WORKER_TOKEN` | The default worker. The maintenance job endpoints accept it too, if you want to trigger one from another host. |
| A `worker` key from **Manage → API keys** | Remote workers. Scoped and revocable; prefer it to sharing the token above off this host. |
| `PLAYBACK_API_KEY`, or a `playback` key | External callers of `POST /api/play-vibe`. Nothing else accepts it. |

## Profile-gated services

The default stack is web and the local embedding loop; the maintenance jobs run
inside the web process. Everything else is opt-in:

```sh
docker compose --profile worker up -d          # API-mode worker, needs no music mount
docker compose --profile embedding run --rm embeddings
docker compose --profile clustering run --rm clusterer-bun benchmark   # read-only
docker compose --profile clustering run --rm clusterer                 # apply and rollback
docker compose --profile embedding-rust up -d
docker compose --profile database up -d postgres
```

Applying a clustering run is always a separate, confirmed step from benchmarking one — the images never renumber your clusters on their own, because your names are attached to cluster ids. See [First playable vibe](/guides/first-play).
