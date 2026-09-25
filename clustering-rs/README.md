# Rust clustering benchmark

A standalone benchmark for comparing the current cluster assignments with PCA plus spherical k-means. Benchmark mode is read-only; an explicit, confirmed apply mode can atomically install a recorded artifact and keeps rollback data.

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

The command reads `DATABASE_URL` from the environment. It prints timing, training inertia, fixed-space evaluation inertia, mean intra-cluster similarity, an approximate silhouette score, and adjusted Rand index against the current assignments. With multiple runs it also reports pairwise run ARI so local optima are visible. `--evaluation-dim` keeps quality metrics comparable when testing different training dimensions; use `--evaluation-dim 32` (the default) for consistent comparisons. Vectors are decoded from pgvector's `real[]` representation rather than JSON text, and `--sample` is pushed into SQL so quick experiments do not load the entire library.

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

The repository provides two one-shot services: `clusterer-bun` is the default
Bun/WASM numerical engine for benchmarks and targeted splits, while the native
`clusterer` service owns artifact validation, apply, and rollback. Neither
service publishes a port.

Bun/WASM benchmark example:

```sh
docker compose --profile clustering run --rm clusterer-bun benchmark \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 10 \
  --record-run \
  --output /artifacts/bun-cluster-run.json \
  --assignments /artifacts/bun-cluster-assignments.jsonl
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

The transaction requires the artifact to match the recorded run, validates every embedded track and cluster ID, snapshots the previous assignments and centroids in `cluster_run_assignment` and `cluster_centroid_backup`, rebuilds the active centroids, and marks the run `applied`. Unembedded wildcard tracks are left untouched. Rollback is also explicit; validate it first if needed:

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

Matching uses the dominant track-overlap for each new cluster. It intentionally allows a legacy cluster to map to multiple new clusters because reducing 60 clusters to 50 necessarily creates merges and splits. The stored confidence and related legacy IDs make ambiguous matches visible; the underlying k=50 cluster IDs are never renumbered.

A targeted split can create a new generation without renumbering the other clusters:

```sh
docker compose --profile clustering run --rm clusterer-bun split \
  --split-cluster-id 48 \
  --split-output /artifacts/k51-assignments.jsonl \
  --split-report /artifacts/k51-split-report.json \
  --split-runs 10 \
  --split-seed 4242 \
  --record-run
```

The command records a `split` run but does not apply it. Validate and apply that run with `--validate-apply` and `--confirm-apply`, just like a benchmark artifact. The previous generation remains available through the normal rollback audit. After listening to the split, provisional display names can be applied with:

```sh
bun run clusters:name-split
```

The numerical core is in `src/lib.rs`; the database and CLI are kept in `src/main.rs`. The library has no PostgreSQL dependency, and the CLI-only dependencies are behind the `cli` feature. This leaves the core suitable for a future WASM package.

Native parallel assignments are enabled by the default `rayon` feature; use `--threads N` to pin the worker count for repeatable performance tests. To check the portable core without the CLI or Rayon:

```sh
cargo test --no-default-features
```

The benchmark should be validated for cluster stability, silhouette, cluster-size balance, and manual cluster naming before any production assignment migration is considered.
