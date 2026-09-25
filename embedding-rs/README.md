# Rust embedding worker

This directory contains the staged migration of the OpenL3 embedding worker from
Python to Rust. The runtime target is OpenL3 `0.4.2` / `mel256` / `music` /
512 dimensions, matching `embeddings/generate-local-embeddings.py`.

The Python files under `tools/` are development/build helpers only:

- `capture-openl3-reference.py` captures deterministic vectors for parity tests.
- `export-openl3-onnx.py` converts the network portion of the upstream weights
  to an ONNX file. The Rust worker will own the audio frontend and will not
  invoke Python.

The current reference fixture uses a 2-second excerpt so the test can run
without storing copyrighted audio in the repository. The source path is
resolved from the configured audio directory; the fixture stores hashes and the
expected 512-dimensional result.

The generated network artifact is intentionally not committed. Export it into
`embedding-rs/models/openl3-mel256-music.onnx` using the development helper;
`embedding-rs/model-lock.json` pins its SHA-256 and graph shape. The runtime
never imports TensorFlow, Keras, or Python.

After exporting the artifact, a read-only worker smoke test is:

```sh
docker compose --profile embedding-rust run --rm embedding-rust \
  worker \
  --model /models/openl3-mel256-music.onnx \
  --metadata /app/model-lock.json \
  --audio-dir /music \
  --dry-run --limit 10 --report /artifacts/embedding-dry-run.jsonl
```

The worker is dry-run unless both `--write` and `--confirm-write` are passed.
The default inference backend is the validated `tract` path. The production
image also includes the optional CPU ONNX Runtime backend; select it explicitly
with `--backend ort` for benchmarking or a controlled cutover experiment.
`MUSIC_EMBEDDING_THREADS` can optionally cap the tract/ONNX Runtime CPU
executor (the default is `min(available CPUs, 8)`). In three sequential
8-CPU runs, median end-to-end times for 2/10/60 seconds were `1.60/9.60/57.15s`
for tract and `1.07/6.46/37.94s` for ONNX Runtime; the Python 60-second
reference is about `27.9s`. Host load and CPU limits materially affect the
end-to-end numbers. See
[`PLAN.md`](./PLAN.md) and [`fixtures/backend-benchmark.json`](./fixtures/backend-benchmark.json)
for the benchmark protocol and decision boundary.

See [`PLAN.md`](./PLAN.md) for the rollout gates and safety boundary.
