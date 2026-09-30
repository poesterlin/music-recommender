# Public deployment

Getting a container behind TLS and pointing DNS at it is your business. What follows is only what will bite you with this app.

## Set the public URL for login

Set `ORIGIN` to the exact public URL and stop guessing:

```sh
ORIGIN=https://sole.example.com
```

SvelteKit compares the browser's `Origin` against this on every form post. Get it wrong and the login returns **403**, with nothing in the app wrong.

## Behind your proxy

The repo's `compose.yaml` wires it like this — these lines are lifted straight from it:

```yaml
services:
  web:
    environment:
      PORT: "3000"                             # what the container listens on
      ORIGIN: "${ORIGIN:-https://${DOMAIN}}"   # must match the public URL
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.sole.rule=Host(`${DOMAIN}`)"
      - "traefik.http.services.sole.loadbalancer.server.port=3000"
    networks:
      - traefik_web

networks:
  traefik_web:
    external: ${TRAEFIK_EXTERNAL:-true}
    name: ${TRAEFIK_NETWORK:-traefik_web}
```

Replace the labels with your proxy's, or drop them and publish the port. The one fact your proxy needs is the container port, **3000**.

For probes, `GET /api/health` returns `{"status":"ok"}` with `Cache-Control: no-store`. The container also has a healthcheck, so `up --wait` and orchestrators see readiness.

## The music path must match Music Assistant

The web service reads your library through a read-only bind of `MUSIC_LIBRARY_PATH` at `/music`, and resolves each track by matching the path Music Assistant reports. If the mount contains a different tree than MA's paths describe, everything looks healthy while worker audio 404s and nothing ever gets analysed. `ffmpeg` is already in the image.

Named volumes to keep: `postgres-data`, `cluster-artifacts`. Clustering writes artifacts and rollback data into `cluster-artifacts`, so treat it as state rather than a cache.

## Access and uploads

Self-registration is off by default, and `MAX_USERS` defaults to `1`. Create an account with `bun run auth:create-user --username <name>` from the repository. To allow more accounts, set a higher `MAX_USERS` in `.env`; to let people create their own up to that limit, also set `ALLOW_REGISTRATION=true` and restart the app. The registration link disappears at the limit, and direct visits return to login. Existing accounts remain usable. For the optional PostgreSQL service, set a real password and keep its port private. If remote workers connect through your proxy, allow uploads of at least 512 KB and let their bearer-authenticated API requests through.

## Credentials

| Value | What it is for |
|---|---|
| `WORKER_TOKEN` | The default worker. The maintenance job endpoints accept it too, if you want to trigger one from another host. |
| A `worker` key from **Manage → API keys** | Remote workers. Scoped and revocable; prefer it to sharing the token above off this host. |
| `PLAYBACK_API_KEY`, or a `playback` key | External callers of `POST /api/play-vibe`. Nothing else accepts it. |

## Profile-gated services

The default stack is web plus the API-mode embedding worker, which needs no music
mount and no database; the maintenance jobs run inside the web process.
Everything else is opt-in:

```sh
docker compose run --rm worker python worker.py --source-mode api --dry-run --limit 10
docker compose --profile clustering run --rm clusterer --help
docker compose --profile database up -d postgres
```

Applying a clustering run is always a separate, confirmed step from benchmarking one — the images never renumber your clusters on their own, because your names are attached to cluster ids. See [First playable vibe](/guides/first-play).
