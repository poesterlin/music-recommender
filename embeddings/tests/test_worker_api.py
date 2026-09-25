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
        client = worker_api.WorkerAPIClient(
            "https://example.test/base/",
            "secret-token",
            session=session,
            retry_delay=0,
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
        self.assertEqual(post_call[2]["json"], {"embeddings": [item]})
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
