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
  playback. [Auto-naming](web/src/lib/server/cluster-naming.ts) uses the three
  most frequent artists in each cluster,
  producing names such as "Sade, Gorillaz, Sia". You can edit them.
- **Recommend:** choose a track and get related tracks.
  [Selection](web/src/lib/server/recomendation-engine.ts) combines audio
  similarity with liked tracks, artist limits, and a penalty for similar picks.
- **Atlas:** inspect a 2D sample of the clusters, select tracks, and play them.
- **Worker:** check embedding counts, pending tracks, and recent worker uploads.
- **Manage:** index the library, review duplicates, change embedding settings,
  and create scoped API keys.

You do not need to train a model or supply listening history. Audio similarity
does not depend on genre tags, but indexing and playback still depend on the
metadata and URIs Music Assistant supplies.

<details>
<summary>More screenshots</summary>

![The Worker view: embedding coverage across the library, with pending, skipped and clustered counts and a progress bar](docs/public/images/first-play/worker.jpg)

</details>

## Requirements and limitations

- Docker Compose v2; `curl` and `openssl` for the quick-start commands
- PostgreSQL with the `vector` extension (included in the starter stack)
- Your own audio files
- **Music Assistant**, reachable over the network, already set up with your
  library

Configure Music Assistant with your library before installing Sole. Sole imports
its track list rather than scanning your music folder independently. The folder
mounted into Sole must contain the audio files Music Assistant reports.

- **Missing Music Assistant connection:** Setup reports `MA_TOKEN is not set`
  or a connection error. Set `MUSIC_HOST` and `MA_TOKEN` in `.env`; Sole uses
  Music Assistant for indexing and playback
  ([connection code](web/src/lib/server/ma-client.ts)).
- **Missing audio files:** the worker receives `404` from `/api/worker/audio`.
  Set `MUSIC_LIBRARY_PATH` to the folder containing your library. Streaming-service
  catalogues are not supported ([file lookup](web/src/lib/server/audio-library.ts)).
