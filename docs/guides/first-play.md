# First playable vibe

The app's **Setup** page shows progress. These are distinct jobs: importing a catalog does not create audio embeddings, and embeddings do not create clusters.

## 1. Import

After both integrations are configured, go to **Manage → Full tidy-up**. It syncs Music Assistant, imports new tracks, and assigns already-embedded tracks **if centroids exist**. Check **Worker** for the resulting track count.

## 2. Embed and center

On the public Compose stack, the default embedding loop runs in the background. On the local web-only stack, start a bounded embedding job when your music is mounted:

```sh
docker compose --project-name sole-local --env-file .env.local --profile embedding run --rm embeddings
```

After at least two raw embeddings exist, establish the centered space. Use the database URL for the stack you are working on:

```sh
# Public deployment, with DATABASE_URL configured for host commands:
bun run db:ensure-centered

# Local stack (instead of the command above):
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.local)" bun --no-env-file run db:ensure-centered
```

**Worker** shows both embedded and centered counts. A high embedded percentage with zero centered tracks is not ready for clustering.

## 3. Create clusters

Initial clustering is an explicit operation. Set `COMPOSE` for your stack:

```sh
# Public deployment:
COMPOSE='docker compose'

# Or, for the local install:
COMPOSE='docker compose --project-name sole-local --env-file .env.local'
```

Benchmark and record an artifact. This does **not** change assignments:

```sh
$COMPOSE --profile clustering run --rm clusterer-bun benchmark \
  --k 12 --pca-dim 32 --evaluation-dim 32 --runs 3 --record-run \
  --output /artifacts/first-run.json \
  --assignments /artifacts/first-assignments.jsonl
```

Use the run ID printed by that command. Validate before applying; set the number first:

```sh
RUN_ID=4 # replace with your recorded run ID
$COMPOSE --profile clustering run --rm clusterer \
  --apply-run-id "$RUN_ID" --apply-assignments /artifacts/first-assignments.jsonl --validate-apply
$COMPOSE --profile clustering run --rm clusterer \
  --apply-run-id "$RUN_ID" --apply-assignments /artifacts/first-assignments.jsonl --confirm-apply
```

The repository's `clustering-rs/README.md` covers quality checks and rollback. Once centroids and assignments exist, return to **Vibe** to choose and name clusters. **Manage → Full tidy-up** can then assign newly embedded tracks to those centroids.
