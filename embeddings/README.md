# Local Python embedding worker

`generate-local-embeddings.py` is the production fallback for filling missing
OpenL3 vectors from the local audio library.

## Safety and recovery

- A PostgreSQL advisory lock prevents concurrent writers.
- Each committed batch advances a durable cursor in `job_run.detail`.
- Audio and model work happens outside the write transaction.
- Successful vectors are written with `WHERE embedding IS NULL`, so a manual or
  newer writer is never overwritten.
- A failed track is recorded in the bounded job detail and retried on the next
  invocation; unexpected failures leave the job unfinished so it can resume.
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

The Compose profile runs the same command. Useful environment variables are:

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
