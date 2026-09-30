#!/usr/bin/env python3
"""Generate local OpenL3 embeddings with restartable, single-writer batches.

The worker is intentionally conservative:

* an advisory lock prevents two writers from processing the library at once;
* ``job_run`` stores a durable keyset cursor and bounded failure details;
* audio/model work happens outside database transactions;
* only the short vector-write transaction is committed per batch;
* the OpenL3 model is loaded once and stage-level timings are emitted at exit.

Run locally with CPU::

    python embeddings/generate-local-embeddings.py

The existing centered-embedding trigger remains responsible for deriving
``embedding_centered`` from the raw vector written by this worker.
"""

from __future__ import annotations

import argparse
import math
import os
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, NoReturn, Sequence

import librosa
import numpy as np
import soundfile as sf
import soxr

try:
    import psycopg2
    from psycopg2.extras import DictCursor
except ImportError:  # API mode does not need PostgreSQL bindings.
    psycopg2 = None  # type: ignore[assignment]
    DictCursor = None  # type: ignore[assignment]

EMBEDDING_SIZE = 512
# Recorded on the embedding space so a vector is attributable to the model that
# produced it. Must match `embedding_space.model`.
EMBEDDING_MODEL = "openl3-512"
TARGET_SAMPLE_RATE = 48_000
DEFAULT_DURATION_SECONDS = 90.0
# OpenL3 is frame-based, so the hop decides how many one-second windows get mean
# pooled and therefore what the pooled vector averages over. At 0.1 a 90s clip
# yields ~896 heavily overlapping windows. Raising the hop removes duplicated
# work, which is why it is recorded per embedding rather than treated as a
# tuning knob.
# The worker API pages at most 32 keysets per request.
MAX_API_PAGE_SIZE = 32
# Must match EMBEDDING_MODES[DEFAULT_MODE]. The CLI resolves the effective hop
# through the mode table and never reads this constant, so the two drift apart
# silently if they disagree.
DEFAULT_HOP_SECONDS = 0.5
# The OpenL3 frontend this worker loads. Recorded on the embedding space so a
# vector can be attributed to the implementation that produced it; API mode
# declares the same value on every upload.
EMBEDDING_FRONTEND = "kapre"

# Quality/speed presets. The numbers are measured, not guessed: on a 10-core
# CPU over a 60s clip, hop 0.1 was the original baseline, 0.5 is ~4.8x faster
# for a mean pooled-similarity shift of ~0.004, and 1.0 is ~8.9x for ~0.012.
# Retrieval order survives all three (identical rank-1 neighbours, 100% top-5
# overlap), so these trade speed against how finely the vector samples the
# track, not against whether Sole still works. Those ratios were measured
# against a 60s clip; the sample length is now 90s, which does not change the
# per-window cost but means ~1.5x as many windows per track.
EMBEDDING_MODES = {
    "low": 0.1,
    "medium": 0.5,
    "high": 1.0,
}
# `medium` rather than `low`: the 0.1 baseline existed because OpenL3 defaults to
# it, not because it was chosen here. Embedding a whole library is dominated by
# duplicated overlapping windows, and the measured cost of the coarser hop is
# ~0.004 mean pooled-similarity with retrieval order intact. Anything that wants
# the finer sampling can pass --mode low explicitly.
DEFAULT_MODE = "medium"
DEFAULT_BATCH_SIZE = 8
# OpenL3's own default is 32 one-second windows per model.predict call. Each
# window is one second of 48 kHz mono audio, so the default is safe on CPU and
# leaves plenty of headroom on a 16 GB GPU; raise it when a GPU is saturated.
DEFAULT_INFER_BATCH_SIZE = 64
MAX_INFER_BATCH_SIZE = 1024
DEFAULT_LOCK_KEY = 0x4D555331454D4201
DEFAULT_JOB_NAME = "python-local-embeddings"
# API mode is the only mode left: local mode resolved audio by matching track
# titles against filenames, which does not work against the sanitised names
# the music providers write. The app does the matching now.
DEFAULT_SOURCE_MODE = "api"
DEFAULT_WORKER_PREFETCH_WORKERS = 4
DEFAULT_WORKER_PREFETCH_DEPTH = 4
DEFAULT_WORKER_DOWNLOAD_TIMEOUT = 60.0
DEFAULT_WORKER_DOWNLOAD_RETRIES = 3
DEFAULT_WORKER_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024
MAX_FAILURE_DETAILS = 100
# A healthy bounded run reports "pending tracks remain" with status 2, and
# argparse reports usage mistakes with that same status 2. Callers such as the
# Colab worker treat 2 as expected, so a bad flag or environment would be
# indistinguishable from a clean dry run. Configuration errors therefore exit
# with EX_USAGE instead.
USAGE_EXIT_CODE = 64
SUPPORTED_EXTENSIONS = (".mp3", ".flac", ".wav", ".m4a", ".ogg")
openl3: Any = None


