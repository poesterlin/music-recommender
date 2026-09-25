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
import json
import math
import os
import re
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
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
TARGET_SAMPLE_RATE = 48_000
DEFAULT_DURATION_SECONDS = 60.0
DEFAULT_BATCH_SIZE = 8
# OpenL3's own default is 32 one-second windows per model.predict call. Each
# window is one second of 48 kHz mono audio, so the default is safe on CPU and
# leaves plenty of headroom on a 16 GB GPU; raise it when a GPU is saturated.
DEFAULT_INFER_BATCH_SIZE = 64
MAX_INFER_BATCH_SIZE = 1024
DEFAULT_LOCK_KEY = 0x4D555331454D4201
DEFAULT_JOB_NAME = "python-local-embeddings"
DEFAULT_SOURCE_MODE = "local"
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


class LockNotAcquired(RuntimeError):
    """Raised when another worker owns the singleton advisory lock."""


class StopRun(RuntimeError):
    """Raised for a requested fail-fast/max-errors stop."""


def require_postgres_bindings() -> None:
    """Require the optional PostgreSQL dependency for local mode only."""
    if psycopg2 is None or DictCursor is None:
        raise RuntimeError(
            "local embedding mode requires psycopg2; install psycopg2-binary "
            "or use --source-mode api"
        )


def env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc


def env_float(name: str, default: float) -> float:
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
        "--database-url",
        default=os.getenv("DATABASE_URL"),
        help="PostgreSQL URL (local mode; defaults to DATABASE_URL)",
    )
    parser.add_argument(
        "--audio-dir",
        type=Path,
        default=Path(os.getenv("AUDIO_DIR", "/music")),
        help="Root directory containing local audio files (local mode)",
    )
    parser.add_argument(
        "--duration",
        type=positive_float,
        default=env_float("EMBEDDING_DURATION_SECONDS", DEFAULT_DURATION_SECONDS),
        help="Maximum audio seconds to analyze",
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
        "--job-name",
        default=os.getenv("EMBEDDING_JOB_NAME", DEFAULT_JOB_NAME),
        help="job_run name used for the local durable checkpoint",
    )
    parser.add_argument(
        "--lock-key",
        type=int,
        default=env_int("EMBEDDING_LOCK_KEY", DEFAULT_LOCK_KEY),
        help="PostgreSQL bigint advisory-lock key (local mode)",
    )
    parser.add_argument(
        "--max-errors",
        type=nonnegative_int,
        default=env_int("EMBEDDING_MAX_ERRORS", 0),
        help="Stop after this many failures; zero means continue",
    )
    parser.add_argument(
        "--db-retries",
        type=positive_int,
        default=env_int("EMBEDDING_DB_RETRIES", 3),
        help="Retries for transient PostgreSQL errors (local mode)",
    )
    parser.add_argument(
        "--db-retry-delay",
        type=float,
        default=env_float("EMBEDDING_DB_RETRY_DELAY", 1.0),
        help="Initial exponential retry delay in seconds (local mode)",
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
    if args.source_mode not in {"local", "api"}:
        parser.error("--source-mode must be local or api")
    if args.audio_backend not in {"fast", "librosa"}:
        parser.error("--audio-backend must be fast or librosa")
    if args.batch_size > (32 if args.source_mode == "api" else 512):
        page_limit = 32 if args.source_mode == "api" else 512
        parser.error(
            f"--batch-size is the keyset page and write batch (max {page_limit} in "
            f"{args.source_mode} mode) and is not the OpenL3 predict batch. To change "
            "inference batching use --infer-batch-size or "
            "EMBEDDING_INFER_BATCH_SIZE."
        )
    if not args.job_name.strip():
        parser.error("--job-name must not be empty")
    if not -(2**63) <= args.lock_key < 2**63:
        parser.error("--lock-key must fit in a signed PostgreSQL bigint")
    if args.duration <= 0 or not math.isfinite(args.duration):
        parser.error("--duration must be positive and finite")
    if args.db_retry_delay < 0 or not math.isfinite(args.db_retry_delay):
        parser.error("--db-retry-delay must be a finite non-negative number")
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
    elif not args.database_url:
        parser.error("--database-url or DATABASE_URL is required in local mode")
    return args


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def vector_literal(value: Any) -> str:
    vector = validate_embedding(value)
    return "[" + ",".join(f"{float(x):.8f}" for x in vector) + "]"


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


def sanitize(name: Any) -> str:
    if not isinstance(name, str):
        return ""
    return name.replace("/", "_").replace(":", "_").replace("?", "_").strip()


def build_file_index(base_path: Path | str) -> dict[str, list[str]]:
    base = Path(base_path)
    if not base.exists():
        raise FileNotFoundError(f"audio directory does not exist: {base}")

    index: dict[str, list[str]] = {}
    for root, dirs, files in os.walk(base):
        dirs.sort()
        for filename in sorted(files):
            name_part, extension = os.path.splitext(filename)
            if extension.lower() not in SUPPORTED_EXTENSIONS:
                continue

            path = os.path.join(root, filename)
            name_lower = name_part.lower()
            index.setdefault(name_lower, []).append(path)

            match = re.match(r"^(\d{2})\s*-\s*(.+)$", name_part, re.IGNORECASE)
            if match:
                alternate = match.group(2).lower()
                index.setdefault(alternate, []).append(path)

    print(f"Indexed {len(index)} unique track names from {base}", flush=True)
    return index


def find_local_audio_file(
    track_metadata: dict[str, Any], file_index: dict[str, list[str]]
) -> str | None:
    track_name = sanitize(track_metadata.get("name"))
    artist_names = track_metadata.get("artist", [])
    if isinstance(artist_names, str):
        artist_names = [artist_names]
    artist_names = [sanitize(value) for value in artist_names if value]

    if not track_name or not artist_names:
        return None

    candidates = file_index.get(track_name.lower(), [])
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    album_name = sanitize(track_metadata.get("album", ""))
    if album_name:
        album_lower = album_name.lower()
        for path in candidates:
            if album_lower in path.lower():
                return path
    return candidates[0]


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
        "mel256", "music", EMBEDDING_SIZE, frontend="kapre"
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
            verbose=0,
        )
    finally:
        timings["inference_seconds"] = time.perf_counter() - started
        stats.add("model_inference", timings["inference_seconds"])
    timings["infer_batch_size"] = infer_batch_size

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


