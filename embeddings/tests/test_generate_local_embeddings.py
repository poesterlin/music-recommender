import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np


SCRIPT = Path(__file__).parents[1] / "generate-local-embeddings.py"
SPEC = importlib.util.spec_from_file_location("local_embeddings", SCRIPT)
assert SPEC and SPEC.loader
local_embeddings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(local_embeddings)


class FakeLibrosa:
    @staticmethod
    def load(path, sr=None, mono=True, duration=None):
        assert path.endswith(".mp3")
        assert sr is None
        assert mono is True
        assert duration == 2.0
        return np.ones(44100, dtype=np.float32), 44100

    @staticmethod
    def resample(audio, orig_sr, target_sr):
        assert orig_sr == 44100
        assert target_sr == 48000
        return np.ones(48000, dtype=np.float32)


class FakeModels:
    @staticmethod
    def load_audio_embedding_model(*args, **kwargs):
        assert args == ("mel256", "music", 512)
        assert kwargs == {"frontend": "kapre"}
        return object()


class FakeOpenL3:
    models = FakeModels()
    calls = []

    @staticmethod
    def get_audio_embedding(
        audio, sample_rate, model, embedding_size, batch_size, verbose
    ):
        assert sample_rate == 48000
        assert model is FakeOpenL3.model
        assert embedding_size == 512
        assert batch_size >= 1
        assert verbose == 0
        FakeOpenL3.calls.append(batch_size)
        return np.ones((3, 512), dtype=np.float32), np.arange(3)