class _ArgumentParser(argparse.ArgumentParser):
    """Argument parser that never reports usage errors as a pending run."""

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(USAGE_EXIT_CODE, f"{self.prog}: error: {message}\n")








def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc


def env_float(name: str, default: float | None = None) -> float | None:
    """Read a float from the environment.

    ``default`` is optional so a caller can distinguish "unset" from a real
    value. ``--hop`` uses that: it is absent unless EMBEDDING_HOP_SECONDS is set,
    so --mode decides the hop unless the user deliberately overrode it.
    """
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {value!r}") from exc


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean, got {value!r}")


def positive_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return parsed


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def parse_args(
    argv: Sequence[str] | None = None, *, default_source_mode: str | None = None
) -> argparse.Namespace:
    parser = _ArgumentParser(
        description="Generate OpenL3 embeddings locally or through the worker API."
    )
    source_default = (
        default_source_mode
        if default_source_mode is not None
        else os.getenv("EMBEDDING_SOURCE_MODE", DEFAULT_SOURCE_MODE)
    )
    source_default = str(source_default).strip().lower() or DEFAULT_SOURCE_MODE
    parser.add_argument(
        "--source-mode",
        "--source",
        dest="source_mode",
        choices=("local", "api"),
        default=source_default,
        help="Source mode: local PostgreSQL/filesystem or authenticated worker API",
    )
    parser.add_argument(
        "--duration",
        type=positive_float,
        default=env_float("EMBEDDING_DURATION_SECONDS", DEFAULT_DURATION_SECONDS),
        help="Maximum audio seconds to analyze",
    )

    parser.add_argument(
        "--mode",
        # `type` runs before `choices`, so a value from an env var written by a
        # person (" Medium ") is accepted rather than failing overnight.
        type=lambda value: value.strip().lower(),
        choices=tuple(EMBEDDING_MODES),
        default=(os.getenv("EMBEDDING_MODE") or DEFAULT_MODE).strip().lower(),
        help=(
            "How finely to sample each track. low = the original, most "

            "detail and slowest; high = fastest and coarsest. medium is the "

            "balanced one. Changing this re-embeds new tracks with a new "

            "recipe, so old and new vectors are not directly comparable."
        ),
    )
    parser.add_argument(
        "--hop",
        type=positive_float,
        default=env_float("EMBEDDING_HOP_SECONDS"),
        help=(
            "Override the window hop in seconds. Rarely needed; --mode "

            "covers the useful range. Overrides --mode when both are given."
        ),
    )
    parser.add_argument(
        "--audio-backend",
        choices=("fast", "librosa"),
        default=os.getenv("EMBEDDING_AUDIO_BACKEND", "fast"),
        help="Audio path: fast uses soundfile/soxr; librosa restores the legacy path",
    )
    parser.add_argument(
        "--batch-size",
        type=positive_int,
        default=env_int("EMBEDDING_BATCH_SIZE", DEFAULT_BATCH_SIZE),
        help=(
            "Tracks fetched and checkpointed per keyset page (max 32 in API mode); "
            "unrelated to inference batching, see --infer-batch-size"
        ),
    )
    parser.add_argument(
        "--infer-batch-size",
        type=positive_int,
        default=env_int("EMBEDDING_INFER_BATCH_SIZE", DEFAULT_INFER_BATCH_SIZE),
        help="One-second windows per OpenL3 model.predict call (higher saturates a GPU)",
    )
    parser.add_argument(
        "--max-errors",
        type=nonnegative_int,
        default=env_int("EMBEDDING_MAX_ERRORS", 0),
        help="Stop after this many failures; zero means continue",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        default=env_bool("EMBEDDING_FAIL_FAST", False),
        help="Stop on the first track failure",
    )
    parser.add_argument(
        "--limit",
        type=nonnegative_int,
        default=None,
        help="Optional maximum number of tracks examined in this invocation",
    )
    parser.add_argument(
        "--restart",
        action="store_true",
        help="Ignore an unfinished checkpoint and start a fresh run",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and profile work without writing job_run, embeddings, or state",
    )
    parser.add_argument(
        "--worker-url",
        default=os.getenv("WORKER_URL"),
        help="Worker API base URL (API mode; defaults to WORKER_URL)",
    )
    parser.add_argument(
        "--worker-token",
        default=os.getenv("WORKER_TOKEN"),
        help="Bearer token for the worker API (prefer WORKER_TOKEN)",
    )
    parser.add_argument(
        "--prefetch-workers",
        type=positive_int,
        default=env_int("EMBEDDING_PREFETCH_WORKERS", DEFAULT_WORKER_PREFETCH_WORKERS),
        help="Maximum network download threads in API mode",
    )
    parser.add_argument(
        "--prefetch-depth",
        type=positive_int,
        default=env_int("EMBEDDING_PREFETCH_DEPTH", DEFAULT_WORKER_PREFETCH_DEPTH),
        help="Maximum queued or downloaded snippets in API mode",
    )
    parser.add_argument(
        "--download-timeout",
        type=positive_float,
        default=env_float(
            "EMBEDDING_DOWNLOAD_TIMEOUT", DEFAULT_WORKER_DOWNLOAD_TIMEOUT
        ),
        help="Per-request API/audio timeout in seconds",
    )
    parser.add_argument(
        "--download-retries",
        type=nonnegative_int,
        default=env_int(
            "EMBEDDING_DOWNLOAD_RETRIES", DEFAULT_WORKER_DOWNLOAD_RETRIES
        ),
        help="Retries for transient API/audio requests",
    )
    parser.add_argument(
        "--download-max-bytes",
        type=positive_int,
        default=env_int(
            "EMBEDDING_DOWNLOAD_MAX_BYTES", DEFAULT_WORKER_DOWNLOAD_MAX_BYTES
        ),
        help="Maximum bytes accepted for one audio snippet",
    )
    state_default = os.getenv("EMBEDDING_STATE_FILE") or None
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path(state_default).expanduser() if state_default else None,
        help="Optional API cursor/progress state file",
    )
    parser.add_argument(
        "--after",
        default=None,
        help="Optional initial API keyset cursor (ignored when state has one)",
    )
    args = parser.parse_args(argv)

    args.source_mode = str(args.source_mode).strip().lower()
    if args.source_mode != "api":
        parser.error(
            "--source-mode must be api: local mode was removed because it could "
            "not match track titles to the sanitised filenames the music "
            "providers write. The app resolves them instead."
        )
    if args.audio_backend not in {"fast", "librosa"}:
        parser.error("--audio-backend must be fast or librosa")
    if args.batch_size > MAX_API_PAGE_SIZE:
        page_limit = MAX_API_PAGE_SIZE
        parser.error(
            f"--batch-size is the keyset page and write batch (max {page_limit}) "
            "and is not the OpenL3 predict batch. To change inference batching use "
            "--infer-batch-size or EMBEDDING_INFER_BATCH_SIZE."
        )
    if args.duration <= 0 or not math.isfinite(args.duration):
        parser.error("--duration must be positive and finite")

    # A bad EMBEDDING_MODE reaches us as an argparse default, which argparse
    # cannot validate, so check it here where the message can be useful.
    if args.mode not in EMBEDDING_MODES:
        parser.error(
            "--mode must be one of "
            + ", ".join(sorted(EMBEDDING_MODES))
            + f" (got {args.mode!r})"
        )

    if args.hop is None:
        args.hop = EMBEDDING_MODES[args.mode]
    else:
        print(
            f"note: --hop {args.hop} overrides --mode {args.mode!r} "

            f"(which means {EMBEDDING_MODES[args.mode]}s)"
        )
    if args.hop <= 0 or not math.isfinite(args.hop):
        parser.error("--hop must be positive and finite")
    if args.hop > args.duration:
        parser.error(
            "--hop must not exceed --duration; every window would be a repeat "
            "of the same audio"
        )
    if args.max_errors < 0:
        parser.error("--max-errors must be zero or greater")
    if args.infer_batch_size < 1 or args.infer_batch_size > MAX_INFER_BATCH_SIZE:
        parser.error(
            f"--infer-batch-size must be between 1 and {MAX_INFER_BATCH_SIZE}"
        )
    if args.source_mode == "api":
        if args.prefetch_workers < 1 or args.prefetch_workers > 64:
            parser.error("--prefetch-workers must be between 1 and 64")
        if args.prefetch_depth < 1 or args.prefetch_depth > 128:
            parser.error("--prefetch-depth must be between 1 and 128")
        if args.download_timeout <= 0 or not math.isfinite(args.download_timeout):
            parser.error("--download-timeout must be positive and finite")
        if args.download_retries < 0 or args.download_retries > 20:
            parser.error("--download-retries must be between 0 and 20")
        if args.download_max_bytes < 1 or args.download_max_bytes > 2 * 1024 * 1024 * 1024:
            parser.error("--download-max-bytes must be between 1 and 2147483648")
        if args.after is not None:
            if not isinstance(args.after, str) or not args.after or len(args.after) > 2048:
                parser.error(
                    "--after must be a non-empty string of at most 2048 characters"
                )
        if not isinstance(args.worker_url, str) or not args.worker_url.strip():
            parser.error("--worker-url or WORKER_URL is required in API mode")
        if not isinstance(args.worker_token, str) or not args.worker_token.strip():
            parser.error("--worker-token or WORKER_TOKEN is required in API mode")
        if args.duration > 120:
            parser.error("--duration must be 120 seconds or less in API mode")
    return args