def parse_detail(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def serialize_detail(detail: dict[str, Any]) -> str:
    return json.dumps(detail, sort_keys=True, separators=(",", ":"))


def acquire_single_writer_lock(conn: Any, lock_key: int) -> None:
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT pg_try_advisory_lock(%s)", (lock_key,))
        acquired = bool(cursor.fetchone()[0])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
    if not acquired:
        raise LockNotAcquired(
            f"another embedding worker holds advisory lock {lock_key}"
        )


def release_single_writer_lock(conn: Any, lock_key: int) -> None:
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT pg_advisory_unlock(%s)", (lock_key,))
        conn.commit()
    except Exception:
        conn.rollback()
    finally:
        cursor.close()


def retry_db_operation(
    conn: Any,
    operation: Any,
    attempts: int,
    initial_delay: float,
    label: str,
) -> Any:
    require_postgres_bindings()
    retryable = (psycopg2.OperationalError, psycopg2.InterfaceError)
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except retryable as error:
            try:
                conn.rollback()
            except Exception:
                pass
            if attempt >= attempts:
                raise
            delay = initial_delay * (2 ** (attempt - 1))
            print(
                f"transient database error during {label}; retry {attempt}/{attempts - 1} "
                f"in {delay:.1f}s: {short_error(error)}",
                flush=True,
            )
            if delay > 0:
                time.sleep(delay)


def connect_database(
    database_url: str, attempts: int, initial_delay: float
) -> Any:
    require_postgres_bindings()
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return psycopg2.connect(
                database_url,
                connect_timeout=env_int("DATABASE_CONNECT_TIMEOUT", 10),
                application_name=os.getenv("EMBEDDING_JOB_NAME", DEFAULT_JOB_NAME),
            )
        except psycopg2.OperationalError as error:
            last_error = error
            if attempt >= attempts:
                raise
            delay = initial_delay * (2 ** (attempt - 1))
            print(
                f"database connection failed; retry {attempt}/{attempts - 1} "
                f"in {delay:.1f}s: {short_error(error)}",
                flush=True,
            )
            if delay > 0:
                time.sleep(delay)
    assert last_error is not None
    raise last_error


def start_or_resume_job(
    conn: Any, job_name: str, restart: bool
) -> tuple[int, dict[str, Any]]:
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT id, detail
            FROM job_run
            WHERE job = %s AND finished_at IS NULL
            ORDER BY id DESC
            LIMIT 1
            """,
            (job_name,),
        )
        row = cursor.fetchone()
        if row and not restart:
            detail = parse_detail(row[1])
            detail["resumed_at"] = utc_now()
            cursor.execute(
                "UPDATE job_run SET started_at = NOW(), detail = %s WHERE id = %s",
                (serialize_detail(detail), row[0]),
            )
            conn.commit()
            return int(row[0]), detail

        if row and restart:
            cursor.execute(
                """
                UPDATE job_run
                SET finished_at = NOW(), ok = FALSE, detail = %s
                WHERE id = %s
                """,
                (serialize_detail({"restarted_at": utc_now()}), row[0]),
            )

        initial = {
            "cursor": None,
            "processed": 0,
            "failed": 0,
            "failures": [],
            "started_at": utc_now(),
        }
        cursor.execute(
            """
            INSERT INTO job_run (job, started_at, detail)
            VALUES (%s, NOW(), %s)
            RETURNING id
            """,
            (job_name, serialize_detail(initial)),
        )
        job_id = int(cursor.fetchone()[0])
        conn.commit()
        return job_id, initial
    except Exception as error:
        conn.rollback()
        if error.__class__.__name__ == "UndefinedTable":
            raise RuntimeError(
                "job_run table is missing; run the database migrations before embedding"
            ) from error
        raise
    finally:
        cursor.close()


def fetch_page(conn: Any, after: str | None, limit: int) -> list[dict[str, Any]]:
    require_postgres_bindings()
    cursor = conn.cursor(cursor_factory=DictCursor)
    try:
        if after is None:
            cursor.execute(
                """
                SELECT uri, name, artist, album
                FROM track
                WHERE embedding IS NULL
                  AND (skip IS NULL OR skip = FALSE)
                ORDER BY uri COLLATE "C"
                LIMIT %s
                """,
                (limit,),
            )
        else:
            cursor.execute(
                """
                SELECT uri, name, artist, album
                FROM track
                WHERE embedding IS NULL
                  AND (skip IS NULL OR skip = FALSE)
                  AND (uri COLLATE "C") > (%s::text COLLATE "C")
                ORDER BY uri COLLATE "C"
                LIMIT %s
                """,
                (after, limit),
            )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.commit()
        return rows
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()


def count_unembedded(conn: Any) -> int:
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT count(*)::bigint
            FROM track
            WHERE embedding IS NULL
              AND (skip IS NULL OR skip = FALSE)
            """
        )
        count = int(cursor.fetchone()[0])
        conn.commit()
        return count
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()


