#!/usr/bin/env python3
"""Capture deterministic OpenL3 reference outputs for Rust parity tests.

This is a development-only fixture generator. It intentionally follows the
current Python worker exactly; it is not imported by the Rust runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import openl3
import soundfile as sf
import soxr
import tensorflow as tf


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def jsonable_vector(value: np.ndarray) -> list[float]:
    return [float(x) for x in value.astype(np.float32, copy=False).reshape(-1)]


def capture(path: Path, audio_dir: Path, duration: int | None, model: Any) -> dict[str, Any]:
    # Match generate-local-embeddings.py. librosa.load(duration=60) is
    # intentionally explicit because the production path uses a 60 second cap.
    audio, sr = librosa.load(
        str(path),
        sr=None,
        mono=True,
        duration=duration,
    )
    if audio is None or len(audio) == 0:
        raise ValueError(f"empty audio: {path}")

    original_sample_count = int(audio.shape[0])
    original_sr = int(sr)
    decoded_audio_sha256 = sha256_bytes(
        audio.astype(np.float32, copy=False).tobytes()
    )
    if sr != 48000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=48000)
        sr = 48000
    resampled_audio_sha256 = sha256_bytes(
        audio.astype(np.float32, copy=False).tobytes()
    )

    # The model is loaded once by OpenL3. Keep the call arguments identical to
    # the production worker.
    embeddings, timestamps = openl3.get_audio_embedding(
        audio,
        sr,
        model=model,
        embedding_size=512,
        verbose=0,
    )
    if embeddings is None or embeddings.shape[0] == 0:
        raise ValueError(f"OpenL3 returned no frames: {path}")

    mean = np.mean(embeddings, axis=0)
    if np.isnan(mean).any():
        raise ValueError(f"OpenL3 returned NaN: {path}")

    relative = str(path.relative_to(audio_dir))
    source_hash = sha256_bytes(path.read_bytes())
    return {
        "schema_version": 1,
        "path": relative,
        "source_sha256": source_hash,
        "source_sample_rate": original_sr,
        "decoded_sample_count": original_sample_count,
        "decoded_audio_sha256": decoded_audio_sha256,
        "resampled_sample_count": int(audio.shape[0]),
        "resampled_audio_sha256": resampled_audio_sha256,
        "frame_count": int(embeddings.shape[0]),
        "embedding_size": int(mean.shape[0]),
        "frame_embedding_sha256": sha256_bytes(
            embeddings.astype(np.float32, copy=False).tobytes()
        ),
        "mean_embedding_sha256": sha256_bytes(
            mean.astype(np.float32, copy=False).tobytes()
        ),
        "mean_embedding": jsonable_vector(mean),
        "timestamps": [float(x) for x in timestamps],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio-dir", default="/music")
    parser.add_argument("--output", required=True)
    parser.add_argument("--file", action="append", dest="files")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--duration", type=int, default=5)
    args = parser.parse_args()

    audio_dir = Path(args.audio_dir).resolve()
    if args.files:
        candidates = [Path(value).resolve() for value in args.files]
    else:
        candidates = sorted(
            p
            for p in audio_dir.rglob("*")
            if p.is_file()
            and p.suffix.lower() in {".mp3", ".flac", ".wav", ".m4a", ".ogg"}
        )
        if args.limit > 0:
            candidates = candidates[: args.limit]
    if not candidates:
        raise SystemExit("no supported audio files found")

    model = openl3.models.load_audio_embedding_model(
        "mel256", "music", 512, frontend="kapre"
    )
    fixtures = [
        capture(path, audio_dir, args.duration or None, model) for path in candidates
    ]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "openl3_version": getattr(openl3, "__version__", "unknown"),
                "librosa_version": librosa.__version__,
                "numpy_version": np.__version__,
                "tensorflow_version": tf.__version__,
                "keras_version": getattr(tf.keras, "version", lambda: "unknown")(),
                "soundfile_version": sf.__version__,
                "libsndfile_version": sf.__libsndfile_version__,
                "soxr_version": getattr(soxr, "__version__", "unknown"),
                "duration_seconds": args.duration,
                "fixtures": fixtures,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({"output": str(output), "fixtures": len(fixtures)}))


if __name__ == "__main__":
    main()