def short_error(error: BaseException) -> str:
    message = f"{type(error).__name__}: {error}".replace("\n", " ").strip()
    return message[:1_000]


def validate_embedding(value: Any) -> np.ndarray:
    vector = np.asarray(value, dtype=np.float32).reshape(-1)
    if vector.size != EMBEDDING_SIZE:
        raise ValueError(
            f"embedding has {vector.size} dimensions; expected {EMBEDDING_SIZE}"
        )
    if not np.isfinite(vector).all():
        raise ValueError("embedding contains NaN or infinite values")
    return vector




class StageStats:
    """Small wall-clock collector that keeps enough samples for percentiles."""

    def __init__(self) -> None:
        self.samples: dict[str, list[float]] = defaultdict(list)

    def add(self, stage: str, seconds: float) -> None:
        if math.isfinite(seconds) and seconds >= 0:
            self.samples[stage].append(float(seconds))

    @staticmethod
    def _percentile(values: Sequence[float], percentile: float) -> float:
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * percentile) - 1))
        return ordered[index]

    def summary(self) -> dict[str, dict[str, float | int]]:
        result: dict[str, dict[str, float | int]] = {}
        for stage, values in sorted(self.samples.items()):
            result[stage] = {
                "count": len(values),
                "total_seconds": sum(values),
                "mean_seconds": statistics.fmean(values),
                "p50_seconds": statistics.median(values),
                "p95_seconds": self._percentile(values, 0.95),
                "max_seconds": max(values),
            }
        return result