def write_batch(
    conn: Any,
    job_id: int,
    updates: Sequence[tuple[str, str]],
    detail: dict[str, Any],
) -> tuple[int, int]:
    """Write vectors and advance the cursor in one short transaction."""
    cursor = conn.cursor()
    written = 0
    conflicts = 0
    try:
        for uri, literal in updates:
            cursor.execute(
                """
                UPDATE track
                SET embedding = %s::vector, updated_at = NOW()
                WHERE uri = %s AND embedding IS NULL
                """,
                (literal, uri),
            )
            if cursor.rowcount == 1:
                written += 1
            else:
                conflicts += 1

        checkpoint = dict(detail)
        checkpoint["processed"] = int(checkpoint.get("processed", 0) or 0) + written
        checkpoint["last_batch_written"] = written
        checkpoint["last_batch_conflicts"] = conflicts
        checkpoint["checkpointed_at"] = utc_now()
        cursor.execute(
            """
            UPDATE job_run
            SET started_at = NOW(), detail = %s
            WHERE id = %s
            """,
            (serialize_detail(checkpoint), job_id),
        )
        conn.commit()
        return written, conflicts
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()


def finish_job(conn: Any, job_id: int, ok: bool, detail: dict[str, Any]) -> None:
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            UPDATE job_run
            SET finished_at = NOW(), ok = %s, detail = %s
            WHERE id = %s
            """,
            (ok, serialize_detail(detail), job_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()


def record_unexpected_failure(
    conn: Any, job_id: int | None, error: BaseException, detail: dict[str, Any]
) -> None:
    if job_id is None:
        return
    try:
        conn.rollback()
        detail = dict(detail)
        detail["last_error"] = short_error(error)
        detail["last_error_at"] = utc_now()
        cursor = conn.cursor()
        try:
            cursor.execute(
                "UPDATE job_run SET started_at = NOW(), detail = %s WHERE id = %s",
                (serialize_detail(detail), job_id),
            )
            conn.commit()
        finally:
            cursor.close()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass


def track_failure(
    failures: list[dict[str, Any]], track: dict[str, Any], error: BaseException
) -> None:
    failures.append(
        {
            "uri": track.get("uri"),
            "name": track.get("name"),
            "error": short_error(error),
            "at": utc_now(),
        }
    )
    if len(failures) > MAX_FAILURE_DETAILS:
        del failures[:-MAX_FAILURE_DETAILS]


def run(args: argparse.Namespace) -> int:
    if str(getattr(args, "source_mode", DEFAULT_SOURCE_MODE)).strip().lower() == "api":
        try:
            from worker_api import run_api_worker
        except ModuleNotFoundError as error:
            if error.name != "worker_api":
                raise
            from embeddings.worker_api import run_api_worker

        return run_api_worker(sys.modules[__name__], args)

    require_postgres_bindings()
    run_started = time.perf_counter()
    stats = StageStats()
    conn: Any | None = None
    lock_acquired = False
    job_id: int | None = None
    detail: dict[str, Any] = {}
    written_this_run = 0
    inferred_this_run = 0
    failures_this_run = 0
    examined_this_run = 0
    limit_reached = False

    try:
        conn = connect_database(
            args.database_url, args.db_retries, args.db_retry_delay
        )
        conn.autocommit = False
        acquire_single_writer_lock(conn, args.lock_key)
        lock_acquired = True
        print(f"Acquired singleton embedding lock {args.lock_key}", flush=True)

        index_started = time.perf_counter()
        file_index = build_file_index(args.audio_dir)
        stats.add("file_index", time.perf_counter() - index_started)

        if not args.dry_run:
            job_id, detail = start_or_resume_job(conn, args.job_name, args.restart)
            print(f"job_run_id={job_id} action={'restart' if args.restart else 'resume'}", flush=True)
        else:
            detail = {
                "cursor": None,
                "processed": 0,
                "failed": 0,
                "failures": [],
                "dry_run": True,
            }
            print("dry-run: no job_run or embedding writes will be made", flush=True)

        thread_config = configure_tensorflow_threads()
        if thread_config:
            print(f"TensorFlow thread limits: {thread_config}", flush=True)
        model = load_openl3_model(stats)
        cursor_uri = detail.get("cursor") if isinstance(detail.get("cursor"), str) else None
        processed = int(detail.get("processed", 0) or 0)
        failed_total = int(detail.get("failed", 0) or 0)
        raw_failures = detail.get("failures", [])
        failures = list(raw_failures) if isinstance(raw_failures, list) else []
        after = cursor_uri

        while True:
            page_started = time.perf_counter()
            page = retry_db_operation(
                conn,
                lambda: fetch_page(conn, after, args.batch_size),
                args.db_retries,
                args.db_retry_delay,
                "page fetch",
            )
            stats.add("page_fetch", time.perf_counter() - page_started)
            if not page:
                break

            if args.limit is not None:
                remaining_limit = args.limit - examined_this_run
                if remaining_limit <= 0:
                    limit_reached = True
                    break
                if len(page) > remaining_limit:
                    page = page[:remaining_limit]
                    limit_reached = True

            page_last_uri = page[-1]["uri"]
            updates: list[tuple[str, str]] = []
            for track in page:
                examined_this_run += 1
                lookup_started = time.perf_counter()
                try:
                    audio_path = find_local_audio_file(track, file_index)
                finally:
                    stats.add("file_lookup", time.perf_counter() - lookup_started)

                if audio_path is None:
                    failure = ValueError("no local audio file matched")
                    track_failure(failures, track, failure)
                    failed_total += 1
                    failures_this_run += 1
                    print(
                        json.dumps(
                            {
                                "event": "track_failed",
                                "uri": track.get("uri"),
                                "reason": short_error(failure),
                            }
                        ),
                        flush=True,
                    )
                else:
                    try:
                        embedding, timings = process_audio_file(
                            audio_path,
                            model,
                            args.duration,
                            args.audio_backend,
                            stats,
                            args.infer_batch_size,
                        )
                        serialize_started = time.perf_counter()
                        literal = vector_literal(embedding)
                        stats.add("vector_serialize", time.perf_counter() - serialize_started)
                        updates.append((track["uri"], literal))
                        inferred_this_run += 1
                        print(
                            json.dumps(
                                {
                                    "event": "track_inferred",
                                    "uri": track.get("uri"),
                                    "path": str(audio_path),
                                    "timings": timings,
                                }
                            ),
                            flush=True,
                        )
                    except Exception as error:
                        track_failure(failures, track, error)
                        failed_total += 1
                        failures_this_run += 1
                        print(
                            json.dumps(
                                {
                                    "event": "track_failed",
                                    "uri": track.get("uri"),
                                    "path": str(audio_path),
                                    "reason": short_error(error),
                                }
                            ),
                            flush=True,
                        )

                if args.fail_fast and failures_this_run > 0:
                    raise StopRun("stopping after the first failure (--fail-fast)")
                if args.max_errors and failures_this_run >= args.max_errors:
                    raise StopRun(
                        f"stopping after {failures_this_run} failures (--max-errors)"
                    )

            # Advance the cursor only after every successful vector and the
            # failure details for this page are checkpointed together.
            after = page_last_uri
            detail = {
                "cursor": after,
                "processed": processed,
                "failed": failed_total,
                "failures": failures[-MAX_FAILURE_DETAILS:],
                "last_batch_at": utc_now(),
                "last_batch_written": len(updates),
            }
            batch_written = 0
            if args.dry_run:
                batch_written = 0
            else:
                write_started = time.perf_counter()
                batch_written, conflicts = retry_db_operation(
                    conn,
                    lambda: write_batch(conn, job_id, updates, detail),
                    args.db_retries,
                    args.db_retry_delay,
                    "batch write",
                )
                stats.add("database_batch_write", time.perf_counter() - write_started)
                processed += batch_written
                written_this_run += batch_written
                detail["last_batch_conflicts"] = conflicts

            print(
                f"batch cursor={after} inferred={len(updates)} written={batch_written} "
                f"processed={processed} failed={failed_total}",
                flush=True,
            )
            if limit_reached:
                break

        remaining = retry_db_operation(
            conn,
            lambda: count_unembedded(conn),
            args.db_retries,
            args.db_retry_delay,
            "remaining-count query",
        )
        complete = remaining == 0 and not limit_reached
        detail.update(
            {
                "cursor": after,
                "processed": processed,
                "failed": failed_total,
                "failures": failures[-MAX_FAILURE_DETAILS:],
                "remaining": remaining,
                "complete": complete,
                "finished_at": utc_now(),
            }
        )
        if not args.dry_run:
            retry_db_operation(
                conn,
                lambda: finish_job(conn, job_id, complete, detail),
                args.db_retries,
                args.db_retry_delay,
                "job completion",
            )

        print(
            json.dumps(
                {
                    "event": "run_summary",
                    "job_run_id": job_id,
                    "examined_this_run": examined_this_run,
                    "written_this_run": written_this_run,
                    "inferred_this_run": inferred_this_run,
                    "processed_total": processed,
                    "failed_total": failed_total,
                    "remaining": remaining,
                    "infer_batch_size": args.infer_batch_size,
                    "complete": complete,
                }
            ),
            flush=True,
        )
        return 0 if complete else 2

    except LockNotAcquired as error:
        print(f"embedding worker skipped: {error}", flush=True)
        return 0
    except StopRun as error:
        print(f"embedding worker stopped: {error}", flush=True)
        if conn is not None and job_id is not None:
            detail.update({"stopped_at": utc_now(), "stop_reason": short_error(error)})
            retry_db_operation(
                conn,
                lambda: finish_job(conn, job_id, False, detail),
                args.db_retries,
                args.db_retry_delay,
                "job stop",
            )
        return 2
    except Exception as error:
        record_unexpected_failure(conn, job_id, error, detail)
        print(f"embedding worker failed: {short_error(error)}", flush=True)
        return 1
    finally:
        stats.add("run_total", time.perf_counter() - run_started)
        print(
            "PROFILE "
            + json.dumps(
                {
                    "job_run_id": job_id,
                    "stages": stats.summary(),
                    "written_this_run": written_this_run,
                    "inferred_this_run": inferred_this_run,
                    "failures_this_run": failures_this_run,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        if conn is not None and lock_acquired:
            try:
                release_single_writer_lock(conn, args.lock_key)
            except Exception as error:
                print(f"warning: could not explicitly release lock: {short_error(error)}")
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


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