- **Initial processing:** each pending track needs audio inference. Measure a
  bounded pass on your hardware with the command under [Python worker](#python-worker).
  The worker stores completed uploads in PostgreSQL and resumes pending tracks
  ([worker implementation](embeddings/worker_api.py)).
- **Embedding settings:** choose the sampling settings before analysing the
  library. Once embeddings exist, the app rejects recipe changes with
  `The library already has embeddings`
  ([settings code](web/src/lib/server/embedding-settings.ts)).
- **Automatic groups:** cluster boundaries come from k-means, not genre labels.
  The initial count grows with library size
  ([count formula](web/src/lib/server/setup/derive-k.ts)).
- **Accounts:** `MAX_USERS=1` is the default. The app has no account roles or
  native mobile app ([registration limits](web/src/lib/server/registration.ts)).
- Development and testing have primarily used the maintainer's library. Other
  collections and Music Assistant providers have not been tested systematically.

## Quick start

This starts PostgreSQL, the web app, and the Python worker using published images.

```sh
mkdir sole && cd sole
curl -fsSL https://raw.githubusercontent.com/poesterlin/sole/main/stack.yaml -o compose.yaml

cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
WORKER_TOKEN=$(openssl rand -hex 24)
MUSIC_LIBRARY_PATH=$HOME/Music
MUSIC_HOST=http://your-music-assistant-host:8095
MA_TOKEN=your-music-assistant-token
EOF
chmod 600 .env

# Edit .env: set your actual music folder and Music Assistant connection.
# For access from another device, also set ORIGIN=http://your-server:3000.
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

The web process reads metadata from PostgreSQL, serves audio snippets, and accepts
embedding uploads. The Python worker downloads those snippets and runs OpenL3.
It needs the web API URL and a worker key, but no direct database connection or
music-folder mount. It can run on the same host, another machine, or in a notebook.

Initial setup uses the web app's k-means implementation. The native Rust CLI
supports PCA (reducing vector dimensions), spherical k-means, benchmark reports,
targeted splits, and transactional apply/rollback. Scheduled library maintenance
runs inside the web process using `Bun.cron`. See the
[Rust CLI guide](clustering-rs/README.md) for clustering commands.

## Reference

The sections below cover deployment, authentication, workers, and maintenance.

### Source-checkout requirements

Install Bun to run the repository scripts. The Docker quick start runs those
scripts inside the web image and does not need Bun on the host.

Rust `1.78` or newer is needed for the optional native clustering tools. The
Python worker uses Python 3.11 and the packages in
`embeddings/requirements.txt`. Python 3.12+ is supported for notebook/API
workers through the packaging-only compatibility installer
`embeddings/install_python312.py`; the validated Docker image remains on Python
3.11.

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

1. Create the environment file:

   ```sh
   cp .env.example .env
   ```

2. Set at least:

   - `DOMAIN`
   - `MUSIC_LIBRARY_PATH`
   - `MUSIC_HOST` and `MA_TOKEN`
   - `WORKER_TOKEN` for the default Compose internal jobs (external workers
     can use a UI-created worker key)

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

6. Start the app and the embedding worker:

   ```sh
   docker compose up -d
   ```

   The web container reads the library through `/music`; the host path comes
    from `MUSIC_LIBRARY_PATH`. Create an account with the command under
    [Authentication](#authentication), then open **Setup** and index the library.
    Use `/status` for embedding counts and recent uploads.

### Authentication

The web UI uses database-backed accounts and a session cookie. Self-registration
is disabled by default. Apply migrations when installing a new database. An
existing database without a migration ledger needs its schema checked before
running `db:migrate`; the command will otherwise attempt to recreate tables.

For the **prebuilt Docker image**, create the first account inside the container
(the helper is included in the image; no local Bun installation is needed):

```sh
docker compose run --rm --entrypoint bun web \
  web/scripts/create-user.ts --username admin
```

There is no default username/password and no automatic first-user registration.
The command prints a generated password once. Run it again with the same username
to reset the password and revoke that account's sessions.

From a source checkout:

```sh
bun run auth:create-user --username admin
```

The command creates the account or replaces its password and revokes that
user's sessions. Without `--password`, it prints a generated password once.
The account limit is `MAX_USERS=1` by default. Raise it in `.env` before
creating more accounts (including with the command above). To allow people to
create their own accounts up to that limit, set `ALLOW_REGISTRATION=true` in
`.env` and restart the web service. Once the limit is reached, the registration
link disappears and `/register` returns to login. Remove the flag and restart
to close sign-ups earlier; existing accounts keep working.

There are two bootstrap service credentials for Compose and existing automations:

- `WORKER_TOKEN` authenticates the default Python worker and the two internal
  maintenance endpoints. It is not accepted by ordinary application routes.
- `PLAYBACK_API_KEY` lets an external caller `POST /api/play-vibe` trigger
  playback. It is not accepted by other application routes.

Signed-in users can also create scoped keys under **API keys** in the
web UI. A `worker` key is accepted only by `/api/worker/*`; a `playback` key is
accepted only by the playback POST. The secret is displayed once, stored only as
a hash, and can be revoked without affecting the account. The environment
credentials configure the default Compose worker and playback integrations.

For example, an external playback trigger can use either the bootstrap key or a
UI-created playback key:

```sh
curl -X POST https://sole.example.com/api/play-vibe \
  -H "Authorization: Bearer $PLAYBACK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Browser requests use the session cookie automatically.

### Global embedding settings

**Manage → Embedding settings** stores the sampling recipe in PostgreSQL. New
installs use **medium: one window every 0.5 seconds, up to 90 seconds of audio**.
The API worker fetches those settings before inference. Choose them before the
first embedding upload; a populated library keeps its existing recipe.
See [`embedding-settings.ts`](web/src/lib/server/embedding-settings.ts) and
[`worker_api.py`](embeddings/worker_api.py).

### Python worker

#### One-off runs

After each pass, the default worker waits twelve hours if the backlog is drained,
five minutes if tracks remain, or fifteen minutes after an error. For a bounded
diagnostic pass:

```sh
time docker compose run --rm --entrypoint python worker \
  worker.py --source-mode api --dry-run --limit 10
```

It needs only the worker API URL and a worker-scoped
bearer key; it reads audio through the API rather than a local music mount.
Create the key under **API keys** in the UI, or use the bootstrap `WORKER_TOKEN`
for an existing deployment.

```sh
export WORKER_URL=https://sole.example.com
export WORKER_TOKEN='a-worker-scoped-key'
python embeddings/worker.py --source-mode api
```

The web service provides three authenticated endpoints:

- `GET /api/worker/tracks` — a bounded page of pending track metadata;
- `GET /api/worker/audio` — a server-generated, time-bounded MP3 snippet;
- `POST /api/worker/embeddings` — a vector batch; rows with existing embeddings
  are excluded from the update
  ([upload handler](web/src/routes/api/worker/embeddings/+server.ts)).

The worker uses a bounded thread pool for network downloads while OpenL3
inference remains sequential. The worker saves its page cursor after an upload
succeeds ([`worker_api.py`](embeddings/worker_api.py)).

Worker settings:

| Variable | Meaning |
|---|---|
| `WORKER_URL` | Base URL of the web worker API |
| `WORKER_TOKEN` | Bearer token shared with the web service |
| `EMBEDDING_PREFETCH_WORKERS` | Parallel snippet downloads |
| `EMBEDDING_PREFETCH_DEPTH` | Download lookahead |
| `EMBEDDING_INFER_BATCH_SIZE` | One-second windows per OpenL3 predict call |
| `EMBEDDING_DOWNLOAD_TIMEOUT` | Per-request timeout in seconds |
| `EMBEDDING_DOWNLOAD_RETRIES` | Retry count for network failures |
| `EMBEDDING_DOWNLOAD_MAX_BYTES` | Maximum bytes per snippet |
| `EMBEDDING_STATE_FILE` | Optional local cursor/progress file |

Compose runs API mode beside the web service as the default `worker` service:

```sh
docker compose up -d worker
```

For Colab or Jupyter, open **API keys** in the web UI, create a Worker key, and
copy the worker cell from that page. The cell clones the repository,
installs `embeddings/requirements.txt`, prompts for the key, and runs the
API worker with the server's embedding settings. The same notebook is downloadable as
[`web/static/sole-worker.ipynb`](web/static/sole-worker.ipynb).

The worker URL must be reachable from the notebook. The copied cell uses the
dependencies in `embeddings/requirements.txt` on Python 3.11, or the compatibility
installer on Python 3.12+. It
starts with `--dry-run --limit 1`; remove those flags only when you are ready to
write embeddings. Its filesystem is temporary; use `EMBEDDING_STATE_FILE` on
mounted storage if the job must resume there.

### Database and diagnostics

```sh
bun run db:migrate
bun run db:ensure-centered
bun run doctor -- --json
```

For an existing legacy database that predates the Drizzle migration journal,
run `bun run db:ensure-user-api-keys` after the `user` and `session` tables are
present.

[`doctor.ts`](scripts/doctor.ts) checks configuration, the database connection,
pgvector, auth and pipeline tables and columns, and the host audio path.

### Background services

The default Compose stack runs the web process and Python embedding worker.
The native Rust clustering CLI uses the `clustering` profile; the optional
PostgreSQL service uses the `database` profile.

The maintenance jobs (favourites sync, library index, cluster assignment) run
inside the web process on `Bun.cron`. They need `MUSIC_HOST` and `MA_TOKEN`; a
web-only install without them logs that the schedules are disabled.

Run `bun run clusters:native -- --help` for the clustering options. Benchmark
mode reads vectors and writes report files; `--record-run` also records metadata
in the database. Applying assignments requires `--confirm-apply`, and rollback
requires `--confirm-rollback`
([CLI implementation](clustering-rs/src/main.rs)).

### Development checks

```sh
(cd web && bun install --frozen-lockfile && bun run check && bun run build)
(cd assets && bun run check)
cargo test --manifest-path clustering-rs/Cargo.toml --locked
docker build -t sole-embeddings:ci embeddings
docker run --rm -v "$PWD/embeddings:/workspace-tests:ro" \
  --entrypoint python sole-embeddings:ci \
  -m unittest discover -s /workspace-tests/tests
```

CI runs the same web, Rust, Python, fresh-database, Compose, and Docker checks.
Tagging a commit as `v*` runs `.github/workflows/release.yml`, which publishes
versioned service images to GHCR and creates a GitHub release.

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
- Generated cluster statistics and music-map HTML files are local artifacts and
  are intentionally ignored.

### Naming clusters

**Setup → Auto-name missing vibes** labels unnamed clusters using their three
most frequent artists. Existing names are left unchanged. On **Vibe → Browse**,
click a tile to inspect representative tracks and edit the name.

Names live in `cluster_name`, keyed by clustering run and cluster ID. Each row
records whether the name was automatic or manual. A new generation starts with
`Cluster N` labels until named; rollback selects the names from the previous
generation. Overlap matching records suggestions separately in `cluster_run_match`.
See [`cluster-naming.ts`](web/src/lib/server/cluster-naming.ts) and the
[name migration](drizzle/0018_cluster_names.sql).

Cover art is fetched from Music Assistant during indexing and stored as an
imageproxy path on `track.album_image`. The UI requests cover images through
[`/api/cover`](web/src/routes/api/cover/+server.ts).

### Duplicates

Music Assistant can report multiple entries for the same recording. Indexing
stores each URI, so duplicate entries can contribute multiple vectors to a cluster.

**Manage → Duplicates** lists groups sharing a normalised track name, first
artist, and album name. A suffix such as `Live at…` or `Remastered` separates
entries when it is present in the title; missing or inconsistent metadata can
still group different recordings. Review the groups before pruning. The keeper
ordering prefers a copy with an embedding, and the other copies are marked skipped.

[`duplicates.ts`](web/src/lib/server/duplicates.ts) averages the copies'
embeddings into the keeper. The
[centering trigger](drizzle/0006_centered_embedding_trigger.sql) recomputes the
centered vector after the merged embedding is written.

The scan flags potentially different recordings and leaves those groups
unselected. Matching metadata alone does not establish that the audio is identical.

The scan includes clustered and unclustered tracks. Marking an unembedded copy
skipped also removes it from the worker's pending tracks.

`track.skip` is the maintenance flag. It is honoured by the embedding worker,
the worker audio endpoint, recommendation and similar-track queries, cluster
assignment, centroid backfill, and the cluster sample endpoint. The separate
`skipped_songs` table is the listener's own "don't play this" list, and both are
respected.

A skipped track keeps its existing `cluster_id`. Pruning changes what is
recommended and what the next clustering run sees; it does not retroactively
re-assign tracks that were already clustered. To compute a new partition, use
the native Rust clustering CLI's benchmark and apply workflow.

The scan and cleanup use the same keeper ordering. Indexing updates metadata
without changing `track.skip`. The page also provides actions to restore skipped
tracks.

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

For issues and pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md) for the
development checks and reporting instructions.

If you find something that looks like a security problem, do not open a public
issue. See [SECURITY.md](SECURITY.md).

- [Contributing guidelines](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

This project is released under the [MIT License](LICENSE).
