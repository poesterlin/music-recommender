"""Portable, authenticated API mode for the Python OpenL3 worker.

The local database/filesystem implementation lives in
``generate-local-embeddings.py``.  This module deliberately does not import that
file (its filename contains a hyphen) and does not import PostgreSQL bindings.
The entrypoint passes the already-loaded core module to :func:`run_api_worker`
so decoding, resampling, OpenL3 inference, validation, and profiling remain the
same code paths as local mode.
"""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

try:
    import requests
except ImportError:  # Keep the module importable in minimal local environments.
    requests = None  # type: ignore[assignment]


API_MODEL = "openl3-512"
EMBEDDING_SIZE = 512
MAX_PAGE_SIZE = 32
MAX_UPLOAD_BATCH = 16
MAX_AUDIO_SECONDS = 120.0
MAX_STATE_FAILURES = 100
TRACK_URI_MAX_LENGTH = 2048
DEFAULT_CHUNK_SIZE = 64 * 1024


class WorkerAPIError(RuntimeError):
    """An API request or response failed without exposing response credentials."""

    def __init__(self, message: str, status: int | None = None) -> None:
        self.status = status
        super().__init__(message)


class WorkerAPIValidationError(WorkerAPIError):
    """The server returned a response that cannot be safely processed."""


class AudioDownloadError(WorkerAPIError):
    """An audio snippet was empty, too large, or could not be downloaded."""


class WorkerStateError(RuntimeError):
    """The optional local state file is invalid or cannot be written."""


class RemoteStop(RuntimeError):
    """A resumable API-worker stop requested by a failure or limit."""


class PrefetchDownloadError(RuntimeError):
    """A network prefetch failed before the corresponding track was yielded."""

    def __init__(self, track: Mapping[str, Any], cause: BaseException) -> None:
        self.track = dict(track)
        self.cause = cause
        super().__init__("audio prefetch failed")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def redact_text(value: Any, secret: str | None = None) -> str:
    """Return short diagnostic text with bearer credentials removed."""

    text = str(value).replace("\n", " ").replace("\r", " ").strip()
    if secret:
        if len(secret) >= 4:
            text = text.replace(secret, "[REDACTED]")
        else:
            text = re.sub(
                rf"(?<!\w){re.escape(secret)}(?!\w)",
                "[REDACTED]",
                text,
            )
    text = re.sub(r"(?i)(bearer\s+)[^\s,;]+", r"\1[REDACTED]", text)
    return text[:1_000]


def _short_error(error: BaseException, secret: str | None = None) -> str:
    return redact_text(f"{type(error).__name__}: {error}", secret)


def _positive_float(value: Any, name: str, *, maximum: float | None = None) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError(f"{name} must be positive and finite")
    if maximum is not None and parsed > maximum:
        raise ValueError(f"{name} must be at most {maximum}")
    return parsed


def _nonnegative_int(value: Any, name: str, *, maximum: int | None = None) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{name} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise ValueError(f"{name} must be zero or greater")
    if maximum is not None and parsed > maximum:
        raise ValueError(f"{name} must be at most {maximum}")
    return parsed


