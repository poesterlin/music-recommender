# Music Recommender

A local music-library indexer, OpenL3 embedding worker, pgvector similarity
search, and clustering service. The web process is the database-backed UI and
API. The Python worker can run beside it or on another machine.

## Requirements

- Docker Compose v2
- Bun
- PostgreSQL with the `vector` extension
- A music library available to the web process
- Music Assistant for library metadata and playback
- Home Assistant for the current library import endpoint

Rust `1.78` or newer is needed for the optional native clustering tools. The
Python worker needs the packages in `embeddings/requirements.txt`.

## Install

1. Create the environment file:

   ```sh
   cp .env.example .env
   ```

2. Set at least:

   - `DOMAIN`
   - `MUSIC_LIBRARY_PATH`
   - `MUSIC_HOST` and `MA_TOKEN`
   - `HA_HOST`, `TOKEN`, and `CONFIG_ID`
   - `WORKER_TOKEN` if the worker or internal jobs will be used
   - `PLAYBACK_API_KEY` if Home Assistant will trigger playback

3. Choose a database.

   For the optional Compose database:

   ```sh
   docker network create "${TRAEFIK_NETWORK:-traefik_web}" 2>/dev/null || true
   docker compose --profile database up -d postgres
   ```

   `DATABASE_URL` is for commands run on the host. `DATABASE_INTERNAL_URL` is
   used by containers. For an external database, set both to its reachable URL,
   or leave `DATABASE_INTERNAL_URL` unset.

4. Install the schema:

   ```sh
   bun install --frozen-lockfile
   bun run db:migrate
   ```

   `db:migrate` enables pgvector when needed. A new database has no centered
   embedding space until at least two raw embeddings exist.

5. Check the host configuration:

   ```sh
   bun run doctor -- --strict
   ```

6. Start the web and default background services:

   ```sh
   docker compose up -d
   ```

   The web container reads the library through `/music`; the host path comes
   from `MUSIC_LIBRARY_PATH`. Open the application, import the library from
   **Manage**, and use `/status` to inspect progress.

## Authentication

The web UI uses database-backed accounts and an opaque session cookie. Run
`bun run db:migrate` once on an existing database before using the new login
pages. Anyone can register an account; registration does not depend on a
restart-time flag. To create the first account or reset a password without the
UI, run:

```sh
bun run auth:create-user --username admin
```

The command creates the account or replaces its password and revokes that
user's sessions. Without `--password`, it prints a generated password once.

There are two service credentials:

- `WORKER_TOKEN` authenticates the Python worker and the two internal Compose
  jobs. It is not accepted by ordinary application routes.
- `PLAYBACK_API_KEY` lets Home Assistant `POST /api/play-vibe` trigger external
  playback. It is not accepted by other application routes.

For example, the Home Assistant request can use the bearer header form:

```sh
curl -X POST https://recommender.example.com/api/play-vibe \
  -H "Authorization: Bearer $PLAYBACK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Browser requests use the session cookie automatically. The app does not need
user-managed API keys.

## Python worker

The worker has two source modes.

### Local mode

Local mode keeps the existing PostgreSQL advisory lock and `job_run` checkpoint.
It reads files from `AUDIO_DIR` and writes embeddings directly to PostgreSQL.

```sh
python embeddings/generate-local-embeddings.py --dry-run --limit 10
```

### API mode

API mode is portable. It needs only the worker API URL and its bearer token; it
does not need PostgreSQL, Music Assistant, Home Assistant, or a local music
mount.

```sh
export WORKER_URL=https://recommender.example.com
export WORKER_TOKEN='the-same-token-as-the-web-service'
python embeddings/worker.py --source-mode api
```

The web service provides three authenticated endpoints:

- `GET /api/worker/tracks` — a bounded page of pending track metadata;
- `GET /api/worker/audio` — a server-generated, time-bounded MP3 snippet;
- `POST /api/worker/embeddings` — an idempotent vector batch.

The worker uses a bounded thread pool for network downloads while OpenL3
inference remains sequential. A page is checkpointed only after its upload
succeeds, so a failed page is retried instead of being skipped.

Useful settings:

| Variable | Meaning |
|---|---|
| `WORKER_URL` | Base URL of the web worker API |
| `WORKER_TOKEN` | Bearer token shared with the web service |
| `EMBEDDING_PREFETCH_WORKERS` | Parallel snippet downloads |
| `EMBEDDING_PREFETCH_DEPTH` | Download lookahead |
| `EMBEDDING_DOWNLOAD_TIMEOUT` | Per-request timeout in seconds |
| `EMBEDDING_DOWNLOAD_RETRIES` | Retry count for network failures |
| `EMBEDDING_DOWNLOAD_MAX_BYTES` | Maximum bytes per snippet |
| `EMBEDDING_STATE_FILE` | Optional local cursor/progress file |

The Compose profile runs API mode beside the web service:

```sh
docker compose --profile worker up -d worker
```

For Colab, clone the repository, install `embeddings/requirements.txt` in a
fresh runtime, set `WORKER_URL` and `WORKER_TOKEN`, and run:

```python
!python embeddings/worker.py --source-mode api --limit 10
```

The worker URL must be reachable from Colab. Colab's filesystem is temporary;
use `EMBEDDING_STATE_FILE` on mounted storage if the job must resume there.

## Database and diagnostics

```sh
bun run db:migrate
bun run db:ensure-centered
bun run doctor -- --json
```

`doctor` checks configuration, the database connection, pgvector, the auth and
pipeline tables and columns, and the host audio path without writing data.

## Background services

The default Compose stack includes the web process, Music Assistant sync, the
analyzer, and the Python embedding loop. Additional profiles are available for
manual embedding runs, clustering, the Rust embedding worker, and API-mode
workers.

Cluster benchmark commands are read-only. Applying or rolling back a cluster is
an explicit operation.

## Development checks

```sh
cd web && bun install --frozen-lockfile && bun run check && bun run build
cargo test --manifest-path clustering-rs/Cargo.toml --locked
cargo test --manifest-path clustering-wasm/Cargo.toml --locked
cargo test --manifest-path embedding-rs/Cargo.toml --locked --no-default-features --features 'cli onnxruntime'
docker build -t music-recommender-embeddings:ci embeddings
docker run --rm -v "$PWD/embeddings:/workspace-tests:ro" \
  --entrypoint python music-recommender-embeddings:ci \
  -m unittest discover -s /workspace-tests/tests
```

CI runs the same web, Rust, Python, fresh-database, Compose, and Docker checks.
Tagging a commit as `v*` runs `.github/workflows/release.yml`, which publishes
versioned service images to GHCR and creates a GitHub release.

## Configuration notes

- Keep `.env`, database URLs, and tokens out of source control.
- Keep PostgreSQL private. The optional database profile binds its host port
  to `127.0.0.1`.
- The web service must have `ffmpeg` and a read-only music mount to serve worker
  audio snippets.
- The repository `deploy.sh` targets the original homelab. Use the Compose
  workflow for another host.
- The Rust embedding model artifact is optional and is not committed.

## Troubleshooting

- `vector` errors: run `bun run db:ensure-pgvector` or `bun run db:migrate` with
  a database user that can enable the extension.
- `401` from the app: use the session cookie, or the service key for the
  specific internal/playback route.
- Worker `401`: check that `WORKER_TOKEN` matches on the worker and web service.
- Worker `404` for audio: verify `MUSIC_LIBRARY_PATH` and the track's local file
  match.
- Slow downloads: increase `EMBEDDING_PREFETCH_WORKERS` only after checking
  server and network limits.
- Pending embeddings: inspect `/status`, then use a bounded `--dry-run`.
