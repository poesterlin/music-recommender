import importlib.util
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "worker_api.py"
SPEC = importlib.util.spec_from_file_location("worker_api_under_test", MODULE_PATH)
assert SPEC and SPEC.loader
worker_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker_api)


class FakeResponse:
    def __init__(self, payload=None, *, status_code=200, chunks=(), headers=None):
        self.payload = payload
        self.status_code = status_code
        self.chunks = tuple(chunks)
        self.headers = headers or {}
        self.closed = False

    def json(self):
        return self.payload

    def iter_content(self, chunk_size):
        del chunk_size
        yield from self.chunks

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self):
        self.calls = []
        self.responses = []

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.responses.pop(0)

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.responses.pop(0)


class WorkerAPIClientTests(unittest.TestCase):
    def test_track_and_embedding_requests_use_expected_urls_auth_and_payload(self):
        session = FakeSession()
        session.responses.extend(
            [
                FakeResponse(
                    {
                        "model": "openl3-512",
                        "dimensions": 512,
                        "tracks": [
                            {
                                "uri": "library://track/1",
                                "name": "Track",
                                "artist": ["Artist"],
                                "album": "Album",
                                "updatedAt": "2026-01-01T00:00:00Z",
                            }
                        ],
                        "nextCursor": "library://track/1",
                        "hasMore": False,
                    }
                ),
                FakeResponse(
                    {
                        "accepted": [
                            {"uri": "library://track/1", "status": "written"}
                        ],
                        "rejected": [],
                        "ok": True,
                    }
                ),
            ]
        )
        recipe = worker_api.build_recipe(0.5, 60.0, "kapre")
        client = worker_api.WorkerAPIClient(
            "https://example.test/base/",
            "secret-token",
            session=session,
            retry_delay=0,
            recipe=recipe,
        )

        page = client.get_tracks(after="library://track/0", limit=3)
        track = page["tracks"][0]
        item = worker_api.build_embedding_item(track, [0.25] * 512)
        response = client.post_embeddings([item])

        self.assertEqual(response["ok"], True)
        get_call = session.calls[0]
        self.assertEqual(get_call[1], "https://example.test/base/api/worker/tracks")
        self.assertEqual(get_call[2]["params"], {"after": "library://track/0", "limit": 3})
        self.assertEqual(get_call[2]["headers"]["Authorization"], "Bearer secret-token")
        post_call = session.calls[1]
        self.assertEqual(
            post_call[1], "https://example.test/base/api/worker/embeddings"
        )
        # The recipe travels with the batch so the server can centre the vectors
        # against the space they were actually produced for.
        self.assertEqual(
            post_call[2]["json"], {"recipe": recipe, "embeddings": [item]}
        )
        self.assertEqual(
            post_call[2]["headers"]["Authorization"], "Bearer secret-token"
        )
        self.assertNotIn("secret-token", repr(client))

    def test_audio_download_is_bounded_and_authenticated(self):
        session = FakeSession()
        destination = Path(tempfile.mkdtemp()) / "snippet.mp3"
        session.responses.append(
            FakeResponse(chunks=(b"abc", b"def"), headers={"content-type": "audio/mpeg"})
        )
        client = worker_api.WorkerAPIClient(
            "https://example.test", "secret-token", session=session, retry_delay=0
        )

        result = client.download_audio("library://track/1", 12.5, destination)

        self.assertEqual(result.byte_count, 6)
        self.assertEqual(destination.read_bytes(), b"abcdef")
        call = session.calls[0]
        self.assertEqual(call[1], "https://example.test/api/worker/audio")
        self.assertEqual(call[2]["params"], {"uri": "library://track/1", "seconds": 12.5})
        self.assertEqual(call[2]["headers"]["Authorization"], "Bearer secret-token")

    def test_audio_download_rejects_oversized_content_and_cleans_file(self):
        session = FakeSession()
        destination = Path(tempfile.mkdtemp()) / "snippet.mp3"
        session.responses.append(
            FakeResponse(
                chunks=(b"1234", b"5678"),
                headers={"content-length": "9"},
            )
        )
        client = worker_api.WorkerAPIClient(
            "https://example.test",
            "secret-token",
            session=session,
            max_bytes=5,
            retries=0,
        )

        with self.assertRaises(worker_api.AudioDownloadError):
            client.download_audio("library://track/1", 10, destination)
        self.assertFalse(destination.exists())


