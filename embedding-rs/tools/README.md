# Development tools

These scripts are not part of the Rust worker image. The exact reference/export
packages are listed in `requirements-reference.txt`.

## Capture a reference vector

Run the script inside the pinned OpenL3 environment used by the legacy
worker. The audio path is resolved inside the container's `/music` mount:

```sh
python capture-openl3-reference.py \
  --audio-dir /music \
  --file '/music/Artist/Album/01 - Track.mp3' \
  --duration 2 \
  --output /tmp/openl3-reference.json
```

The resulting JSON contains the expected 512-value mean vector, frame count,
decoded/resampled sample counts, and hashes. It is suitable for a read-only
parity check.

## Export the network artifact

The upstream `.h5` file contains weights but no model architecture. In a
a disposable build environment with the pinned OpenL3 package and
`tf2onnx==1.17.0` installed, run:

```sh
python export-openl3-onnx.py \
  --weights /path/to/openl3_audio_mel256_music.h5 \
  --output embedding-rs/models/openl3-mel256-music.onnx \
  --metadata embedding-rs/model-lock.json
```

The export deliberately excludes the Kapre frontend. The Rust worker computes
that frontend and accepts the network-only tensor `[batch, 256, 199, 1]`.
Keep the ONNX and metadata files together, pin the metadata SHA-256, and mount
them read-only into the worker. The model is intentionally not committed to
Git because it is a large third-party binary artifact.

## Backend benchmark protocol

For a backend comparison, use the same ONNX file, audio fixture, CPU limits,
and container resources. The Rust `embed` command reports total, decode,
model-load, and inference phase timings. Record cold-start time (model load),
warm end-to-end wall time, peak RSS, and vector parity. Run at least three
repetitions for a 2-second, 10-second, and 60-second fixture, and include
MP3, FLAC, and M4A. A production image containing both backends can be
exercised without a database connection:

```sh
docker run --rm --cpus=8 -e MUSIC_EMBEDDING_THREADS=8 \
  -v /srv/music:/music:ro \
  -v "$PWD/embedding-rs/models:/models:ro" \
  music-recommender-embedding-rs:test embed \
  --audio '/music/Artist/Album/track.mp3' \
  --model /models/openl3-mel256-music.onnx \
  --metadata /models/model-lock.json \
  --backend tract --duration 60
```

Repeat with `--backend ort`; the production image's default remains `tract`
until the deployment-host throughput gate is met. Record both phase timings
and the vector comparison, and keep static batching out of the first
comparison: fixed tract batches regressed substantially on the test CPU.