def normalize_worker_url(value: str) -> str:
    """Validate a base URL and append the worker API prefix exactly once."""

    if not isinstance(value, str) or not value.strip():
        raise ValueError("worker URL must be a non-empty HTTP(S) URL")
    text = value.strip()
    if any(character.isspace() for character in text):
        raise ValueError("worker URL must not contain whitespace")
    try:
        parsed = urlsplit(text)
    except ValueError as exc:
        raise ValueError("worker URL is invalid") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("worker URL must use http or https and include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("worker URL must not contain embedded credentials")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("worker URL has an invalid port") from exc
    if parsed.query or parsed.fragment:
        raise ValueError("worker URL must not contain a query or fragment")
    path = parsed.path.rstrip("/")
    if path.endswith("/api/worker"):
        pass
    elif path.endswith("/api"):
        path = f"{path}/worker"
    else:
        path = f"{path}/api/worker"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def build_endpoint_url(base_url: str, resource: str) -> str:
    """Build a worker endpoint URL without allowing resource path injection."""

    root = normalize_worker_url(base_url)
    if not isinstance(resource, str) or not resource or "/" in resource:
        raise ValueError("worker resource must be a single path component")
    return f"{root}/{resource}"


def validate_track(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and copy the metadata needed for an embedding upload."""

    if not isinstance(value, Mapping):
        raise WorkerAPIValidationError("track metadata must be a JSON object")
    uri = value.get("uri")
    name = value.get("name")
    artist = value.get("artist")
    album = value.get("album")
    if not isinstance(uri, str) or not uri or len(uri) > TRACK_URI_MAX_LENGTH:
        raise WorkerAPIValidationError("track uri is invalid")
    if not isinstance(name, str):
        raise WorkerAPIValidationError(f"track {uri!r} has an invalid name")
    if not isinstance(artist, list) or any(not isinstance(item, str) for item in artist):
        raise WorkerAPIValidationError(f"track {uri!r} has invalid artist metadata")
    if not isinstance(album, str):
        raise WorkerAPIValidationError(f"track {uri!r} has an invalid album")
    result: dict[str, Any] = {
        "uri": uri,
        "name": name,
        "artist": list(artist),
        "album": album,
    }
    updated_at = value.get("updatedAt")
    if updated_at is not None:
        if not isinstance(updated_at, str):
            raise WorkerAPIValidationError(f"track {uri!r} has an invalid updatedAt")
        result["updatedAt"] = updated_at
    return result


def validate_tracks_response(
    payload: Mapping[str, Any], requested_limit: int | None = None
) -> dict[str, Any]:
    """Validate the tracks endpoint contract and return normalized page data."""

    if not isinstance(payload, Mapping):
        raise WorkerAPIValidationError("tracks response must be a JSON object")
    model = payload.get("model")
    if model is not None and model != API_MODEL:
        raise WorkerAPIValidationError(f"unsupported worker model: {model!r}")
    dimensions = payload.get("dimensions")
    if dimensions is not None and dimensions != EMBEDDING_SIZE:
        raise WorkerAPIValidationError(
            f"unsupported embedding dimensions: {dimensions!r}"
        )
    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list):
        raise WorkerAPIValidationError("tracks response is missing tracks")
    if requested_limit is not None and len(raw_tracks) > requested_limit:
        raise WorkerAPIValidationError("tracks response exceeded the requested limit")
    tracks = [validate_track(track) for track in raw_tracks]
    uris = [track["uri"] for track in tracks]
    if len(set(uris)) != len(uris):
        raise WorkerAPIValidationError("tracks response contains duplicate uris")
    derived_cursor = tracks[-1]["uri"] if tracks else None
    next_cursor = payload.get("nextCursor", derived_cursor)
    if next_cursor == "":
        next_cursor = None
    if next_cursor is not None and not isinstance(next_cursor, str):
        raise WorkerAPIValidationError("tracks response has an invalid nextCursor")
    if derived_cursor is not None and next_cursor != derived_cursor:
        raise WorkerAPIValidationError("tracks nextCursor does not match its last track")
    has_more = payload.get("hasMore")
    if has_more is not None and not isinstance(has_more, bool):
        raise WorkerAPIValidationError("tracks response has an invalid hasMore flag")
    if has_more is None:
        has_more = bool(requested_limit is not None and len(tracks) >= requested_limit)
    return {
        "model": API_MODEL,
        "dimensions": EMBEDDING_SIZE,
        "tracks": tracks,
        "nextCursor": next_cursor,
        "hasMore": has_more,
    }


def _vector_values(value: Any) -> list[float]:
    try:
        values = list(value)
    except TypeError as exc:
        raise WorkerAPIValidationError("embedding must be a one-dimensional vector") from exc
    if len(values) != EMBEDDING_SIZE:
        raise WorkerAPIValidationError(
            f"embedding has {len(values)} dimensions; expected {EMBEDDING_SIZE}"
        )
    result: list[float] = []
    for item in values:
        if isinstance(item, bool):
            raise WorkerAPIValidationError("embedding values must be finite numbers")
        try:
            number = float(item)
        except (TypeError, ValueError) as exc:
            raise WorkerAPIValidationError("embedding values must be finite numbers") from exc
        if not math.isfinite(number):
            raise WorkerAPIValidationError("embedding contains NaN or infinite values")
        result.append(number)
    return result


def build_embedding_item(track: Mapping[str, Any], embedding: Any) -> dict[str, Any]:
    """Build one JSON upload item, excluding fields the server does not accept."""

    normalized = validate_track(track)
    item: dict[str, Any] = {
        "uri": normalized["uri"],
        "name": normalized["name"],
        "artist": normalized["artist"],
        "album": normalized["album"],
        "model": API_MODEL,
        "embedding": _vector_values(embedding),
    }
    if "updatedAt" in normalized:
        item["updatedAt"] = normalized["updatedAt"]
    return item


def _validate_embedding_item(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkerAPIValidationError("embedding items must be JSON objects")
    track = validate_track(value)
    if value.get("model") != API_MODEL:
        raise WorkerAPIValidationError("embedding item has an invalid model")
    item: dict[str, Any] = {
        "uri": track["uri"],
        "name": track["name"],
        "artist": track["artist"],
        "album": track["album"],
        "model": API_MODEL,
        "embedding": _vector_values(value.get("embedding")),
    }
    if "updatedAt" in track:
        item["updatedAt"] = track["updatedAt"]
    return item


def build_embeddings_payload(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        raise WorkerAPIValidationError("embeddings must be a sequence")
    if not 1 <= len(items) <= MAX_UPLOAD_BATCH:
        raise WorkerAPIValidationError(
            f"embeddings must contain 1-{MAX_UPLOAD_BATCH} items"
        )
    normalized = [_validate_embedding_item(item) for item in items]
    uris = [item["uri"] for item in normalized]
    if len(set(uris)) != len(uris):
        raise WorkerAPIValidationError("embedding items contain duplicate uris")
    return {"embeddings": normalized}


def validate_upload_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise WorkerAPIValidationError("embedding response must be a JSON object")
    accepted = payload.get("accepted")
    rejected = payload.get("rejected")
    ok = payload.get("ok")
    if not isinstance(accepted, list) or not isinstance(rejected, list):
        raise WorkerAPIValidationError("embedding response is missing accepted/rejected")
    if not isinstance(ok, bool):
        raise WorkerAPIValidationError("embedding response has an invalid ok flag")
    normalized_accepted: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in accepted:
        if not isinstance(item, Mapping) or not isinstance(item.get("uri"), str):
            raise WorkerAPIValidationError("embedding response has an invalid accepted item")
        uri = item["uri"]
        if not uri or len(uri) > TRACK_URI_MAX_LENGTH:
            raise WorkerAPIValidationError("embedding response has an invalid accepted uri")
        status = item.get("status")
        if status not in {"written", "already_embedded"}:
            raise WorkerAPIValidationError("embedding response has an invalid accepted status")
        if uri in seen:
            raise WorkerAPIValidationError("embedding response repeats an accepted uri")
        seen.add(uri)
        normalized_accepted.append({"uri": uri, "status": status})
    normalized_rejected: list[dict[str, str]] = []
    rejected_seen: set[str] = set()
    for item in rejected:
        if not isinstance(item, Mapping) or not isinstance(item.get("uri"), str):
            raise WorkerAPIValidationError("embedding response has an invalid rejected item")
        uri = item["uri"]
        if not uri or len(uri) > TRACK_URI_MAX_LENGTH or uri in rejected_seen or uri in seen:
            raise WorkerAPIValidationError("embedding response repeats or invalidates a rejected uri")
        reason = item.get("reason")
        if not isinstance(reason, str):
            raise WorkerAPIValidationError("embedding response has an invalid rejection reason")
        rejected_seen.add(uri)
        normalized_rejected.append({"uri": uri, "reason": reason})
    model = payload.get("model", API_MODEL)
    dimensions = payload.get("dimensions", EMBEDDING_SIZE)
    if model != API_MODEL or dimensions != EMBEDDING_SIZE:
        raise WorkerAPIValidationError("embedding response has an unsupported model")
    if ok and normalized_rejected:
        raise WorkerAPIValidationError("embedding response is internally inconsistent")
    return {
        "model": model,
        "dimensions": dimensions,
        "accepted": normalized_accepted,
        "rejected": normalized_rejected,
        "ok": ok,
    }


class AudioDownload:
    """Result of one bounded audio download."""

    __slots__ = ("path", "byte_count", "content_type")

    def __init__(self, path: Path, byte_count: int, content_type: str | None = None) -> None:
        self.path = path
        self.byte_count = byte_count
        self.content_type = content_type

    def __fspath__(self) -> str:
        return str(self.path)


class WorkerAPIClient:
    """Small requests-based client for the authenticated worker API.

    A separate session is used per download thread when a session is not
    injected.  The bearer token is sent only in the Authorization header and is
    never included in URLs, diagnostics, or state files.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 60.0,
        retries: int = 3,
        max_bytes: int = 32 * 1024 * 1024,
        retry_delay: float = 0.5,
        session: Any | None = None,
        session_factory: Callable[[], Any] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = normalize_worker_url(base_url)
        if not isinstance(token, str) or not token.strip():
            raise ValueError("worker token must not be empty")
        if any(ord(character) < 32 or ord(character) == 127 for character in token):
            raise ValueError("worker token contains control characters")
        self._token = token.strip()
        self.timeout = _positive_float(timeout, "download timeout")
        self.retries = _nonnegative_int(retries, "download retries", maximum=20)
        self.max_bytes = _nonnegative_int(max_bytes, "download max bytes")
        if self.max_bytes < 1:
            raise ValueError("download max bytes must be greater than zero")
        self.retry_delay = float(retry_delay)
        if not math.isfinite(self.retry_delay) or self.retry_delay < 0:
            raise ValueError("retry delay must be a finite non-negative number")
        if session is not None and session_factory is not None:
            raise ValueError("provide session or session_factory, not both")
        self._shared_session = session
        self._session_factory = session_factory
        self._thread_local = threading.local()
        self._sessions: list[Any] = []
        self._sessions_lock = threading.Lock()
        self._sleep = sleep
        self._closed = False

    def __repr__(self) -> str:  # pragma: no cover - defensive diagnostic helper
        safe_url = redact_text(self.base_url, self._token)
        return f"WorkerAPIClient(base_url={safe_url!r}, token='[REDACTED]')"

    def _get_session(self) -> Any:
        if self._shared_session is not None:
            return self._shared_session
        session = getattr(self._thread_local, "session", None)
        if session is not None:
            return session
        if self._session_factory is not None:
            factory = self._session_factory
        else:
            if requests is None:
                raise WorkerAPIError(
                    "API mode requires the requests package; install requests"
                )
            factory = requests.Session
        session = factory()
        with self._sessions_lock:
            self._sessions.append(session)
        self._thread_local.session = session
        return session

    def _headers(self, accept: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": accept,
        }

    @staticmethod
    def _status(response: Any) -> int:
        try:
            return int(getattr(response, "status_code", 0))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _close_response(response: Any) -> None:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    def _is_retryable_status(self, status: int) -> bool:
        return status in {408, 429} or 500 <= status <= 599

    def _is_retryable_exception(self, error: BaseException) -> bool:
        if requests is not None and isinstance(error, requests.RequestException):
            return True
        return isinstance(error, (OSError, TimeoutError))

    def _wait_before_retry(self, attempt: int) -> None:
        delay = self.retry_delay * (2 ** max(0, attempt - 1))
        if delay > 0:
            self._sleep(delay)

    def _perform(self, method: str, url: str, **kwargs: Any) -> Any:
        if self._closed:
            raise WorkerAPIError("worker API client is closed")
        session = self._get_session()
        headers = kwargs.pop("headers", None)
        kwargs["timeout"] = self.timeout
        if method == "GET":
            return session.get(url, headers=headers, **kwargs)
        if method == "POST":
            return session.post(url, headers=headers, **kwargs)
        raise ValueError(f"unsupported HTTP method: {method}")

    def _request_json(
        self,
        method: str,
        url: str,
        *,
        label: str,
        accepted_statuses: Iterable[int] = (),
        **kwargs: Any,
    ) -> tuple[Mapping[str, Any], int]:
        accepted = set(accepted_statuses)
        attempts = self.retries + 1
        for attempt in range(1, attempts + 1):
            response: Any | None = None
            try:
                response = self._perform(method, url, **kwargs)
                status = self._status(response)
                if self._is_retryable_status(status) and attempt < attempts:
                    self._close_response(response)
                    self._wait_before_retry(attempt)
                    continue
                if status < 200 or status >= 300:
                    if status not in accepted:
                        self._close_response(response)
                        raise WorkerAPIError(
                            f"{label} request failed with HTTP {status}", status=status
                        )
                try:
                    payload = response.json()
                except Exception as exc:
                    raise WorkerAPIValidationError(
                        f"{label} returned invalid JSON"
                    ) from exc
                if not isinstance(payload, Mapping):
                    raise WorkerAPIValidationError(f"{label} returned a non-object JSON value")
                self._close_response(response)
                return payload, status
            except WorkerAPIValidationError:
                self._close_response(response)
                raise
            except WorkerAPIError:
                raise
            except Exception as exc:
                self._close_response(response)
                if self._is_retryable_exception(exc) and attempt < attempts:
                    self._wait_before_retry(attempt)
                    continue
                raise WorkerAPIError(
                    f"{label} request failed: {_short_error(exc, self._token)}"
                ) from None

        raise WorkerAPIError(f"{label} request failed after retries")

    def get_tracks(self, after: str | None = None, limit: int = 8) -> dict[str, Any]:
        if after is not None and (not isinstance(after, str) or len(after) > TRACK_URI_MAX_LENGTH):
            raise ValueError("after cursor is invalid")
        limit = _nonnegative_int(limit, "track page limit")
        if not 1 <= limit <= MAX_PAGE_SIZE:
            raise ValueError(f"track page limit must be between 1 and {MAX_PAGE_SIZE}")
        params: dict[str, Any] = {}
        if after:
            params["after"] = after
        params["limit"] = limit
        payload, _ = self._request_json(
            "GET",
            build_endpoint_url(self.base_url, "tracks"),
            label="track listing",
            params=params,
            headers=self._headers("application/json"),
        )
        return validate_tracks_response(payload, requested_limit=limit)

    def _download_once(
        self,
        uri: str,
        seconds: float,
        destination: Path,
    ) -> AudioDownload:
        response: Any | None = None
        try:
            response = self._perform(
                "GET",
                build_endpoint_url(self.base_url, "audio"),
                params={"uri": uri, "seconds": seconds},
                headers=self._headers("audio/mpeg"),
                stream=True,
            )
            status = self._status(response)
            if status < 200 or status >= 300:
                raise WorkerAPIError(f"audio download failed with HTTP {status}", status=status)
            headers = getattr(response, "headers", {}) or {}
            raw_length = headers.get("content-length") if hasattr(headers, "get") else None
            if raw_length is not None:
                try:
                    content_length = int(raw_length)
                except (TypeError, ValueError):
                    content_length = None
                if content_length is not None and content_length > self.max_bytes:
                    raise AudioDownloadError(
                        f"audio snippet exceeds the {self.max_bytes}-byte limit"
                    )
            destination.parent.mkdir(parents=True, exist_ok=True)
            total = 0
            iterator_method = getattr(response, "iter_content", None)
            iterator = (
                iterator_method(chunk_size=DEFAULT_CHUNK_SIZE)
                if callable(iterator_method)
                else [getattr(response, "content", b"")]
            )
            if iterator is None:
                iterator = [getattr(response, "content", b"")]
            with destination.open("wb") as output:
                for chunk in iterator:
                    if not chunk:
                        continue
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8")
                    total += len(chunk)
                    if total > self.max_bytes:
                        raise AudioDownloadError(
                            f"audio snippet exceeds the {self.max_bytes}-byte limit"
                        )
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if total == 0:
                raise AudioDownloadError("audio snippet was empty")
            content_type = headers.get("content-type") if hasattr(headers, "get") else None
            return AudioDownload(destination, total, content_type)
        except Exception:
            try:
                destination.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
            raise
        finally:
            self._close_response(response)

    def download_audio(
        self,
        uri: str,
        seconds: float,
        destination: str | Path,
    ) -> AudioDownload:
        if not isinstance(uri, str) or not uri or len(uri) > TRACK_URI_MAX_LENGTH:
            raise ValueError("audio uri is invalid")
        seconds = _positive_float(seconds, "audio seconds", maximum=MAX_AUDIO_SECONDS)
        path = Path(destination)
        attempts = self.retries + 1
        for attempt in range(1, attempts + 1):
            try:
                return self._download_once(uri, seconds, path)
            except Exception as error:
                retryable = self._is_retryable_exception(error)
                if isinstance(error, WorkerAPIError) and error.status is not None:
                    retryable = self._is_retryable_status(error.status)
                if retryable and attempt < attempts:
                    self._wait_before_retry(attempt)
                    continue
                if isinstance(error, WorkerAPIError):
                    raise
                raise AudioDownloadError(
                    f"audio download failed: {_short_error(error, self._token)}"
                ) from None
        raise AudioDownloadError("audio download failed after retries")

    def post_embeddings(self, items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        payload = build_embeddings_payload(items)
        response, _ = self._request_json(
            "POST",
            build_endpoint_url(self.base_url, "embeddings"),
            label="embedding upload",
            accepted_statuses=(409,),
            json=payload,
            headers={**self._headers("application/json"), "Content-Type": "application/json"},
        )
        normalized = validate_upload_response(response)
        expected = {item["uri"] for item in payload["embeddings"]}
        actual = {
            item["uri"] for item in normalized["accepted"]
        } | {item["uri"] for item in normalized["rejected"]}
        if actual != expected:
            raise WorkerAPIValidationError(
                "embedding response does not account for every submitted track"
            )
        if normalized["ok"] != (not normalized["rejected"]):
            raise WorkerAPIValidationError("embedding response has an inconsistent ok flag")
        return normalized

    # Descriptive aliases for callers that prefer domain-oriented names.
    get_pending_tracks = get_tracks
    download_snippet = download_audio
    upload_embeddings = post_embeddings
    upload_vectors = post_embeddings

    def __enter__(self) -> "WorkerAPIClient":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        with self._sessions_lock:
            if self._closed:
                return
            self._closed = True
            sessions = list(self._sessions)
            self._sessions.clear()
        for session in sessions:
            close = getattr(session, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


def _state_failure(value: Any, secret: str | None) -> dict[str, str] | None:
    if not isinstance(value, Mapping) or not isinstance(value.get("uri"), str):
        return None
    result = {"uri": redact_text(value["uri"], secret)}
    if isinstance(value.get("name"), str):
        result["name"] = redact_text(value["name"], secret)
    if isinstance(value.get("error"), str):
        result["error"] = redact_text(value["error"], secret)
    if isinstance(value.get("at"), str):
        result["at"] = value["at"]
    return result


class WorkerStateStore:
    """Atomic, non-secret cursor/progress persistence for API mode."""

    def __init__(self, path: str | Path | None, *, secret: str | None = None) -> None:
        self.path = Path(path) if path else None
        self.secret = secret

    def load(self) -> dict[str, Any]:
        if self.path is None or not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise WorkerStateError(
                f"could not read worker state file: {redact_text(exc, self.secret)}"
            ) from exc
        if not isinstance(raw, Mapping):
            raise WorkerStateError("worker state file must contain a JSON object")
        version = raw.get("version", 1)
        if isinstance(version, bool) or version != 1:
            raise WorkerStateError("worker state file has an unsupported version")
        after = raw.get("after", raw.get("cursor"))
        if after == "":
            after = None
        if after is not None and (
            not isinstance(after, str) or not after or len(after) > TRACK_URI_MAX_LENGTH
        ):
            raise WorkerStateError("worker state has an invalid cursor")
        processed = _nonnegative_int(raw.get("processed", 0), "state processed")
        failed = _nonnegative_int(raw.get("failed", 0), "state failed")
        complete = raw.get("complete", False)
        if not isinstance(complete, bool):
            raise WorkerStateError("worker state complete must be a boolean")
        raw_failures = raw.get("failures", [])
        if not isinstance(raw_failures, list):
            raise WorkerStateError("worker state failures must be a list")
        failures = [
            cleaned
            for item in raw_failures[-MAX_STATE_FAILURES:]
            if (cleaned := _state_failure(item, self.secret)) is not None
        ]
        return {
            "after": after,
            "processed": processed,
            "failed": failed,
            "failures": failures,
            "complete": complete,
        }

    def save(
        self,
        *,
        after: str | None,
        processed: int,
        failed: int,
        failures: Sequence[Mapping[str, Any]],
        complete: bool = False,
    ) -> None:
        if self.path is None:
            return
        if after is not None and (
            not isinstance(after, str) or not after or len(after) > TRACK_URI_MAX_LENGTH
        ):
            raise WorkerStateError("refusing to save an invalid cursor")
        cleaned_failures = [
            cleaned
            for item in list(failures)[-MAX_STATE_FAILURES:]
            if (cleaned := _state_failure(item, self.secret)) is not None
        ]
        payload = {
            "version": 1,
            "source": "api",
            "after": after,
            "processed": _nonnegative_int(processed, "state processed"),
            "failed": _nonnegative_int(failed, "state failed"),
            "failures": cleaned_failures,
            "complete": bool(complete),
            "updatedAt": _utc_now(),
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w",
                    encoding="utf-8",
                    dir=self.path.parent,
                    prefix=f".{self.path.name}.",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = Path(temporary.name)
                    json.dump(payload, temporary, sort_keys=True, separators=(",", ":"))
                    temporary.write("\n")
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.chmod(temporary_path, 0o600)
                os.replace(temporary_path, self.path)
                os.chmod(self.path, 0o600)
            finally:
                if temporary_path is not None:
                    try:
                        temporary_path.unlink()
                    except FileNotFoundError:
                        pass
        except (OSError, TypeError, ValueError) as exc:
            raise WorkerStateError(
                f"could not write worker state file: {redact_text(exc, self.secret)}"
            ) from exc


def _result_path(result: Any, fallback: Path) -> Path:
    if isinstance(result, AudioDownload):
        return result.path
    if isinstance(result, (str, Path)):
        return Path(result)
    path = getattr(result, "path", None)
    if isinstance(path, (str, Path)):
        return Path(path)
    return fallback


def prefetch_audio(
    tracks: Iterable[Mapping[str, Any]],
    downloader: Callable[[dict[str, Any], Path], Any],
    *,
    workers: int,
    depth: int,
    directory: str | Path | None = None,
) -> Iterator[tuple[dict[str, Any], Path]]:
    """Yield audio paths while bounding network-only background downloads.

    The executor is used only for ``downloader``.  The consumer receives paths
    in input order and remains responsible for all decoding/inference, so
    TensorFlow is never called concurrently.
    """

    workers = _nonnegative_int(workers, "prefetch workers")
    depth = _nonnegative_int(depth, "prefetch depth")
    if workers < 1 or workers > 64:
        raise ValueError("prefetch workers must be between 1 and 64")
    if depth < 1 or depth > 128:
        raise ValueError("prefetch depth must be between 1 and 128")

    track_iterator = enumerate(tracks)
    temp_directory = tempfile.TemporaryDirectory(
        prefix="music-worker-", dir=str(directory) if directory is not None else None
    )
    root = Path(temp_directory.name)
    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="worker-download")
    pending: deque[tuple[Future[Any], dict[str, Any], Path]] = deque()
    exhausted = False

    def submit_one() -> bool:
        nonlocal exhausted
        if exhausted:
            return False
        try:
            index_and_track = next(track_iterator)
        except StopIteration:
            exhausted = True
            return False
        index, track = index_and_track
        normalized = dict(track)
        path = root / f"{index:06d}.mp3"
        future = executor.submit(downloader, normalized, path)
        pending.append((future, normalized, path))
        return True

    def fill() -> None:
        while len(pending) < depth and not exhausted:
            submit_one()

    try:
        fill()
        while pending:
            future, track, fallback = pending.popleft()
            # Keep the queue bounded while the consumer processes the yielded
            # item.  No submitted callable performs model inference.
            fill()
            try:
                result = future.result()
            except Exception as error:
                raise PrefetchDownloadError(track, error) from error
            yield track, _result_path(result, fallback)
    finally:
        for future, _track, _path in pending:
            future.cancel()
        try:
            executor.shutdown(wait=True, cancel_futures=True)
        except TypeError:  # pragma: no cover - Python versions before cancel_futures
            executor.shutdown(wait=True)
        temp_directory.cleanup()


def _arg(args: Any, name: str, default: Any = None) -> Any:
    return getattr(args, name, default)


def _track_from_item(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "uri": item.get("uri"),
        "name": item.get("name"),
        "artist": item.get("artist", []),
        "album": item.get("album", ""),
        **({"updatedAt": item["updatedAt"]} if "updatedAt" in item else {}),
    }


def _record_failure(
    failures: list[dict[str, Any]],
    track: Mapping[str, Any],
    error: BaseException,
    *,
    secret: str | None,
) -> None:
    failures.append(
        {
            "uri": track.get("uri"),
            "name": track.get("name"),
            "error": _short_error(error, secret),
            "at": _utc_now(),
        }
    )
    if len(failures) > MAX_STATE_FAILURES:
        del failures[:-MAX_STATE_FAILURES]


def _print_event(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")), flush=True)


def run_api_worker(
    core: Any,
    args: Any,
    client: WorkerAPIClient | Any | None = None,
) -> int:
    """Run API mode using ``core``'s existing OpenL3 processing functions."""

    # Accept both run_api_worker(core, args) and the legacy-friendly
    # run_api_worker(args, core) spelling when called from a notebook.
    if not hasattr(core, "StageStats") and hasattr(args, "StageStats"):
        core, args = args, core
    run_started = time.perf_counter()
    stats = core.StageStats()
    token = str(_arg(args, "worker_token", "") or "")
    provided_client = client
    client: Any | None = None
    owns_client = False
    state = WorkerStateStore(_arg(args, "state_file"), secret=token)
    failures: list[dict[str, Any]] = []
    after: str | None = _arg(args, "after")
    processed = 0
    failed_total = 0
    examined_this_run = 0
    inferred_this_run = 0
    written_this_run = 0
    failures_this_run = 0
    limit_reached = False
    complete = False
    stop_reason: str | None = None
    fatal_error: BaseException | None = None

    try:
        if provided_client is None:
            client = WorkerAPIClient(
                str(_arg(args, "worker_url", "") or ""),
                token,
                timeout=float(_arg(args, "download_timeout", 60.0)),
                retries=int(_arg(args, "download_retries", 3)),
                max_bytes=int(_arg(args, "download_max_bytes", 32 * 1024 * 1024)),
            )
            owns_client = True
        else:
            client = provided_client

        saved: dict[str, Any] = {}
        if not bool(_arg(args, "restart", False)):
            saved = state.load()
        if saved:
            after = saved.get("after", after)
            processed = int(saved.get("processed", 0) or 0)
            failed_total = int(saved.get("failed", 0) or 0)
            raw_failures = saved.get("failures", [])
            if isinstance(raw_failures, list):
                failures = [dict(item) for item in raw_failures if isinstance(item, Mapping)]

        dry_run = bool(_arg(args, "dry_run", False))
        if bool(_arg(args, "restart", False)) and not dry_run:
            # --restart explicitly abandons the previous API checkpoint.  Keep
            # the reset atomic and token-free just like the normal state save.
            state.save(
                after=after,
                processed=0,
                failed=0,
                failures=[],
                complete=False,
            )
        limit = _arg(args, "limit")
        if limit is not None:
            limit = _nonnegative_int(limit, "limit")
        batch_size = _nonnegative_int(_arg(args, "batch_size", 8), "batch size")
        if not 1 <= batch_size <= MAX_PAGE_SIZE:
            raise ValueError(f"batch size must be between 1 and {MAX_PAGE_SIZE}")
        duration = float(_arg(args, "duration", 60.0))
        audio_backend = str(_arg(args, "audio_backend", "fast"))
        prefetch_workers = int(_arg(args, "prefetch_workers", 4))
        prefetch_depth = int(_arg(args, "prefetch_depth", 4))
        max_errors = int(_arg(args, "max_errors", 0))
        fail_fast = bool(_arg(args, "fail_fast", False))
        if duration <= 0 or not math.isfinite(duration) or duration > MAX_AUDIO_SECONDS:
            raise ValueError("duration must be positive, finite, and at most 120 seconds")
        if not 1 <= prefetch_workers <= 64:
            raise ValueError("prefetch workers must be between 1 and 64")
        if not 1 <= prefetch_depth <= 128:
            raise ValueError("prefetch depth must be between 1 and 128")
        if max_errors < 0:
            raise ValueError("max-errors must be zero or greater")

        thread_config = core.configure_tensorflow_threads()
        if thread_config:
            print(f"TensorFlow thread limits: {thread_config}", flush=True)
        model = core.load_openl3_model(stats)

        if limit == 0:
            limit_reached = True
        else:
            while True:
                if limit is not None and examined_this_run >= limit:
                    limit_reached = True
                    break
                request_limit = batch_size
                if limit is not None:
                    request_limit = min(request_limit, limit - examined_this_run)
                page_started = time.perf_counter()
                page_info = client.get_tracks(after, request_limit)
                stats.add("page_fetch", time.perf_counter() - page_started)
                page = list(page_info.get("tracks", []))
                if limit is not None and len(page) > limit - examined_this_run:
                    remaining = max(0, limit - examined_this_run)
                    page = page[:remaining]
                    page_info = dict(page_info)
                    page_info["tracks"] = page
                    if page:
                        page_info["nextCursor"] = page[-1].get("uri")
                        page_info["hasMore"] = True
                if not page:
                    complete = not limit_reached
                    if not dry_run:
                        state.save(
                            after=after,
                            processed=processed,
                            failed=failed_total,
                            failures=failures,
                            complete=complete,
                        )
                    break

                page_cursor = page_info.get("nextCursor") or page[-1].get("uri")
                if not isinstance(page_cursor, str) or not page_cursor:
                    fatal_error = WorkerAPIValidationError("tracks page has no usable cursor")
                    break

                page_results: list[dict[str, Any]] = []
                page_failure_count = 0
                stopped_early = False
                iterator = prefetch_audio(
                    page,
                    lambda track, path: client.download_audio(
                        track["uri"], duration, path
                    ),
                    workers=prefetch_workers,
                    depth=prefetch_depth,
                )
                try:
                    for track, audio_path in iterator:
                        examined_this_run += 1
                        try:
                            embedding, timings = core.process_audio_file(
                                audio_path,
                                model,
                                duration,
                                audio_backend,
                                stats,
                            )
                            if hasattr(core, "validate_embedding"):
                                embedding = core.validate_embedding(embedding)
                            item = build_embedding_item(track, embedding)
                            page_results.append(item)
                            inferred_this_run += 1
                            _print_event(
                                {
                                    "event": "track_inferred",
                                    "uri": track.get("uri"),
                                    "timings": timings,
                                }
                            )
                        except Exception as error:
                            page_failure_count += 1
                            _record_failure(failures, track, error, secret=token)
                            failed_total += 1
                            failures_this_run += 1
                            _print_event(
                                {
                                    "event": "track_failed",
                                    "uri": track.get("uri"),
                                    "reason": _short_error(error, token),
                                }
                            )
                            if fail_fast or (max_errors and failures_this_run >= max_errors):
                                stopped_early = True
                                stop_reason = _short_error(error, token)
                                break
                except PrefetchDownloadError as error:
                    # A failed network future is associated with its metadata so
                    # it follows the same bounded failure policy as decode
                    # failures rather than becoming an untracked fatal error.
                    track = error.track
                    examined_this_run += 1
                    page_failure_count += 1
                    _record_failure(failures, track, error.cause, secret=token)
                    failed_total += 1
                    failures_this_run += 1
                    _print_event(
                        {
                            "event": "track_failed",
                            "uri": track.get("uri"),
                            "reason": _short_error(error.cause, token),
                        }
                    )
                    stopped_early = True
                    stop_reason = _short_error(error.cause, token)
                finally:
                    close_iterator = getattr(iterator, "close", None)
                    if callable(close_iterator):
                        close_iterator()
                if stopped_early:
                    # Do not upload a partial page after fail-fast/max-errors
                    # or a network prefetch failure.
                    page_results = []

                upload_rejected = False
                upload_error: BaseException | None = None
                written_before_page = written_this_run
                if page_results and not dry_run:
                    for start in range(0, len(page_results), MAX_UPLOAD_BATCH):
                        chunk = page_results[start : start + MAX_UPLOAD_BATCH]
                        try:
                            response = client.post_embeddings(chunk)
                            rejected = response.get("rejected", [])
                            if not response.get("ok") or rejected:
                                upload_rejected = True
                                for rejection in rejected:
                                    rejected_uri = rejection.get("uri")
                                    rejected_track = next(
                                        (
                                            item
                                            for item in page_results
                                            if item.get("uri") == rejected_uri
                                        ),
                                        _track_from_item(chunk[0]),
                                    )
                                    _record_failure(
                                        failures,
                                        rejected_track,
                                        RuntimeError(
                                            f"embedding upload rejected: {rejection.get('reason', 'unknown reason')}"
                                        ),
                                        secret=token,
                                    )
                                    failed_total += 1
                                    failures_this_run += 1
                                if not rejected:
                                    _record_failure(
                                        failures,
                                        _track_from_item(chunk[0]),
                                        RuntimeError("embedding upload was rejected"),
                                        secret=token,
                                    )
                                    failed_total += 1
                                    failures_this_run += 1
                                break
                            written_this_run += len(chunk)
                        except Exception as error:
                            upload_error = error
                            _record_failure(
                                failures,
                                _track_from_item(chunk[0]),
                                error,
                                secret=token,
                            )
                            failed_total += 1
                            failures_this_run += 1
                            break

                if page_failure_count or upload_rejected or upload_error:
                    # The server may have accepted some vectors, but the page
                    # is not checkpointable.  A later invocation will safely
                    # skip accepted rows and retry the remaining metadata.
                    if upload_error is not None:
                        stop_reason = _short_error(upload_error, token)
                    elif upload_rejected:
                        stop_reason = "embedding upload rejected"
                    else:
                        stop_reason = "one or more tracks in the page failed"
                    processed += max(0, written_this_run - written_before_page)
                    # Do not assign page_cursor or save state here.  This is the
                    # important all-or-nothing cursor rule for failed pages.
                    break

                if dry_run:
                    # A dry run may inspect multiple pages using an in-memory
                    # cursor, but it must never persist it.
                    after = page_cursor
                else:
                    after = page_cursor
                    processed += len(page_results)
                    state.save(
                        after=after,
                        processed=processed,
                        failed=failed_total,
                        failures=failures,
                        complete=False,
                    )
                _print_event(
                    {
                        "event": "batch",
                        "cursor": after,
                        "inferred": len(page_results),
                        "written": 0 if dry_run else len(page_results),
                        "processed": processed,
                        "failed": failed_total,
                    }
                )
                if limit is not None and examined_this_run >= limit:
                    limit_reached = True
                    break
                if not bool(page_info.get("hasMore", True)):
                    complete = True
                    if not dry_run:
                        state.save(
                            after=after,
                            processed=processed,
                            failed=failed_total,
                            failures=failures,
                            complete=True,
                        )
                    break

        if stop_reason is None and not limit_reached and complete is False and fatal_error is None:
            # A normal exhausted keyset is complete unless a bounded limit was
            # requested.  The empty-page branch normally sets this explicitly.
            if not dry_run:
                state.save(
                    after=after,
                    processed=processed,
                    failed=failed_total,
                    failures=failures,
                    complete=True,
                )
            complete = True

    except KeyboardInterrupt:
        raise
    except Exception as error:
        fatal_error = error
    finally:
        if owns_client:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        stats.add("run_total", time.perf_counter() - run_started)
        print(
            "PROFILE "
            + json.dumps(
                {
                    "stages": stats.summary(),
                    "examined_this_run": examined_this_run,
                    "inferred_this_run": inferred_this_run,
                    "written_this_run": written_this_run,
                    "failures_this_run": failures_this_run,
                },
                sort_keys=True,
            ),
            flush=True,
        )

    if fatal_error is not None:
        print(f"embedding worker failed: {_short_error(fatal_error, token)}", flush=True)
        return 1
    _print_event(
        {
            "event": "run_summary",
            "examined_this_run": examined_this_run,
            "inferred_this_run": inferred_this_run,
            "written_this_run": written_this_run,
            "processed_total": processed,
            "failed_total": failed_total,
            "complete": bool(complete and not limit_reached),
            "limit_reached": limit_reached,
        }
    )
    if stop_reason is not None:
        print(f"embedding worker stopped: {stop_reason}", flush=True)
        return 2
    return 0 if complete and not limit_reached else 2


# Compatibility aliases for callers that use the shorter terminology.
WorkerAPI = WorkerAPIClient
run_remote = run_api_worker
run_source_api = run_api_worker


__all__ = [
    "API_MODEL",
    "AudioDownload",
    "AudioDownloadError",
    "PrefetchDownloadError",
    "RemoteStop",
    "WorkerAPIClient",
    "WorkerAPI",
    "WorkerAPIError",
    "WorkerAPIValidationError",
    "WorkerStateError",
    "WorkerStateStore",
    "build_embedding_item",
    "build_embeddings_payload",
    "build_endpoint_url",
    "normalize_worker_url",
    "prefetch_audio",
    "run_api_worker",
    "run_remote",
    "validate_track",
    "validate_tracks_response",
    "validate_upload_response",
]
