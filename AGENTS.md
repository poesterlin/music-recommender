# Music Recommender contributor and deployment notes

## Checks

- Install web dependencies: `cd web && bun install --frozen-lockfile`
- Web checks/build: `cd web && bun run check && bun run build`
- Native clustering: `cargo test --manifest-path clustering-rs/Cargo.toml --locked`
- WASM adapter: `cargo test --manifest-path clustering-wasm/Cargo.toml --locked`
- Embedding core/CLI: `cargo test --manifest-path embedding-rs/Cargo.toml --locked --no-default-features --features 'cli onnxruntime'`
- Python worker tests: build `embeddings/Dockerfile`, then run `unittest discover` from `embeddings/tests`
- Fresh database: provide a disposable pgvector URL and run `bun run db:migrate && FRESH_DATABASE=1 bun run test:fresh-db`
- Create/reset an account: `bun run auth:create-user --username <name>`
- The authenticated `/settings` page manages scoped Worker and Home Assistant
  API keys; secrets are shown once and stored hashed.

## Configuration

Copy `.env.example` to `.env`. Never commit the filled file. The host audio
path is `MUSIC_LIBRARY_PATH`; containers see it at `/music`.

The optional `database` Compose profile provides PostgreSQL with pgvector:

```sh
docker compose --profile database up -d postgres
```

External PostgreSQL installations can leave that profile disabled and provide
`DATABASE_URL` directly. When the profile is enabled, keep
`DATABASE_INTERNAL_URL` pointed at the `postgres` service for containers while
`DATABASE_URL` points at the localhost-bound port for host commands.

## Runtime profiles

- Default: web, Music Assistant sync, analyzer, and the Python embedding loop.
- `embedding`: bounded/manual Python worker runs.
- `clustering`: native and Bun/WASM clustering jobs.
- `embedding-rust`: optional Rust embedding worker.
- `worker`: API-mode Python worker; it uses the web worker API and no database.

The app uses database-backed user/session authentication. Registration is
always available; use `bun run auth:create-user --username <name>` to create
or reset an account. `WORKER_TOKEN` is limited to the worker and internal jobs;
`PLAYBACK_API_KEY` is limited to the Home Assistant playback POST. API worker
mode is enabled with `--source-mode api` and `WORKER_URL` plus `WORKER_TOKEN`.
It downloads bounded snippets in a background pool and uploads batches over
HTTP. Cluster apply/rollback and embedding writes are explicit operations.
Read-only status and dry-run commands are safe for diagnostics.

## Deployment

The Compose file expects the external Traefik network (`TRAEFIK_NETWORK`,
default `traefik_web`) and uses the `DOMAIN` variable for routing. The
repository `deploy.sh` is specific to the original homelab; use the Compose
workflow for a new host.

Before exposing the service, run:

```sh
bun run doctor -- --strict
docker compose config --quiet
```