class PrefetchTests(unittest.TestCase):
    def test_prefetch_is_ordered_and_bounded(self):
        active = 0
        maximum_active = 0
        lock = threading.Lock()
        yielded_paths = []

        def downloader(track, path):
            nonlocal active, maximum_active
            with lock:
                active += 1
                maximum_active = max(maximum_active, active)
            time.sleep(0.005)
            path.write_bytes(track["uri"].encode())
            with lock:
                active -= 1
            return path

        tracks = [{"uri": str(index)} for index in range(8)]
        iterator = worker_api.prefetch_audio(
            tracks, downloader, workers=2, depth=3
        )
        for track, path in iterator:
            yielded_paths.append(path)
            self.assertTrue(path.exists())

        self.assertEqual(
            [track["uri"] for track, _ in worker_api.prefetch_audio(
                [{"uri": str(index)} for index in range(8)],
                downloader,
                workers=2,
                depth=3,
            )],
            [str(index) for index in range(8)],
        )
        self.assertLessEqual(maximum_active, 2)
        self.assertTrue(yielded_paths)
        self.assertTrue(all(not path.exists() for path in yielded_paths))


if __name__ == "__main__":
    unittest.main()


class _FakeArgs:
    """Minimal stand-in for the parsed argparse namespace."""

    def __init__(self, **overrides):
        defaults = {
            "after": None,
            "audio_backend": "soundfile",
            "batch_size": 32,
            "download_max_bytes": 32 * 1024 * 1024,
            "download_retries": 0,
            "download_timeout": 5.0,
            "dry_run": False,
            "duration": 60.0,
            "fail_fast": False,
            "hop": 1.0,
            "infer_batch_size": 8,
            "limit": 1,
            "max_errors": 5,
            "prefetch_depth": 1,
            "prefetch_workers": 1,
            "restart": False,
            "state_file": None,
            "worker_token": "secret-token",
            "worker_url": "https://example.test",
        }
        defaults.update(overrides)
        for key, value in defaults.items():
            setattr(self, key, value)


class _FakeCore:
    """Records the arguments process_audio_file is called with."""

    # Mirrors the core's single source of truth for the OpenL3 frontend, so the
    # recipe the worker uploads cannot drift from the model it loaded.
    EMBEDDING_FRONTEND = "kapre"

    # The worker falls back to these when it has to infer before it has heard
    # from the server. Mirroring them keeps the double honest about the contract
    # rather than letting the worker depend on attributes it does not have.
    DEFAULT_HOP_SECONDS = 0.5
    DEFAULT_DURATION_SECONDS = 90.0

    def __init__(self):
        self.calls = []

    class StageStats:
        def __init__(self, *args, **kwargs):
            self.timings = {}

        def add(self, key, value):
            self.timings[key] = value

        def summary(self, *args, **kwargs):
            return dict(self.timings)

    @staticmethod
    def configure_tensorflow_threads():
        return {}

    @staticmethod
    def load_openl3_model(stats):
        return object()

    def process_audio_file(
        self, audio_path, model, duration, audio_backend, stats, infer_batch_size=8, **kwargs
    ):
        self.calls.append(
            {
                "duration": duration,
                "infer_batch_size": infer_batch_size,
                **kwargs,
            }
        )
        return [0.5] * 512, {"hop_seconds": kwargs.get("hop_seconds")}

    @staticmethod
    def validate_embedding(embedding):
        return embedding


