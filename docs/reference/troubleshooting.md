# Troubleshooting

Find the visible symptom below, then run its checks.
Commands use the starter stack's `compose.yaml`.
For `setup.sh` installs, add `-f stack.yaml` after `docker compose`.

## Login POST returns `403`

An `ORIGIN` mismatch can cause SvelteKit to reject form requests.
Set `ORIGIN` in `.env` to your browser's URL, including scheme and port.
Run `docker compose up -d web`, then reload the login page.

## Setup reports a Music Assistant connection error

Missing credentials or network access prevent library indexing.
Set `MUSIC_HOST` and `MA_TOKEN` in `.env`.
Run `docker compose up -d web` and refresh **Setup**.
Read `docker compose logs --tail=100 web` for connection failures.
Check that Music Assistant is reachable from the container network.

## Worker receives `401`

The worker credential is missing, stale, or revoked.
Check `WORKER_TOKEN` in the worker and web environments.
A remote worker can instead use an active `worker` key from **API keys**.
Read `docker compose logs --tail=100 worker` after correcting the key.

## Worker audio returns `404`

The web app cannot resolve the indexed track to a mounted file.
Check that `MUSIC_LIBRARY_PATH` contains that track's file.
Read `docker compose logs --tail=100 web` for lookup failures.
Compare Music Assistant's reported path with the mounted directory tree.
A remote API worker does not need its own music mount.

## No recent uploads, or tracks remain pending

The worker may be processing a page, sleeping between passes, or stopped.
Open **Worker** at `/status` and read its logs:

```sh
docker compose logs --tail=100 worker
time docker compose run --rm --entrypoint python worker \
  worker.py --source-mode api --dry-run --limit 10
```

The dry run computes embeddings without uploading them.
Exit `2` means tracks remain. See [worker exit codes](https://github.com/poesterlin/sole/blob/main/embeddings/README.md#exit-codes).

## A remote worker cannot reach `127.0.0.1`

That address points to the worker machine itself.
Set `WORKER_URL` to a Sole address reachable from that machine.
Use the public address or a tunnel for Colab.

## Tracks appear, but no vibe plays

Indexing alone does not create playable clusters.
Check **Worker** for embeddings and centered embeddings.
Follow [Your first playable vibe](/guides/first-play) to create and name clusters.
If Music Assistant cannot play the same track, fix its playback connection first.

## PostgreSQL reports a missing `vector` extension

The database needs pgvector before migrations can create embedding columns.
Run the extension helper with a role allowed to install it:

```sh
docker compose run --rm --entrypoint bun web scripts/ensure-pgvector.ts
```

## Migration reports `relation "track" already exists`

The schema may exist without a Drizzle migration ledger.
Inspect the schema and ledger before running the full migration again.
Replaying migrations can attempt to recreate existing tables.

## Worker track listing returns `500` after an upgrade

A missing `embedding_settings` table can cause this failure.
Check the deployed database from the web container:

```sh
docker compose exec web bun -e 'import postgres from "postgres"; const s=postgres(process.env.DATABASE_URL); console.log(JSON.stringify(await s`SELECT to_regclass(${"public.embedding_settings"}) AS settings_table`)); await s.end();'
```

A null result means the table is missing.
For an up-to-date migration ledger, run `bun run db:migrate` from the checkout.
For an existing schema with an empty ledger, review
[migration 0017](https://github.com/poesterlin/sole/blob/main/drizzle/0017_embedding_settings.sql)
against the schema first. If only that table is missing, apply that migration:

```sh
docker compose exec web bun -e 'import postgres from "postgres"; const s=postgres(process.env.DATABASE_URL); const migration=await Bun.file("drizzle/0017_embedding_settings.sql").text(); await s.begin(async tx => { await tx.unsafe(migration); }); await s.end();'
```

This command does not populate the migration ledger.
If the table exists, inspect `docker compose logs --tail=100 web` for the actual error.
