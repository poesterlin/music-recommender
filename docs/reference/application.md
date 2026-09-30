# Authentication and configuration

Edit `.env`, then run `docker compose up -d` to apply container settings.
Commands assume a source checkout unless they mention the starter stack.

## Authentication

There is no default account. Follow [Local install](/getting-started/local)
to create the first Docker account.

From a source checkout, run:

```sh
bun run auth:create-user --username admin
```

Rerun the helper with the same username to reset its password.
It revokes that account's sessions
([account helper](https://github.com/poesterlin/sole/blob/main/web/scripts/create-user.ts)).

`MAX_USERS` defaults to `1`. Raise it before creating additional accounts.
Self-registration is disabled by default. Set `ALLOW_REGISTRATION=true` to
allow sign-ups within that limit. Restart the web service after changing it.

## API keys

Create scoped keys under **API keys**. Secrets appear once and are stored hashed.
See the [key code](https://github.com/poesterlin/sole/blob/main/web/src/lib/server/api-keys.ts).

| Credential | Accepted routes |
|---|---|
| `WORKER_TOKEN` | `/api/worker/*`, plus POST `/api/analyze` and `/api/sync-favorites` |
| UI-created `worker` key | `/api/worker/*` |
| `PLAYBACK_API_KEY` or UI-created `playback` key | POST `/api/play-vibe` |

The [route guard](https://github.com/poesterlin/sole/blob/main/web/src/hooks.server.ts)
limits service credentials to those routes.

```sh
curl -X POST https://sole.example.com/api/play-vibe \
  -H "Authorization: Bearer $PLAYBACK_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Embedding settings

**Manage → Embedding settings** stores the sampling recipe in PostgreSQL.
New installs use one window every `0.5` seconds, with at most `90` seconds of audio.
Choose the recipe before uploading embeddings. A populated library keeps its
existing recipe. The API worker fetches the recipe before inference.

See [Embedding workers](/guides/worker) for remote workers and notebooks.
See the [Python reference](https://github.com/poesterlin/sole/blob/main/embeddings/README.md)
for dependency installation and command options.

## Database commands

```sh
bun run db:migrate
bun run db:ensure-centered
bun run doctor -- --json
```

The [doctor script](https://github.com/poesterlin/sole/blob/main/scripts/doctor.ts)
checks configuration, database access, pgvector, required schema, and the host audio path.

For a legacy database without a Drizzle migration journal, inspect its schema first.
Run `bun run db:ensure-user-api-keys` only after `user` and `session` tables exist.
See [migration troubleshooting](/reference/troubleshooting) before replaying migrations.

## Cluster names

**Setup → Auto-name missing vibes** uses each cluster's three most frequent artists.
It leaves existing names unchanged. Click a **Vibe → Browse** tile to edit its name.
Names belong to clustering generations. Rollback restores the earlier generation's names.
See the [naming code](https://github.com/poesterlin/sole/blob/main/web/src/lib/server/cluster-naming.ts).

## Duplicates

**Manage → Duplicates** groups tracks by normalised title, first artist, and album.
Missing or inconsistent metadata can group different recordings. Review each group
before pruning. Title suffixes such as `Live at…` separate entries when present.

Pruning prefers a copy with an embedding. It averages available embeddings into
the keeper and marks other copies skipped.
See the [duplicate code](https://github.com/poesterlin/sole/blob/main/web/src/lib/server/duplicates.ts).
The [centering trigger](https://github.com/poesterlin/sole/blob/main/drizzle/0006_centered_embedding_trigger.sql)
recomputes the centered embedding after that write.

### History: the incomplete scan

Scanning more rows costs more database work.
I first limited the scan to clustered tracks and missed about two thirds of duplicates.
The scan now includes clustered and unclustered tracks.
Skipping an unembedded copy also removes it from pending worker tracks.

A skipped track keeps its `cluster_id`. Pruning affects recommendations and future
clustering. Use the [Rust CLI](https://github.com/poesterlin/sole/blob/main/clustering-rs/README.md)
to recompute assignments. Indexing preserves `track.skip`.
The Duplicates page can restore skipped tracks.

Recommendation queries also check `skipped_songs`, the listener's exclusion list.
That list is separate from the maintenance flag `track.skip`.

## Runtime

The web process serves snippets using `ffmpeg` and a read-only music mount.
The API worker needs neither a music mount nor a database connection.
Scheduled maintenance runs in the web process through `Bun.cron`.
See the [scheduler](https://github.com/poesterlin/sole/blob/main/web/src/lib/server/scheduler.ts).
Each web replica starts its own scheduler. Run one replica to avoid duplicate jobs.

`deploy.sh` fetches the configured branch and rebuilds the stack on the deployment host.