class _FakeWorkerClient:
    def __init__(self):
        self.uploads = []
        self.server_recipe = None
        self.recipe = None

    def get_tracks(self, after=None, limit=None):
        track = lambda uri: {
            "uri": uri,
            "name": "Example",
            "artist": ["Someone"],
            "album": "Record",
            "media_type": "track",
            "is_playable": True,
        }
        # Honour the cursor the way the real endpoint does, so a run that
        # advances actually terminates instead of seeing the same page forever.
        all_tracks = [track("library://track/1"), track("library://track/2")]
        remaining = [t for t in all_tracks if after is None or t["uri"] > after]
        # Honour the requested page size, as the real endpoint does. Returning
        # more than was asked for is a contract violation the validator rejects,
        # and a fake that hides it would let a paging bug pass here and fail in
        # production.
        if limit is not None:
            remaining = remaining[:limit]
        # Mirror the real endpoint's paging shape. The old stub hard-coded
        # nextCursor to None, which the real validator rejects once a page has
        # tracks -- the cursor has to be the last uri or null only when the page
        # is empty.
        page = {
            "tracks": remaining,
            "nextCursor": remaining[-1]["uri"] if remaining else None,
            "hasMore": limit is not None and len(remaining) == limit,
        }
        # The real endpoint sends its registered recipe with every page. Absent
        # here by default, which is the pre-feature case.
        if self.server_recipe is not None:
            page["recipe"] = self.server_recipe
        # Run the payload through the real validator, as WorkerAPIClient does.
        # Returning a hand-built dict instead would let a malformed recipe -- or a
        # malformed track, or a bad cursor -- reach the worker unvalidated, and
        # the tests would pass while the production path rejected it.
        return worker_api.validate_tracks_response(page, requested_limit=limit)

    def download_audio(self, uri, duration, path):
        if uri in getattr(self, "missing", ()):
            raise worker_api.WorkerAPIError("audio download failed with HTTP 404", status=404)
        with open(path, "wb") as handle:
            handle.write(b"ID3")
        return path

    def post_embeddings(self, items):
        self.uploads.append(items)
        return {
            "accepted": [{"uri": item["uri"], "status": "written"} for item in items],
            "rejected": [],
            "ok": True,
        }

    def close(self):
        return None


class ApiWorkerHopTests(unittest.TestCase):
    """API mode must embed at the configured hop, not OpenL3's default."""

    def _run(self, hop):
        with tempfile.TemporaryDirectory() as tmp:
            client = _FakeWorkerClient()
            client.recipe = worker_api.build_recipe(hop, 60.0, "kapre")
            core = _FakeCore()
            args = _FakeArgs(
                hop=hop,
                state_file=str(Path(tmp) / "state.json"),
            )
            worker_api.run_api_worker(core, args, client)
            return core.calls, client

    def test_the_configured_hop_reaches_process_audio_file(self):
        # Regression: API mode dropped `hop`, so --mode/--hop were silently a
        # no-op and every API worker sat at the 0.1s default.
        calls, _ = self._run(1.0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["hop_seconds"], 1.0)

    def test_a_non_default_hop_is_not_silently_replaced(self):
        calls, _ = self._run(0.5)
        self.assertEqual(calls[0]["hop_seconds"], 0.5)

    def test_the_uploaded_recipe_matches_the_hop(self):
        # The recipe is what lets the server refuse a batch it cannot attribute
        # to a registered space, so it has to reflect the hop actually used.
        _, client = self._run(0.5)
        self.assertEqual(client.recipe["hopSeconds"], 0.5)
        self.assertEqual(client.recipe["model"], worker_api.API_MODEL)
        self.assertEqual(client.recipe["frontend"], "kapre")


class ServerRecipeTests(unittest.TestCase):
    """The worker follows the server's recipe unless it is told otherwise.

    The server resolves an upload by exact match against `embedding_space` with no
    fallback and answers 409 on a miss. That is correct -- mixing two vector
    spaces is worse than failing -- but it means any disagreement between the
    worker's defaults and the server's rejects every upload, with the only
    recovery being for a human to register the right recipe by hand. So the
    server sends its recipe with every page and the worker adopts it.
    """

    def _run(self, *, args_hop, args_duration, server_recipe):
        with tempfile.TemporaryDirectory() as tmp:
            client = _FakeWorkerClient()
            client.recipe = worker_api.build_recipe(0.5, 90.0, "kapre")
            client.server_recipe = server_recipe
            core = _FakeCore()
            args = _FakeArgs(
                hop=args_hop,
                duration=args_duration,
                state_file=str(Path(tmp) / "state.json"),
            )
            worker_api.run_api_worker(core, args, client)
            return core.calls, client

    def test_the_worker_adopts_the_servers_recipe(self):
        calls, client = self._run(
            args_hop=None,
            args_duration=None,
            server_recipe={"model": "openl3-512", "hopSeconds": 0.25,
                           "maxSampleSeconds": 120.0, "frontend": "kapre"},
        )
        self.assertEqual(calls[0]["hop_seconds"], 0.25)
        # The client stamps every upload, so it has to carry the adopted value
        # too -- otherwise the run infers at one hop and declares another.
        self.assertEqual(client.recipe["hopSeconds"], 0.25)
        self.assertEqual(client.recipe["maxSampleSeconds"], 120.0)

    def test_server_recipe_overrides_local_flags(self):
        # The escape hatch has to survive, or there is no way to deliberately
        # embed at a different density from the default.
        calls, client = self._run(
            args_hop=1.0,
            args_duration=None,
            server_recipe={"model": "openl3-512", "hopSeconds": 0.25,
                           "maxSampleSeconds": 120.0, "frontend": "kapre"},
        )
        self.assertEqual(calls[0]["hop_seconds"], 0.25)
        self.assertEqual(client.recipe["hopSeconds"], 0.25)

    def test_an_older_server_without_a_recipe_is_not_fatal(self):
        # Absent is the normal case before this feature existed. The worker falls
        # back to its own values rather than refusing to run.
        calls, _ = self._run(args_hop=None, args_duration=None, server_recipe=None)
        self.assertEqual(calls[0]["hop_seconds"], 0.5)

    def test_a_malformed_recipe_is_rejected(self):
        # Silently downgrading a broken recipe to a guess is how a mismatch
        # becomes a 409 much later with nothing pointing at the cause.
        with self.assertRaises(worker_api.WorkerAPIValidationError):
            worker_api.parse_recipe({"model": "openl3-512", "hopSeconds": "fast",
                                     "maxSampleSeconds": 90.0, "frontend": "kapre"})


