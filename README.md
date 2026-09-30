# Sole

[![CI](https://github.com/poesterlin/sole/actions/workflows/ci.yml/badge.svg)](https://github.com/poesterlin/sole/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-guidance-0f7666)](https://poesterlin.github.io/sole/)
[![License](https://img.shields.io/badge/license-MIT-0f7666)](LICENSE)

Sole is a self-hosted music browser and recommender for a local audio collection.
It reads your library from [Music Assistant](https://www.music-assistant.io/),
analyses audio with a pretrained [OpenL3](https://github.com/miraglab/OpenL3) model,
and stores a list of 512 numbers for each analysed track in PostgreSQL. These
lists, called embeddings, let Sole compare tracks by sound and group them into
clusters. The UI calls those groups *vibes*.

![The Vibe view: library clusters rendered as cover-art tiles, each auto-named for the artists that dominate it](docs/public/images/first-play/vibes.jpg)

## Features

- **Vibe:** browse clusters as cover-art tiles, filter by name, and schedule
  playback. Editable names use the three most frequent artists in each cluster
  ([naming code](web/src/lib/server/cluster-naming.ts)).
- **Recommend:** choose a track and get related tracks.
  Selection combines audio similarity with liked tracks, artist limits, and a
  penalty for similar picks
  ([recommendation code](web/src/lib/server/recomendation-engine.ts)).
- **Atlas:** inspect a 2D sample of the clusters, select tracks, and play them.
- **Worker:** check embedding counts, pending tracks, and recent worker uploads.
- **Manage:** index the library, review duplicates, change embedding settings,
  and create scoped API keys.

Sole needs no model training and no listening history. Indexing and playback
still rely on metadata and URIs from Music Assistant.

## Requirements

- Docker Compose v2; `curl` and `openssl` for the quick-start commands
- PostgreSQL with the `vector` extension (included in the starter stack)
- Your own audio files
- **Music Assistant**, reachable over the network, already set up with your
  library

Sole imports Music Assistant's track list. Its music mount must contain those files.

## Known problems

- **The app reports `The library already has embeddings` when changing settings:**
  keep the recorded recipe. Recipe changes require a full re-embedding transition,
  which the app does not yet provide
  ([settings code](web/src/lib/server/embedding-settings.ts)).
- **An upgrade's worker receives `500` while listing tracks:** check whether
  the database has `embedding_settings`. See [Database and diagnostics](#database-and-diagnostics).
- **A cluster contains tracks you would separate:** inspect its tracks in
  **Vibe → Browse**. Use the [Rust CLI](clustering-rs/README.md) to benchmark a
  different cluster count or split a group. K-means does not produce genre labels.

## Limits

- Sole analyses local audio files; it does not analyse streaming-service catalogues.
- `MAX_USERS=1` is the default. Raise it before creating another account
  ([authentication](#authentication)). The app has no account roles or native mobile app.
- Development and testing have primarily used the maintainer's library of about
  **31,500 tracks**. Other collections and providers have not been tested
  systematically. For a provider issue, report the provider, visible error, and
  whether Music Assistant itself can play the affected track.
- On **2026-09-30**, three CPU passes over the same 90-second excerpt took
  **5.9 seconds median** on an **AMD Ryzen 7 255**, with 10 CPUs visible to the
  runtime, a 0.5-second window hop, and batches of 64 windows.
  That extrapolates to about **99 minutes per 1,000 tracks for inference and
  audio decoding**, excluding startup, snippet generation/download, and uploads.
  This is a snippet-based estimate, not measured library throughput. Use the
  [bounded worker command](#python-worker) to compare your hardware.

## Quick start

This starts PostgreSQL, the web app, and the Python worker using published images.

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/stack.yaml -o compose.yaml

# Write the template, then replace CHANGE_ME values before starting containers.
# For access from another device, set ORIGIN=http://your-server:3000 too.
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
WORKER_TOKEN=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
MUSIC_HOST=CHANGE_ME
MA_TOKEN=CHANGE_ME
EOF
chmod 600 .env

# Set MUSIC_HOST to the Music Assistant URL and MA_TOKEN to its API token.
# Set MUSIC_LIBRARY_PATH to your existing music folder.
${EDITOR:-vi} .env
grep -q CHANGE_ME .env && { echo 'Replace CHANGE_ME values in .env first'; exit 1; }
docker compose up -d --wait

docker compose run --rm --entrypoint sh web \
  -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

The last command prints a generated password once. Open `http://127.0.0.1:3000/login`,
sign in, and open **Setup**. Its live checklist lets you index the library,
create vibes when enough tracks have been analysed, and auto-name missing vibes.
Music Assistant connection settings live in `.env`; restart the web service after
changing them with `docker compose up -d web`. The worker processes audio in the
background; open **Worker** to check counts and recent uploads.

[`setup.sh`](setup.sh) generates credentials and runs these steps. For a source
checkout, see [Other ways to install](#other-ways-to-install).

Full walkthrough, including public deployment behind a reverse proxy:
**<https://poesterlin.github.io/sole/>**

## Components

```
Music Assistant ── metadata and playback ── web (Bun + SvelteKit)
                                                │
                            audio snippets      ⇅      vector uploads
                                      worker (Python, OpenL3)

web ── PostgreSQL + pgvector ── native Rust clustering CLI
```

The web process serves audio snippets and accepts embeddings. The Python worker
runs OpenL3 using a web API URL and worker key; it needs no database connection
or music mount.

Initial setup uses the web app's k-means implementation. The native Rust CLI
supports PCA (reducing vector dimensions), spherical k-means, benchmark reports,
targeted splits, and transactional apply/rollback. Scheduled library maintenance
runs inside the web process using `Bun.cron`. See the
[Rust CLI guide](clustering-rs/README.md) for clustering commands.

## Reference

### Source-checkout requirements

Repository scripts require Bun; optional clustering tools require Rust 1.78+.
The Docker worker uses Python 3.11 and `embeddings/requirements.txt`.
Notebook/API workers on Python 3.12+ use `embeddings/install_python312.py`.

### Install

#### Other ways to install

**Installer script:**

```sh
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/setup.sh -o setup.sh
less setup.sh   # read it first
bash setup.sh "$HOME/Music"
```

**Build from a checkout** instead of pulling the published images:

```sh
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

To use a separate environment file, pass `--env-file <path>` to Compose.

#### Public deployment

For Traefik deployment from a checkout, copy `.env.example` to `.env`. Set
`DOMAIN`, `MUSIC_LIBRARY_PATH`, `MUSIC_HOST`, `MA_TOKEN`, and `WORKER_TOKEN`.
`DATABASE_URL` is the host connection; `DATABASE_INTERNAL_URL` is the container
connection. For an external database, set both to reachable URLs.

```sh
docker network create "${TRAEFIK_NETWORK:-traefik_web}" 2>/dev/null || true
docker compose --profile database up -d postgres
bun install --frozen-lockfile
bun run db:migrate
bun run doctor -- --strict
docker compose up -d
```

Omit the database service command for external PostgreSQL. Create an account
using [Quick start](#quick-start), then open **Setup**.

### Authentication

The web UI uses database-backed accounts and session cookies. Self-registration
is disabled by default.

Create the first Docker account using the command in [Quick start](#quick-start).
There is no default username/password or automatic first-user registration.

From a source checkout:

```sh
bun run auth:create-user --username admin
```

To reset a password, rerun the account helper with the same username. It replaces
the password and revokes that account's sessions.
Raise `MAX_USERS` before creating additional accounts. Set
`ALLOW_REGISTRATION=true` and restart the web service to enable sign-ups up to
that limit. Remove the flag and restart to close sign-ups.

Environment credentials:

- `WORKER_TOKEN` authenticates the default Python worker and the two internal
  maintenance endpoints. It is not accepted by ordinary application routes.
- `PLAYBACK_API_KEY` lets an external caller `POST /api/play-vibe` trigger
  playback. It is not accepted by other application routes.

Under **API keys**, users can create revocable `worker` keys for `/api/worker/*`
or `playback` keys for the playback POST. Secrets appear once and are stored
hashed. Either playback key type works here:

```sh
curl -X POST https://sole.example.com/api/play-vibe \
  -H "Authorization: Bearer $PLAYBACK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### Global embedding settings

**Manage → Embedding settings** stores the sampling recipe in PostgreSQL. New
installs use **medium: one window every 0.5 seconds, up to 90 seconds of audio**.
The API worker fetches those settings before inference. Choose them before the
first embedding upload; a populated library keeps its existing recipe.

### Python worker

After each pass, the default worker waits twelve hours if the backlog is drained,
five minutes if tracks remain, or fifteen minutes after an error. For a bounded
diagnostic pass:

```sh
time docker compose run --rm --entrypoint python worker \
  worker.py --source-mode api --dry-run --limit 10
```

For a remote worker, install the Python dependencies and create a Worker key
under **API keys**:

```sh
export WORKER_URL=https://sole.example.com
export WORKER_TOKEN='a-worker-scoped-key'
python embeddings/worker.py --source-mode api
```

Downloads run concurrently; inference runs sequentially. The worker saves its
cursor after successful uploads and leaves existing embeddings unchanged
([worker code](embeddings/worker_api.py)).

For Colab/Jupyter, copy the cell from **API keys** or download
[the notebook](web/static/sole-worker.ipynb). The web URL must be reachable.
The cell starts with `--dry-run --limit 1`; remove those flags to write embeddings.
Set `EMBEDDING_STATE_FILE` on persistent storage to retain its cursor.

### Database and diagnostics

```sh
bun run db:migrate
bun run db:ensure-centered
bun run doctor -- --json
```

For an existing legacy database that predates the Drizzle migration journal,
run `bun run db:ensure-user-api-keys` after the `user` and `session` tables are
present.

If an upgraded worker reports `500` while listing tracks, inspect the settings
table from the deployed web container:

```sh
docker compose exec web bun -e 'import postgres from "postgres"; const s=postgres(process.env.DATABASE_URL); console.log(JSON.stringify(await s`SELECT to_regclass(${"public.embedding_settings"}) AS settings_table`)); await s.end();'
```

A null result means the table is missing. A database with an up-to-date migration
ledger can use `bun run db:migrate`. If the schema exists but the ledger is empty,
review [`0017_embedding_settings.sql`](drizzle/0017_embedding_settings.sql) against
the existing schema. For that missing table, apply just the settings migration in
a transaction:

```sh
docker compose exec web bun -e 'import postgres from "postgres"; const s=postgres(process.env.DATABASE_URL); const migration=await Bun.file("drizzle/0017_embedding_settings.sql").text(); await s.begin(async tx => { await tx.unsafe(migration); }); await s.end();'
```

This does not populate the migration ledger. Replaying all migrations will still
attempt to recreate existing tables.

[`doctor.ts`](scripts/doctor.ts) checks configuration, the database connection,
pgvector, auth and pipeline tables and columns, and the host audio path.

### Configuration notes

- Keep `.env`, database URLs, and tokens out of source control.
- The repository Compose file publishes web and database ports on every interface.
  The starter stack publishes only the web port. Set a real
  `POSTGRES_PASSWORD`, and remove the `postgres` `ports:` entry if nothing
  outside the stack needs to reach the database.
- The web service must have `ffmpeg` and a read-only music mount to serve worker
  audio snippets.
- The repository `deploy.sh` runs from a checkout on the deployment machine; it
  fetches the configured branch and rebuilds the local Compose stack. Use the
  Compose workflow directly for another host.

### Naming clusters

**Setup → Auto-name missing vibes** labels unnamed clusters using their three
most frequent artists. Existing names are left unchanged. On **Vibe → Browse**,
click a tile to inspect representative tracks and edit the name.

Names are scoped to clustering generations; rollback restores the previous
generation's names ([naming code](web/src/lib/server/cluster-naming.ts)).

### Duplicates

Duplicate Music Assistant entries can contribute multiple vectors to a cluster.

**Manage → Duplicates** lists groups sharing a normalised track name, first
artist, and album name. A suffix such as `Live at…` or `Remastered` separates
entries when it is present in the title; missing or inconsistent metadata can
still group different recordings. Review the groups before pruning. The keeper
ordering prefers a copy with an embedding, and the other copies are marked skipped.

[`duplicates.ts`](web/src/lib/server/duplicates.ts) averages the copies'
embeddings into the keeper. The
[centering trigger](drizzle/0006_centered_embedding_trigger.sql) recomputes the
centered vector after the merged embedding is written.

I first limited the scan to clustered tracks and missed about two thirds of the
duplicates. The scan now includes clustered and unclustered tracks. Marking an
unembedded copy skipped also removes it from the worker's pending tracks.

The worker, audio endpoint, recommendation queries, and cluster assignment check
`track.skip`, the maintenance flag. Recommendation queries also check
`skipped_songs`, the listener's "don't play this" list.

A skipped track keeps its `cluster_id`. Pruning affects recommendations and future
clustering; use the Rust CLI to recompute assignments.

Indexing preserves `track.skip`. The Duplicates page can restore skipped tracks.

### Troubleshooting

Commands below use the Compose file from the quick start. If you used `setup.sh`,
add `-f stack.yaml` after `docker compose`.

| Symptom | Check and action |
|---|---|
| Login POST returns `403` | Set `ORIGIN` in `.env` to the URL you use in the browser, including scheme and port. Run `docker compose up -d web`. |
| Setup reports `MA_TOKEN is not set` or a connection error | Set `MUSIC_HOST` and `MA_TOKEN` in `.env`, restart with `docker compose up -d web`, and refresh Setup. |
| Worker receives `401` | Check that its Worker-scoped key is active and matches `WORKER_TOKEN` or a key created under **API keys**. Run `docker compose logs --tail=100 worker`. |
| Worker receives `404` for audio | Check that `MUSIC_LIBRARY_PATH` contains the track's file. Review `docker compose logs --tail=100 web` for file lookup failures. |
| No recent uploads, or tracks remain pending | Open `/status` and run `docker compose logs --tail=100 worker`. Then run the bounded diagnostic command under [Python worker](#python-worker). The worker may be processing a page, waiting between passes, or stopped. |
| PostgreSQL reports a missing `vector` extension | Run `docker compose run --rm --entrypoint bun web scripts/ensure-pgvector.ts` with a database role permitted to install the extension. |
| Migration reports `relation "track" already exists` | The schema may exist without a Drizzle migration ledger. Stop retrying the full migration and inspect the schema and ledger before applying individual migrations. See [Database and diagnostics](#database-and-diagnostics). |

For provider and audio-path issues, see the
[troubleshooting reference](docs/reference/troubleshooting.md).

## Contributing

- [Contributing guidelines](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

This project is released under the [MIT License](LICENSE).
