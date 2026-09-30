# Python OpenL3 embedding worker

The worker computes embeddings from audio. It does not recommend or play tracks.

- **API mode** downloads snippets from Sole and uploads embeddings over HTTP.
  It needs no database connection, Music Assistant token, or music mount.
- **Local mode**, the default, reads audio files and writes directly to PostgreSQL.

## Requirements

Use Python `3.11` with `requirements.txt`, or the Docker image.
For Python `3.12` or newer, run `python embeddings/install_python312.py` first.
The installer verifies pinned archives and patches packaging for OpenL3 `0.4.2`
and resampy `0.2.2`. It does not change model code or versions.

API mode needs a reachable `WORKER_URL` and an active worker credential.
Local mode needs `DATABASE_URL` and access to the indexed audio files.

## Run API mode

Follow the [worker guide](../docs/guides/worker.md) for Compose and notebook steps.
From a source checkout with Python dependencies installed, run:

```sh
export WORKER_URL=https://sole.example.com
export WORKER_TOKEN='a-worker-scoped-key-from-the-web-ui'
python embeddings/worker.py --source-mode api --dry-run --limit 1
```

Remove `--dry-run` to upload embeddings. Remove `--limit 1` to process the backlog.
The app's **API keys** page provides a notebook and a Colab/Jupyter cell.
Both start with a one-track dry run.

## Worker API

The web app authenticates each endpoint with a worker credential:

- `GET /api/worker/tracks` returns a page of unembedded tracks.
- `GET /api/worker/audio` returns a bounded audio snippet.
- `POST /api/worker/embeddings` writes embeddings only into empty target rows.

See the [upload code](../web/src/routes/api/worker/embeddings/+server.ts)
for metadata checks, recipe checks, and conditional writes.
Existing embeddings remain unchanged when an upload is repeated.

Downloads use a bounded background pool. Inference runs sequentially.
The audio endpoint tries canonical, compact, then fuzzy filename matches.
It checks artist and album context before selecting a fallback.

## Cursor and recovery

Set `EMBEDDING_STATE_FILE` to persist the API worker cursor.
Successful pages save the cursor. Failed pages leave it unchanged for the next run.
See [API worker code](worker_api.py).

- **Audio returns `404`:** the worker emits `track_missing_audio` and advances past
  that track. Check the web mount and indexed path before marking it skipped.
  The track remains eligible for a later invocation.
- **A download times out or returns `5xx`:** the worker leaves the page unfinished.
  Check server logs and network access, then rerun it.
- **An upload is rejected:** inspect its error before retrying.
  A stale recipe or changed metadata can cause rejection.

`--restart` abandons an unfinished checkpoint and starts a new run.
In local mode, keep unfinished `job_run` rows unless you intend to abandon the run.
Audio decoding and inference happen outside database write transactions.
The worker writes raw embeddings. The database derives centered embeddings.

## Settings

API mode fetches the sampling recipe from the server before inference.
See [Embedding settings](../docs/reference/application.md#embedding-settings).
Local defaults below do not replace the server recipe.

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | — | Local-mode database connection |
| `EMBEDDING_DURATION_SECONDS` | `60` | Local per-track duration cap |
| `EMBEDDING_AUDIO_BACKEND` | `fast` | soundfile/soxr decoding; `librosa` selects the older path |
| `EMBEDDING_BATCH_SIZE` | `8` | Track page and write batch size |
| `EMBEDDING_INFER_BATCH_SIZE` | `64` | Audio windows per prediction call |
| `EMBEDDING_MAX_ERRORS` | `0` | Stop after this many failures; `0` continues |
| `EMBEDDING_FAIL_FAST` | `false` | Stop on the first failure |
| `EMBEDDING_TF_INTRA_THREADS` | `0` | TensorFlow threads within an operation |
| `EMBEDDING_TF_INTER_THREADS` | `0` | TensorFlow threads between operations |

API connection and download settings are:

- `WORKER_URL` and `WORKER_TOKEN`
- `EMBEDDING_PREFETCH_WORKERS` and `EMBEDDING_PREFETCH_DEPTH`
- `EMBEDDING_DOWNLOAD_TIMEOUT` and `EMBEDDING_DOWNLOAD_RETRIES`
- `EMBEDDING_DOWNLOAD_MAX_BYTES`
- `EMBEDDING_STATE_FILE`

`--batch-size` controls track pages and writes.
The server caps track pages at `32` and upload batches at `16`.
`--infer-batch-size` controls audio windows per model prediction call.
Each window contains one second of mono `48 kHz` audio.
Window count depends on the sampling hop and duration.

## Exit codes

`--dry-run` computes embeddings without writing embeddings or `job_run` rows.
It can exit `2` when unembedded tracks remain.

| Code | Meaning |
|---:|---|
| `0` | The run completed and no unembedded tracks remain |
| `2` | Tracks remain after a bounded or interrupted run |
| `64` | Arguments or environment were rejected before processing |

Other failures can return non-zero codes. Inspect the error and run summary.
The worker uses `64` for usage errors so callers can distinguish them from bounded runs.

## Profiling

The `PROFILE` JSON line reports count, total, mean, median, 95th percentile,
and maximum stage time. Per-track events report timings before the batch summary.
Stage names include:

- `audio_decode`, `audio_resample`, and `file_lookup`
- `openl3_import`, `model_load`, and `model_inference`
- `mean_pool` and `vector_serialize`
- `page_fetch` and `database_batch_write`

The [2026-09-25 profile](benchmark-profile.json) records a 60-second excerpt.
It took `0.088s` to decode, `0.021s` to resample, and `41.133s` for inference.
The record does not identify its hardware. Do not use it to predict another host's throughput.

The [2026-09-30 CPU benchmark](benchmark-cpu-2026-09-30.json) identifies an
AMD Ryzen 7 255. Three passes over one 90-second excerpt took `5.9s` median.
It used a reused model, a `0.5s` hop, and inference batch `64`.
It excludes startup, snippet generation, downloads, and uploads.

Compare inference batch sizes with bounded `--dry-run --limit 20` runs.
Try `128` or `256` on a GPU. Lower the batch size after an out-of-memory error.
Check `timings.infer_batch_size` and `run_summary` for the effective setting.
API snippets already use mono `48 kHz` audio, so resampling can report `none`.