class MissingAudioTests(unittest.TestCase):
    """A 404 is permanent, so it must never hold the cursor."""

    def test_a_404_is_classified_as_missing_audio(self):
        self.assertTrue(worker_api.is_missing_audio(worker_api.WorkerAPIError("gone", status=404)))

    def test_other_statuses_are_retryable(self):
        for status in (408, 429, 500, 503):
            with self.subTest(status=status):
                self.assertFalse(
                    worker_api.is_missing_audio(worker_api.WorkerAPIError("x", status=status))
                )
        self.assertFalse(worker_api.is_missing_audio(RuntimeError("boom")))
        self.assertFalse(worker_api.is_missing_audio(worker_api.WorkerAPIError("no status")))

    def test_a_wrapped_404_is_still_missing_audio(self):
        # The download happens in the prefetcher, so the 404 arrives wrapped.
        wrapped = worker_api.PrefetchDownloadError(
            {"uri": "library://track/1"}, worker_api.WorkerAPIError("gone", status=404)
        )
        self.assertTrue(worker_api.is_missing_audio(wrapped))

    def test_a_missing_file_does_not_stop_the_run(self):
        # Regression: one deleted file used to end the run without advancing the
        # cursor, so every 12-hour run retried the same page and no later track
        # was ever embedded. The second track here is perfectly good.
        client = _FakeWorkerClient()
        client.recipe = worker_api.build_recipe(0.1, 60.0, "kapre")
        client.missing = {"library://track/1"}

        core = _FakeCore()
        with tempfile.TemporaryDirectory() as tmp:
            args = _FakeArgs(
                hop=0.1,
                state_file=str(Path(tmp) / "state.json"),
                dry_run=False,
                limit=10,
            )
            code = worker_api.run_api_worker(core, args, client)
        self.assertEqual(code, 0)
        # The good track on the same page was still embedded and uploaded.
        self.assertEqual(len(core.calls), 1)
        self.assertEqual(len(client.uploads), 1)
        self.assertEqual(client.uploads[0][0]["uri"], "library://track/2")


class RecipeTests(unittest.TestCase):
    def test_recipe_reports_the_recipe_that_produced_the_vectors(self):
        recipe = worker_api.build_recipe(0.5, 60.0, "kapre")
        self.assertEqual(
            recipe,
            {
                "model": "openl3-512",
                "hopSeconds": 0.5,
                "maxSampleSeconds": 60.0,
                "frontend": "kapre",
            },
        )

    def test_recipe_rejects_a_nonsensical_hop(self):
        for bad in (0.0, -1.0, float("inf"), float("nan")):
            with self.subTest(hop=bad):
                with self.assertRaises(worker_api.WorkerAPIValidationError):
                    worker_api.build_recipe(bad, 60.0, "kapre")

    def test_a_payload_without_a_recipe_is_refused(self):
        item = {
            "uri": "library://track/1",
            "name": "Example",
            "artist": ["Someone"],
            "album": "Record",
            "model": "openl3-512",
            "embedding": [0.25] * 512,
        }
        with self.assertRaises(worker_api.WorkerAPIValidationError):
            worker_api.build_embeddings_payload([item])
