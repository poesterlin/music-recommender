# Python OpenL3 embedding worker

The worker has two source modes:

- **local** (default): reads a mounted audio directory and writes PostgreSQL directly;
- **api**: asks an authenticated worker API for tracks and bounded audio snippets, then uploads vectors over HTTP.

The API mode needs no PostgreSQL URL, Music Assistant token, Home Assistant token, or audio mount. It is suitable for a separate VM, a container, or a Colab runtime.

Use Python 3.11 for the reference environment. On Python 3.12 or newer, run
`python embeddings/install_python312.py` first; it verifies the pinned source
archives and applies a packaging-only compatibility patch for OpenL3 0.4.2
and resampy 0.2.2. The model code and versions are unchanged.

## Safety and recovery

- Local mode uses a PostgreSQL advisory lock and durable `job_run.detail` cursor.
- API mode keeps its cursor in the optional state file and relies on the server's
  idempotent, no-overwrite upload endpoint.
- Audio and model work happens outside database write transactions.
- Successful vectors are written only when the target embedding is still empty,
  so a manual or newer writer is never overwritten.
- A failed page is not advanced in API mode and is retried on the next run.
- The centered vector is still derived by the database trigger; this worker
  writes only the raw `embedding` vector.

The default job name is `python-local-embeddings`. Use a different name only
for an intentionally separate run. Keep the default lock key unchanged for
all workers targeting the same database; changing it can allow concurrent
writers. The `job_run` table must exist before starting the worker.

## Run

```sh
python embeddings/generate-local-embeddings.py \
  --audio-dir /music \
  --duration 60 \
  --batch-size 8
```

## API worker mode

The web service exposes an authenticated broker for remote workers:

- `GET /api/worker/tracks` returns a bounded page of unembedded tracks;
- `GET /api/worker/audio` returns a short, server-generated audio snippet;
- `POST /api/worker/embeddings` accepts an idempotent batch of vectors.

Run it with:

```sh
export WORKER_URL=https://recommender.example.com
export WORKER_TOKEN='a-worker-scoped-key-from-the-web-ui'
python embeddings/worker.py --source-mode api
```

The worker downloads only the snippet needed for inference. Downloads run in a
bounded background pool while OpenL3 inference remains single-threaded. Failed
pages do not advance the saved cursor; successful pages checkpoint a local
state file when `EMBEDDING_STATE_FILE` is set. The web audio endpoint first uses
canonical filename matching, then a punctuation-insensitive compact match, and
finally a conservative fuzzy fallback for truncated titles and close typos;
artist/album context and a uniqueness margin prevent arbitrary matches.

Useful API-mode settings are `EMBEDDING_PREFETCH_WORKERS`,
`EMBEDDING_PREFETCH_DEPTH`, `EMBEDDING_DOWNLOAD_TIMEOUT`,
`EMBEDDING_DOWNLOAD_RETRIES`, and `EMBEDDING_DOWNLOAD_MAX_BYTES`.

The Compose `worker` profile runs this mode against `http://web:3000`:

```sh
docker compose --profile worker up -d worker
```

The API must be reachable from the worker, and its PostgreSQL/audio services
must be reachable from the web service. Keep the key out of source files and
shell history where possible. The web UI's **API keys** page provides a
Worker-scoped key and a copyable Colab/Jupyter cell. That cell uses a one-track
`--dry-run --limit 1` canary by default; remove those flags only when you are
ready to write embeddings. The bootstrap `WORKER_TOKEN` is still accepted for
unattended Compose jobs.

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `AUDIO_DIR` | `/music` | Local audio root |
| `EMBEDDING_DURATION_SECONDS` | `60` | Per-track duration cap |
| `EMBEDDING_AUDIO_BACKEND` | `fast` | `fast` uses parity-checked soundfile/soxr; `librosa` restores the legacy decoder/resampler path |
| `EMBEDDING_BATCH_SIZE` | `8` | Keyset page/write batch size |
| `EMBEDDING_JOB_NAME` | `python-local-embeddings` | Durable `job_run` name |
| `EMBEDDING_LOCK_KEY` | fixed bigint | Singleton advisory-lock key |
| `EMBEDDING_MAX_ERRORS` | `0` | Stop after N failures; zero continues |
| `EMBEDDING_FAIL_FAST` | `false` | Stop on the first failure |
| `EMBEDDING_TF_INTRA_THREADS` | `0` | Optional TensorFlow intra-op thread limit |
| `EMBEDDING_TF_INTER_THREADS` | `0` | Optional TensorFlow inter-op thread limit |
| `EMBEDDING_DB_RETRIES` | `3` | Transient PostgreSQL retry attempts |
| `EMBEDDING_DB_RETRY_DELAY` | `1.0` | Initial exponential retry delay in seconds |

API mode additionally uses `WORKER_URL`, `WORKER_TOKEN`,
`EMBEDDING_PREFETCH_WORKERS`, `EMBEDDING_PREFETCH_DEPTH`,
`EMBEDDING_DOWNLOAD_TIMEOUT`, `EMBEDDING_DOWNLOAD_RETRIES`,
`EMBEDDING_DOWNLOAD_MAX_BYTES`, and `EMBEDDING_STATE_FILE`.

`--dry-run` performs the file lookup, model work, and profiling without writing
`job_run` or embeddings. A bounded dry-run may exit with status `2` simply
because unembedded rows remain; that status is intentional and does not imply
that a write occurred. `--restart` intentionally abandons an unfinished
checkpoint and starts a new run. `--limit N` is useful for a bounded canary.

If a run ends with missing or failed tracks, it exits non-zero and leaves those
tracks eligible for the next invocation. Do not delete the unfinished
`job_run` row unless abandoning the run is intentional.

## Profiling

Every invocation ends with a `PROFILE` JSON line containing count, total, mean,
p50, p95, and maximum wall time for stages such as:

- `audio_decode`
- `audio_resample`
- `model_inference`
- `openl3_import`
- `mean_pool`
- `vector_serialize`
- `file_lookup`
- `page_fetch`
- `database_batch_write`
- `model_load`

Per-track timing events are also printed before the batch summary. These
measurements make it possible to distinguish decode/resampling bottlenecks
from OpenL3 inference and database overhead before changing runtime or worker
concurrency.

The default soundfile/soxr fast paths were checked against the librosa path on
representative MP3, FLAC, and M4A inputs: decoded samples and resampled samples
were byte-identical, with M4A correctly falling back to librosa/audioread. A
60-second dry-run profile on the test host showed approximately 0.10s decode,
0.03s resampling, 0.6s model load, and 38.5s OpenL3 inference. The inference
stage, rather than audio I/O, is currently the dominant cost.

See [`benchmark-profile.json`](./benchmark-profile.json) for the recorded read-only
60-second profile. The worker intentionally does not generate recommendations
or playback and does not rewrite existing embeddings.
