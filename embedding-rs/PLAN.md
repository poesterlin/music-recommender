# Rust OpenL3 embedding migration plan

## Goal

Replace the Python embedding worker with a Rust implementation while preserving
 the existing OpenL3 output closely enough for retrieval and clustering. The
migration is staged and does not write production embeddings until parity gates
pass.

## Current reference pipeline

The active Python path is `embeddings/generate-local-embeddings.py`:

1. `librosa.load(path, sr=None, mono=True, duration=60)`
2. Resample to 48 kHz when needed
3. `openl3.get_audio_embedding(..., embedding_size=512)`
4. Mean-pool the returned frame embeddings over time
5. Write the 512-dimensional vector to PostgreSQL

The pinned reference environment is OpenL3 `0.4.2`, Kapre `0.4.1`,
librosa `0.11.0`, NumPy `2.4.6`, TensorFlow `2.20.0`, Keras `3.13.2`,
libsndfile `1.2.2`, and soxr `1.1.0`. The selected model is
`openl3_audio_mel256_music.h5` (about 35 MB).

OpenL3 defaults to its Kapre frontend, not the separate librosa frontend:

- 48 kHz mono audio
- 1-second windows, 0.1-second hop
- centered/padded framing
- n_fft=2048, hop=242, 256 mel bins
- periodic Hann window and Slaney-normalized mel filters
- OpenL3's compatibility decibel layer with `amin=1e-10`
- convolutional network with batch normalization, ReLU, and max pooling
- final 32x24 pooling to a 512-dimensional embedding

## Implemented first cut

The `embedding-rs` crate now contains:

- direct libsndfile FFI decoding for the formats supported by the legacy
  librosa/soundfile path, with Symphonia fallback
- an ffmpeg/audioread-compatible fallback for M4A and other unsupported
  containers
- optional libsoxr HQ resampling, including librosa's floating-point length
  behavior
- exact OpenL3 centered framing and a Rust Kapre-compatible mel frontend
- parallel STFT-frame frontend execution and reusable tract execution state
- a frontend-free ONNX artifact loader using tract-onnx (the default backend)
- an optional CPU ONNX Runtime backend (`ort 2.0.0-rc.9`) with the same
  metadata/hash gate and batch-1 execution
- a pinned model metadata/hash check
- mean-pooled 512-dimensional inference and a dry-run-first PostgreSQL worker
- explicit `--write --confirm-write` batching with trigger/version checks
- a non-root Docker image and an opt-in Compose profile

Python remains only in the reference-capture and one-time model-export tools;
the Rust worker never imports or invokes it.

## Phases and gates

### 1. Reference fixtures — validated

Captured fixtures include decoded/resampled counts and hashes, frame counts,
the expected 512-dimensional vector, and source metadata. The repository now
contains a 21-file short-reference set and a full 60-second reference; source
audio is not committed.

### 2. Audio decode/resample — validated

- Direct libsndfile FFI decoding matches the Python decoded-audio hashes for
  the tested MP3 and FLAC files.
- libsoxr HQ resampling matches the Python resampled-audio hashes for those
  files.
- M4A uses ffmpeg/audioread-compatible decoding. The ffmpeg binary is still a
  separate versioned input for byte-identical M4A decoder parity, although the
  tested M4A embedding vectors are already high-parity.

### 3. Mel frontend — validated

On a deterministic 48-kHz synthetic WAV, the Rust frontend versus Kapre:

- correlation: `0.9999999989`
- mean absolute error: `0.0003535 dB`
- worst absolute error: `0.0711 dB`

### 4. Model inference — validated

The network-only ONNX graph runs without TensorFlow/Keras at runtime. The
validated default is `tract-onnx`; `ort 2.0.0-rc.9` is available behind the
`onnxruntime` feature and must be selected explicitly with `--backend ort`.
Both backends verify `model-lock.json` before loading the artifact. End-to-end
mean-vector comparisons against the pinned Python model include:

| Fixture set | Frames | Minimum cosine | Worst max abs error |
| --- | ---: | ---: | ---: |
| Synthetic WAV, 2 s | 16 | `0.99999994` | `0.000270` |
| MP3, 2 s | 17 | `0.999999989` | `0.002507` |
| MP3, 10 s | 97 | `0.999999999` | `0.000883` |
| MP3, 60 s | 597 | `0.99999999998` | `0.000114` |
| FLAC/M4A/MP3, 21-file set | 16–17 | `0.9999999877` | `0.002580` |

The 21-file set has average absolute component error `0.000039` for tract and
`0.0000389` for ONNX Runtime. The ONNX Runtime 60-second fixture produced
cosine `0.999999999976`, maximum absolute error `0.0001135`, and mean absolute
error `0.00000938`.

The model artifact is not committed to Git. `model-lock.json` pins its hash;
the artifact is mounted read-only at runtime. A same-file 60-second benchmark
measured about 27.9 seconds for the Python worker path and 56.5 seconds for
the original optimized tract path (the sequential frontend path was 82.1
seconds). In three sequential Docker runs with eight CPU threads, median
end-to-end times for 2/10/60 seconds were `1.60/9.60/57.15s` for tract and
`1.07/6.46/37.94s` for ONNX Runtime; a separate one-CPU run measured 47.31
versus 55.38 seconds for the 60-second fixture. These full-path numbers are
sensitive to host load, but the isolated network probe was repeatable: tract
was `77.9 ms/frame` median and static ONNX Runtime was `50.3 ms/frame` median
(an official dynamic ONNX Runtime library measured `40.4 ms/frame`).

Fixed tract batches of 4, 8, and 32 regressed network throughput by roughly
3–4x on this CPU, so the model path remains batch 1. The static ONNX Runtime
archive also needs a CPU-baseline check on any older deployment host. ORT is
therefore an opt-in performance experiment, not a cutover decision: tract
remains the default until the CPU/throughput gate is reproducible on the
deployment host.

### 5. Database worker — implemented, not applied

The worker defaults to dry-run and requires both `--write` and
`--confirm-write` for a live update. It:

- validates the centering trigger and active embedding space before work
- uses bounded keyset pages
- matches local audio deterministically
- embeds and validates vectors before opening a write transaction
- writes only `embedding`; the database trigger derives centered values
- locks/checks the active space and conditionally updates each row
- aborts the current transaction on metadata/eligibility/version conflicts

A bounded live read-only smoke test has passed: preflight found model
`openl3-512`, version `1`, and 25,910 tracks; known unembedded FLAC and M4A
URIs were matched and embedded in dry-run mode. No Rust worker write has been
run against the live database.

### 6. Cutover gates still required

The numerical parity gates above are complete. Before replacing
`embeddings-loop`:

1. run a broader read-only worker dry-run and inspect path decisions/reports
2. pin the ffmpeg version used for any byte-identical M4A decoder comparison
3. repeat the backend/parallelism benchmark on the deployment CPU limits and
   confirm the backlog throughput budget
4. stop the Python writer and run a small explicitly confirmed write batch
5. verify raw embedding, trigger-derived centered embedding, space version,
   and unchanged metadata/cluster IDs
6. retain the Python image as rollback

## Non-goals for the first cut

- no model architecture changes
- no new clustering or assignment logic
- no live database migration
- no replacement of the existing centered-space trigger
- no GPU requirement
- no overwrite/re-embed mode

## Current safety posture

The Python worker remains the production fallback. Tract remains the Rust
default, and the ONNX Runtime backend is opt-in only. The Rust embedding path
is additive until the parity, deployment-throughput, and write gates above are
complete.
