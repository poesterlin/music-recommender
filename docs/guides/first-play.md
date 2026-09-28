# First playable vibe

The app's **Setup** page walks the whole sequence and shows where it has got to. For most installs, open it and let it run: it checks the database, asks Music Assistant for your library, indexes the tracks, waits while they are analysed, then groups them into vibes and gives each one a name.

Two parts need your decision, because they depend on where the work should run.

## Analyse the library

Embedding is the slow part: a worker reads a minute of each track and turns it into a vector. The public stack runs a loop in the background. A local install starts only the app and the database, so start a worker when you are ready:

```sh
docker compose --profile worker up -d
```

It runs in API mode, which means it downloads snippets from the app and uploads vectors back — it never needs access to your files, and you can stop it at any time with `docker compose --profile worker down`.

## Create the centered space

Once at least two tracks are analysed, the app needs a *centered space*: the average vector of your library, which every similarity comparison is measured against. Until it exists, search and clustering have nothing to work from.

Open **Worker** and use **Create the centered space** — that button appears when the space is missing, and **Preview** tells you what it would change before you commit. The same step from a terminal, on a deployment whose database your machine can reach:

```sh
bun run db:ensure-centered
```

**Worker** shows both counts. A high number of embedded tracks with zero centered is not ready for the next step.

## Group into vibes

Clustering is deliberately explicit, and it never renumbers an existing generation — your names are attached to cluster ids, so re-running clustering without naming the new generation would strand every name on the wrong vibe.

**Setup → Group tracks into vibes** derives a sensible cluster count from the size of your library and runs it in the app. On the full stack you can instead benchmark a count of your choosing, which is worth doing on a large library:

```sh
docker compose --profile clustering run --rm clusterer-bun benchmark \
  --k 12 --pca-dim 32 --evaluation-dim 32 --runs 3 --record-run \
  --output /artifacts/first-run.json \
  --assignments /artifacts/first-assignments.jsonl
```

`--k` is how many clusters to aim for, `--runs 3` repeats the fit and reports how stable it is, and the two output files are the report and the per-track assignment list. This writes nothing to your library; applying is a separate, validated step. Take the run id it prints:

```sh
docker compose --profile clustering run --rm clusterer \
  --apply-run-id 4 --apply-assignments /artifacts/first-assignments.jsonl --confirm-apply
```

The repository's `clustering-rs/README.md` covers the quality checks, validation, and rollback.

## Then

Return to **Vibe** to listen through the clusters and rename them to something you recognise. **Manage → Full tidy-up** keeps things current afterwards: it assigns newly analysed tracks to the centroids you already have, and leaves every existing assignment alone.
