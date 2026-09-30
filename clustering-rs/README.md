# Rust clustering benchmark

The CLI compares current clusters with principal component analysis (PCA)
and spherical k-means. PCA reduces embedding dimensions.
Spherical k-means groups embeddings by direction.

The default benchmark leaves cluster assignments unchanged.
`--record-run` writes a report row. Apply and rollback use explicit flags.
See [database and CLI code](src/main.rs).

It uses the existing `track.embedding_centered` vectors. It does not run OpenL3 or generate recommendations/playback.

## Requirements

- Rust 1.78 or newer
- A reachable PostgreSQL database containing the existing centered embeddings
- `DATABASE_URL`, or `--database-url`

## Run

From the repository root:

```sh
cd clustering-rs
cargo run --release -- \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 3 \
  --threads 4 \
  --output /tmp/music-cluster-benchmark.json
```

The command reads `DATABASE_URL` from the environment and prints these metrics:

- Timing and inertia: the total squared distance to cluster centres.
- Mean similarity within clusters.
- Approximate silhouette score: separation from neighbouring clusters.
- Adjusted Rand index (ARI): agreement with current assignments, adjusted for chance.

Multiple runs also report pairwise ARI to show variation between runs.
Keep `--evaluation-dim 32` when comparing different training dimensions.
This measures each result in the same embedding space.
`--sample` limits rows in SQL, so sampled runs do not load the whole library.

To export the best result without applying it:

```sh
cargo run --release -- \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 3 \
  --threads 4 \
  --output /tmp/music-cluster-benchmark.json \
  --assignments /tmp/music-cluster-assignments.jsonl
```

The JSONL file contains `uri`, `name`, and a zero-based `clusterId`. It is only a dry-run artifact; nothing is written to PostgreSQL.

## Useful experiments

Benchmark the source space without PCA:

```sh
cargo run --release -- --k 50 --pca-dim 0 --runs 3
```

Use a smaller deterministic sample for a quick speed test:

```sh
cargo run --release -- --sample 5000 --k 50 --runs 2
```

Compare several cluster counts by running the command repeatedly with different `--k` values. Keep the same `--seed` when comparing runs.

## Docker batch profile

The one-shot native `clusterer` service runs benchmarks, targeted splits,
artifact validation, apply, and rollback. It does not publish a port.

Benchmark example:

```sh
docker compose --profile clustering run --rm clusterer \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 10 \
  --record-run \
  --output /artifacts/cluster-run.json \
  --assignments /artifacts/cluster-assignments.jsonl
```

The report is persisted in the `cluster_run` table only when `--record-run` is supplied. The JSON artifacts are kept in the `cluster-artifacts` Docker volume. The command remains a dry run: it never updates `track.cluster_id` or `cluster_centroid`.

To inspect the artifacts after a one-shot container exits, use a temporary shell in the same volume:

```sh
docker compose --profile clustering run --rm --entrypoint sh clusterer \
  -c 'ls -lh /artifacts && cat /artifacts/cluster-run.json'
```

## Validated apply and rollback

Apply is deliberately separate from benchmarking. First validate the recorded artifact without writing:

```sh
docker compose --profile clustering run --rm clusterer \
  --apply-run-id 4 \
  --apply-assignments /artifacts/k50-assignments.jsonl \
  --validate-apply
```

After reviewing the validation output, apply it with an explicit acknowledgement:

```sh
docker compose --profile clustering run --rm clusterer \
  --apply-run-id 4 \
  --apply-assignments /artifacts/k50-assignments.jsonl \
  --confirm-apply
```

Apply replaces assignments, so review the validation report first.
The transaction checks that the artifact matches the recorded run.
It validates embedded tracks and cluster IDs.
It saves earlier assignments in `cluster_run_assignment` and centres in `cluster_centroid_backup`.
It then rebuilds active centres and marks the run `applied`.
Tracks without embeddings remain unchanged.
Validate rollback before restoring the earlier assignments:

```sh
docker compose --profile clustering run --rm clusterer \
  --rollback-run-id 4 \
  --validate-rollback
```

Then restore with:

```sh
docker compose --profile clustering run --rm clusterer \
  --rollback-run-id 4 \
  --confirm-rollback
```

## Legacy names and overlap matching

After an apply, generate durable display names by comparing each new cluster with the previous assignments stored in `cluster_run_assignment`:

```sh
bun run clusters:match -- 4
```

Matching selects the previous cluster with the largest track overlap.
A previous cluster can match multiple new clusters.
Stored confidence and related IDs expose ambiguous matches.
Matching does not renumber cluster IDs.

A targeted split can create a new generation without renumbering the other clusters:

```sh
docker compose --profile clustering run --rm clusterer \
  --split-cluster-id 48 \
  --split-output /artifacts/k51-assignments.jsonl \
  --split-report /artifacts/k51-split-report.json \
  --split-runs 10 \
  --split-seed 4242 \
  --record-run
```

The command records a `split` run but does not apply it. Validate and apply that run with `--validate-apply` and `--confirm-apply`, just like a benchmark artifact. The previous generation remains available through the normal rollback audit. Generate overlap-based name suggestions with:

```sh
bun run clusters:match -- <run-id>
```

Choose the final names in the app's cluster naming UI; the tooling does not assume
any particular library, genre, or cluster ID.

Accepted and automatic names live in `cluster_name`, keyed by generation and
cluster ID. Overlap matches are suggestions only. Auto-naming fills missing or
reset names from the three dominant artists and never overwrites an existing
name. Names from previous generations remain available when rolling back.

The [numerical core](src/lib.rs) has no PostgreSQL dependency.
The [database and CLI code](src/main.rs) uses dependencies behind the `cli` feature.

From the repository root, `bun run clusters:native -- --help` exposes all native
options. `bun run clusters:docker -- --help` uses the same CLI in Docker.

Native parallel assignments are enabled by the default `rayon` feature; use `--threads N` to pin the worker count for repeatable performance tests. To check the portable core without the CLI or Rayon:

```sh
cargo test --no-default-features
```

Before applying assignments, compare repeated runs and inspect cluster sizes.
Preview representative tracks and review name suggestions in the app.
