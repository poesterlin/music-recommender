# Bun/WASM clustering engine

This crate is a small raw-ABI adapter around the numerical core in
`clustering-rs/src/lib.rs`. It is compiled to WebAssembly and loaded by Bun.

The adapter deliberately has no PostgreSQL or apply/rollback code. Bun reads
vectors, calls the WASM compute function, and writes artifacts. The native
`clusterer` remains the only component that applies live assignments or
restores a previous generation.

## Build

```sh
bun run clusters:wasm:build
```

The default artifact is:

```text
clustering-wasm/target/wasm32-unknown-unknown/release/clustering_wasm.wasm
```

## Run

```sh
bun run clusters:bun -- \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 3 \
  --output /tmp/cluster-report.json \
  --assignments /tmp/cluster-assignments.jsonl
```

For a recorded artifact that can be passed to the native apply validator, add
`--record-run`. The Bun command never applies the artifact itself.

## Docker

```sh
docker compose --profile clustering run --rm clusterer-bun benchmark \
  --k 50 \
  --pca-dim 32 \
  --evaluation-dim 32 \
  --runs 3 \
  --output /artifacts/bun-k50.json
```

The service is one-shot, non-root, and uses the same `cluster-artifacts` volume
as the native clusterer.

The native service is intentionally still used for apply/rollback. The parity
check compares quality metrics and partition ARI, but does not require
identical label integers because WASM and native floating-point execution can
choose different equivalent local optima. Bun is the canonical compute engine;
the native service consumes its already-written artifact.