def configure_tensorflow_threads() -> dict[str, int]:
    """Apply optional TensorFlow thread limits before model initialization."""
    import tensorflow as tf

    configured: dict[str, int] = {}
    intra = env_int("EMBEDDING_TF_INTRA_THREADS", 0)
    inter = env_int("EMBEDDING_TF_INTER_THREADS", 0)
    if intra > 0:
        try:
            tf.config.threading.set_intra_op_parallelism_threads(intra)
            configured["intra"] = intra
        except RuntimeError as error:
            print(f"warning: could not set TensorFlow intra-op threads: {error}")
    if inter > 0:
        try:
            tf.config.threading.set_inter_op_parallelism_threads(inter)
            configured["inter"] = inter
        except RuntimeError as error:
            print(f"warning: could not set TensorFlow inter-op threads: {error}")
    return configured


def load_openl3_model(stats: StageStats) -> Any:
    global openl3
    import_started = time.perf_counter()
    import openl3 as openl3_module

    stats.add("openl3_import", time.perf_counter() - import_started)
    openl3 = openl3_module
    started = time.perf_counter()
    model = openl3.models.load_audio_embedding_model(
        "mel256", "music", EMBEDDING_SIZE, frontend=EMBEDDING_FRONTEND
    )
    stats.add("model_load", time.perf_counter() - started)
    return model