class FakeCursor:
    def __init__(self):
        self.calls = []
        self.rowcount = 1

    def execute(self, statement, params=None):
        self.calls.append((statement, params))
        self.rowcount = 1

    def close(self):
        pass


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class LocalEmbeddingWorkerTests(unittest.TestCase):
    def test_vector_literal_validates_shape_and_finiteness(self):
        vector = np.ones(512, dtype=np.float32)
        literal = local_embeddings.vector_literal(vector)
        self.assertTrue(literal.startswith("[1.00000000"))
        with self.assertRaises(ValueError):
            local_embeddings.vector_literal(np.ones(511))
        with self.assertRaises(ValueError):
            vector[0] = np.nan
            local_embeddings.vector_literal(vector)

    def test_stage_stats_reports_percentiles(self):
        stats = local_embeddings.StageStats()
        stats.add("stage", 1.0)
        stats.add("stage", 3.0)
        summary = stats.summary()["stage"]
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["p50_seconds"], 2.0)
        self.assertEqual(summary["max_seconds"], 3.0)

    def test_file_index_is_deterministic_and_supports_track_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Artist" / "Album").mkdir(parents=True)
            (root / "Artist" / "Album" / "01 - Song.mp3").write_bytes(b"mp3")
            (root / "Artist" / "Album" / "02 - Other.flac").write_bytes(b"flac")
            (root / "Artist" / "Album" / "cover.jpg").write_bytes(b"jpg")

            index = local_embeddings.build_file_index(root)
            self.assertEqual(
                index["song"], [str(root / "Artist" / "Album" / "01 - Song.mp3")]
            )
            self.assertEqual(
                index["other"], [str(root / "Artist" / "Album" / "02 - Other.flac")]
            )
            self.assertNotIn("cover", index)

    def test_soundfile_fast_path_matches_librosa_mono_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "stereo.wav"
            expected = np.arange(2000, dtype=np.float32).reshape(1000, 2) / 2000
            local_embeddings.sf.write(path, expected, 44100)
            fast, fast_rate, decoder = local_embeddings.load_audio(path, 60)
            slow, slow_rate = local_embeddings.librosa.load(
                path, sr=None, mono=True, duration=60
            )
        self.assertEqual(decoder, "soundfile")
        self.assertEqual(fast_rate, slow_rate)
        np.testing.assert_array_equal(fast, slow)

    def test_direct_soxr_resampler_matches_librosa_length_and_values(self):
        audio = np.linspace(-1, 1, 88200, dtype=np.float32)
        fast = local_embeddings.resample_audio(audio, 44100, 48000)
        expected = local_embeddings.librosa.resample(
            audio, orig_sr=44100, target_sr=48000
        )
        self.assertEqual(fast.shape, expected.shape)
        np.testing.assert_array_equal(fast, expected)

    def test_process_audio_file_profiles_stages_and_reuses_model(self):
        FakeOpenL3.model = object()
        FakeOpenL3.calls = []
        stats = local_embeddings.StageStats()
        with patch.object(local_embeddings, "librosa", FakeLibrosa), patch.object(
            local_embeddings, "openl3", FakeOpenL3
        ):
            vector, timings = local_embeddings.process_audio_file(
                "fixture.mp3", FakeOpenL3.model, 2.0, "fast", stats
            )

        self.assertEqual(vector.shape, (512,))
        self.assertIn("decode_seconds", timings)
        self.assertIn("inference_seconds", timings)
        self.assertIn("audio_decode", stats.summary())
        self.assertIn("model_inference", stats.summary())
        self.assertEqual(
            FakeOpenL3.calls, [local_embeddings.DEFAULT_INFER_BATCH_SIZE]
        )
        self.assertEqual(
            timings["infer_batch_size"], local_embeddings.DEFAULT_INFER_BATCH_SIZE
        )

    def test_process_audio_file_forwards_a_custom_infer_batch_size(self):
        FakeOpenL3.model = object()
        FakeOpenL3.calls = []
        stats = local_embeddings.StageStats()
        with patch.object(local_embeddings, "librosa", FakeLibrosa), patch.object(
            local_embeddings, "openl3", FakeOpenL3
        ):
            _, timings = local_embeddings.process_audio_file(
                "fixture.mp3", FakeOpenL3.model, 2.0, "fast", stats, 256
            )

        self.assertEqual(FakeOpenL3.calls, [256])
        self.assertEqual(timings["infer_batch_size"], 256)

    def test_transient_database_errors_are_retried(self):
        connection = FakeConnection()
        calls = []

        def operation():
            calls.append(True)
            if len(calls) == 1:
                raise local_embeddings.psycopg2.OperationalError("temporary")
            return "ok"

        self.assertEqual(
            local_embeddings.retry_db_operation(
                connection, operation, 3, 0, "test"
            ),
            "ok",
        )
        self.assertEqual(len(calls), 2)
        self.assertEqual(connection.rollbacks, 1)

    def test_write_batch_checkpoints_successful_vectors_atomically(self):
        connection = FakeConnection()
        written, conflicts = local_embeddings.write_batch(
            connection,
            job_id=17,
            updates=[("track-a", "[1.0]"), ("track-b", "[2.0]")],
            detail={"cursor": "track-b", "processed": 4, "failed": 1},
        )
        self.assertEqual((written, conflicts), (2, 0))
        self.assertEqual(connection.commits, 1)
        checkpoint_sql, checkpoint_params = connection.cursor_instance.calls[-1]
        self.assertIn("UPDATE job_run", checkpoint_sql)
        checkpoint = json.loads(checkpoint_params[0])
        self.assertEqual(checkpoint["processed"], 6)
        self.assertEqual(checkpoint["last_batch_written"], 2)

    def test_parse_detail_tolerates_legacy_or_invalid_values(self):
        self.assertEqual(local_embeddings.parse_detail(None), {})
        self.assertEqual(local_embeddings.parse_detail("not-json"), {})
        self.assertEqual(local_embeddings.parse_detail('{"cursor":"x"}'), {"cursor": "x"})

    def test_args_default_to_tract_compatible_values(self):
        args = local_embeddings.parse_args(
            ["--database-url", "postgresql://example", "--duration", "2"]
        )
        self.assertEqual(args.batch_size, local_embeddings.DEFAULT_BATCH_SIZE)
        self.assertEqual(args.duration, 2.0)
        self.assertFalse(args.dry_run)
        self.assertEqual(
            args.infer_batch_size, local_embeddings.DEFAULT_INFER_BATCH_SIZE
        )

    def test_args_accept_a_raised_infer_batch_size_and_reject_extremes(self):
        args = local_embeddings.parse_args(
            [
                "--database-url",
                "postgresql://example",
                "--infer-batch-size",
                "256",
            ]
        )
        self.assertEqual(args.infer_batch_size, 256)

        for value in ("0", str(local_embeddings.MAX_INFER_BATCH_SIZE + 1)):
            with self.assertRaises(SystemExit):
                with contextlib.redirect_stderr(io.StringIO()):
                    local_embeddings.parse_args(
                        [
                            "--database-url",
                            "postgresql://example",
                            "--infer-batch-size",
                            value,
                        ]
                    )

    def test_infer_batch_size_reads_the_environment_default(self):
        with patch.dict(os.environ, {"EMBEDDING_INFER_BATCH_SIZE": "128"}):
            args = local_embeddings.parse_args(
                ["--database-url", "postgresql://example"]
            )
        self.assertEqual(args.infer_batch_size, 128)


if __name__ == "__main__":
    unittest.main()