def load_audio(
    audio_path: str | Path, duration: float, backend: str = "fast"
) -> tuple[np.ndarray, int, str]:
    """Load audio quickly while retaining librosa-compatible behavior.

    ``librosa.load`` uses libsndfile for MP3/FLAC but its cached mono helper
    hashes the full multi-megabyte buffer. Reading and averaging the same
    libsndfile frames directly is much faster and byte-identical for the
    supported formats. Unsupported containers fall back to librosa/audioread.
    """
    path = str(audio_path)
    if backend == "librosa":
        audio, sample_rate = librosa.load(
            path, sr=None, mono=True, duration=duration
        )
        return audio, int(sample_rate), "librosa"

    try:
        with sf.SoundFile(path) as sound_file:
            sample_rate = int(sound_file.samplerate)
            frame_count = int(duration * sample_rate)
            frames = sound_file.read(
                frames=frame_count,
                dtype="float32",
                always_2d=True,
            )
        if frames.size == 0:
            raise ValueError("decoder returned empty audio")
        audio = np.mean(frames, axis=1, dtype=np.float32)
        return audio, sample_rate, "soundfile"
    except (OSError, RuntimeError, ValueError):
        audio, sample_rate = librosa.load(
            path, sr=None, mono=True, duration=duration
        )
        return audio, int(sample_rate), "librosa"


def resample_audio(
    audio: np.ndarray, original_rate: int, target_rate: int
) -> np.ndarray:
    """Match librosa's soxr_hq output without its large-array cache overhead."""
    if original_rate == target_rate:
        return audio

    ratio = float(target_rate) / original_rate
    expected = math.ceil(len(audio) * ratio)
    resampled = np.asarray(
        soxr.resample(audio, original_rate, target_rate, quality="HQ"),
        dtype=audio.dtype,
    )
    if len(resampled) < expected:
        return np.pad(resampled, (0, expected - len(resampled)))
    return resampled[:expected]


def process_audio_file(
    audio_path: str | Path,
    model: Any,
    duration: float,
    audio_backend: str,
    stats: StageStats,
    infer_batch_size: int = DEFAULT_INFER_BATCH_SIZE,
    hop_seconds: float = DEFAULT_HOP_SECONDS,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Decode, resample, infer, and mean-pool one local audio file."""
    track_started = time.perf_counter()
    timings: dict[str, Any] = {}

    started = time.perf_counter()
    try:
        audio, sample_rate, decoder = load_audio(
            audio_path, duration, audio_backend
        )
    finally:
        timings["decode_seconds"] = time.perf_counter() - started
        stats.add("audio_decode", timings["decode_seconds"])

    timings["decoder"] = decoder
    timings["resampler"] = "none"
    if audio is None or len(audio) == 0:
        raise ValueError("decoder returned empty audio")
    if sample_rate is None or int(sample_rate) <= 0:
        raise ValueError("decoder returned an invalid sample rate")
    sample_rate = int(sample_rate)

    started = time.perf_counter()
    try:
        if sample_rate != TARGET_SAMPLE_RATE:
            if audio_backend == "librosa":
                audio = librosa.resample(
                    audio, orig_sr=sample_rate, target_sr=TARGET_SAMPLE_RATE
                )
                timings["resampler"] = "librosa"
            else:
                audio = resample_audio(audio, sample_rate, TARGET_SAMPLE_RATE)
                timings["resampler"] = "soxr"
            sample_rate = TARGET_SAMPLE_RATE
    finally:
        timings["resample_seconds"] = time.perf_counter() - started
        stats.add("audio_resample", timings["resample_seconds"])

    if openl3 is None:
        raise RuntimeError("OpenL3 is not loaded; call load_openl3_model first")

    started = time.perf_counter()
    try:
        embeddings, _ = openl3.get_audio_embedding(
            audio,
            sample_rate,
            model=model,
            embedding_size=EMBEDDING_SIZE,
            batch_size=infer_batch_size,

            hop_size=hop_seconds,
            verbose=0,
        )
    finally:
        timings["inference_seconds"] = time.perf_counter() - started
        stats.add("model_inference", timings["inference_seconds"])
    timings["infer_batch_size"] = infer_batch_size
    timings["hop_seconds"] = hop_seconds
    timings["max_sample_seconds"] = duration
    if embeddings is None or len(embeddings) == 0:
        raise ValueError("OpenL3 returned no frame embeddings")
    if np.asarray(embeddings).ndim != 2 or np.asarray(embeddings).shape[1] != EMBEDDING_SIZE:
        raise ValueError(
            f"OpenL3 returned shape {np.asarray(embeddings).shape}; "
            f"expected (frames, {EMBEDDING_SIZE})"
        )

    started = time.perf_counter()
    try:
        vector = validate_embedding(np.mean(embeddings, axis=0))
    finally:
        timings["pool_seconds"] = time.perf_counter() - started
        stats.add("mean_pool", timings["pool_seconds"])

    timings["total_seconds"] = time.perf_counter() - track_started
    stats.add("track_total", timings["total_seconds"])
    return vector, timings






























def run(args: argparse.Namespace) -> int:
    if str(getattr(args, "source_mode", DEFAULT_SOURCE_MODE)).strip().lower() == "api":
        try:
            from worker_api import run_api_worker
        except ModuleNotFoundError as error:
            if error.name != "worker_api":
                raise
            from embeddings.worker_api import run_api_worker

        return run_api_worker(sys.modules[__name__], args)

    if str(getattr(args, "source_mode", DEFAULT_SOURCE_MODE)).strip().lower() != "api":
        # Local mode resolved audio by matching track titles against filenames,
        # and only stripped a leading "NN - " from them. Music Assistant
        # providers sanitise filenames -- Plex replaces /, :, ? and \" with
        # "_", escapes a trailing dot, and strips diacritics -- so those keys
        # never matched and every lookup failed. The worker API has the server
        # do the matching instead (web/src/lib/server/audio-library.ts), which is
        # the only implementation that handles it, so this path is gone rather
        # than left as a broken opt-in.
        raise ValueError(
            "local mode has been removed: it could not match files to tracks. "
            "Use --source-mode api, which fetches audio from the app."
        )


def main(
    argv: Sequence[str] | None = None, *, default_source_mode: str | None = None
) -> int:
    try:
        args = parse_args(argv, default_source_mode=default_source_mode)
        return run(args)
    except KeyboardInterrupt:
        print("embedding worker interrupted; the unfinished checkpoint is resumable", flush=True)
        return 130
    except Exception as error:
        print(f"embedding worker startup failed: {short_error(error)}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
