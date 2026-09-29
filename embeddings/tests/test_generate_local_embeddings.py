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
        # The existing tests decode a 2s clip; the hop tests decode 60s because
        # a hop above the duration is rejected up front.
        assert duration in (2.0, 60.0)
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
    # Hops are recorded so a test can assert the hop actually reaches OpenL3:
    # it changes what the pooled vector represents, not just how long it takes.
    hops = []

    @staticmethod
    def get_audio_embedding(
        audio, sample_rate, model, embedding_size, batch_size, hop_size, verbose
    ):
        assert sample_rate == 48000
        assert model is FakeOpenL3.model
        assert embedding_size == 512
        assert batch_size >= 1
        assert hop_size > 0
        assert verbose == 0
        FakeOpenL3.calls.append(batch_size)
        FakeOpenL3.hops.append(hop_size)
        return np.ones((3, 512), dtype=np.float32), np.arange(3)






class LocalEmbeddingWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # API mode is the only mode left, and it refuses to start without an
        # endpoint. These tests are about hop/mode resolution, not the URL.
        os.environ.setdefault("WORKER_URL", "https://worker-api.example.test")
        os.environ.setdefault("WORKER_TOKEN", "test-token")

    def test_stage_stats_reports_percentiles(self):
        stats = local_embeddings.StageStats()
        stats.add("stage", 1.0)
        stats.add("stage", 3.0)
        summary = stats.summary()["stage"]
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["p50_seconds"], 2.0)
        self.assertEqual(summary["max_seconds"], 3.0)


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
        FakeOpenL3.hops = []
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

    def test_process_audio_file_forwards_the_hop_and_records_it(self):
        # hop_seconds decides how many overlapping windows get mean pooled, so
        # it changes what the vector represents. It must reach OpenL3 and be
        # reported, or embeddings of different recipes become indistinguishable.
        FakeOpenL3.model = object()
        FakeOpenL3.calls = []
        FakeOpenL3.hops = []
        stats = local_embeddings.StageStats()
        with patch.object(local_embeddings, "librosa", FakeLibrosa), patch.object(
            local_embeddings, "openl3", FakeOpenL3
        ):
            vector, timings = local_embeddings.process_audio_file(
                "fixture.mp3", FakeOpenL3.model, 60.0, "fast", stats,
                local_embeddings.DEFAULT_INFER_BATCH_SIZE, 0.5,
            )

        self.assertEqual(vector.shape, (512,))
        self.assertEqual(FakeOpenL3.hops, [0.5])
        self.assertEqual(timings["hop_seconds"], 0.5)
        self.assertEqual(timings["max_sample_seconds"], 60.0)

    def test_process_audio_file_defaults_to_the_openl3_hop(self):
        # Omitting hop must keep OpenL3's own default, so behaviour is unchanged
        # until someone opts in.
        FakeOpenL3.model = object()
        FakeOpenL3.calls = []
        FakeOpenL3.hops = []
        stats = local_embeddings.StageStats()
        with patch.object(local_embeddings, "librosa", FakeLibrosa), patch.object(
            local_embeddings, "openl3", FakeOpenL3
        ):
            _, timings = local_embeddings.process_audio_file(
                "fixture.mp3", FakeOpenL3.model, 60.0, "fast", stats
            )

        self.assertEqual(timings["hop_seconds"], local_embeddings.DEFAULT_HOP_SECONDS)
        self.assertEqual(FakeOpenL3.hops, [local_embeddings.DEFAULT_HOP_SECONDS])

    @staticmethod
    def _parse(argv):
        # parse_args insists on a database URL in local mode; these tests are
        # about how --mode resolves, not about connecting to anything.
        previous = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = "postgresql://unused/unused"
        try:
            return local_embeddings.parse_args(argv)
        finally:
            if previous is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = previous

    def test_mode_maps_to_the_measured_hops(self):
        # low/medium/high are the three measured points, not arbitrary names.
        self.assertEqual(
            local_embeddings.EMBEDDING_MODES,
            {"low": 0.1, "medium": 0.5, "high": 1.0},
        )

    def test_mode_resolves_the_hop_and_defaults_to_low(self):
        # With no EMBEDDING_HOP_SECONDS, --mode alone must decide the hop, and
        # the default has to stay OpenL3's own so behaviour is unchanged.
        for name, expected in local_embeddings.EMBEDDING_MODES.items():
            args = self._parse(["--mode", name])
            self.assertEqual(args.hop, expected, name)

        args = self._parse([])
        self.assertEqual(args.mode, "low")
        self.assertEqual(args.hop, local_embeddings.EMBEDDING_MODES["low"])

    def test_an_exact_hop_overrides_the_mode(self):
        args = self._parse(["--mode", "low", "--hop", "0.25"])
        self.assertEqual(args.hop, 0.25)
        # The mode is still recorded: the recipe identifies what was asked for,
        # and the hop is what was actually used.
        self.assertEqual(args.mode, "low")

    def test_mode_is_case_and_space_insensitive(self):
        # It arrives from an env var written by a person, so " Medium " has to
        # work rather than erroring at 3am.
        args = self._parse(["--mode", " Medium "])
        self.assertEqual(args.hop, local_embeddings.EMBEDDING_MODES["medium"])

    def test_an_unknown_mode_is_rejected(self):
        with self.assertRaises(SystemExit):
            self._parse(["--mode", "turbo"])

    def test_hop_may_not_exceed_duration(self):
        # Every window would be a repeat of the same audio.
        with self.assertRaises(SystemExit):
            self._parse(["--mode", "high", "--duration", "0.5"])

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




    def test_local_mode_is_refused_with_an_explanation(self):
        # Local mode matched track titles against filenames by stripping only a
        # leading "NN - ", which never worked against Plex-sanitised names. The
        # app does the matching now, so the mode is gone rather than left broken.
        with self.assertRaises(SystemExit):
            local_embeddings.parse_args(["--source-mode", "local"])

    def test_args_default_to_tract_compatible_values(self):
        args = local_embeddings.parse_args(
            ["--duration", "2"]
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
                "--infer-batch-size",
                "256",
            ]
        )
        self.assertEqual(args.infer_batch_size, 256)

        for value in ("0", str(local_embeddings.MAX_INFER_BATCH_SIZE + 1)):
            with self.assertRaises(SystemExit) as raised:
                with contextlib.redirect_stderr(io.StringIO()):
                    local_embeddings.parse_args(
                        [
                            "--infer-batch-size",
                            value,
                        ]
                    )
            # Usage errors must not reuse the "pending tracks remain" status.
            self.assertEqual(raised.exception.code, local_embeddings.USAGE_EXIT_CODE)
            self.assertNotEqual(raised.exception.code, 2)

    def test_unknown_flags_exit_with_the_usage_status_not_two(self):
        with self.assertRaises(SystemExit) as raised:
            with contextlib.redirect_stderr(io.StringIO()):
                self._parse(["--not-a-real-flag"])
        self.assertEqual(raised.exception.code, local_embeddings.USAGE_EXIT_CODE)

    def test_api_page_batch_cap_points_at_the_inference_batch_flag(self):
        stderr = io.StringIO()
        with self.assertRaises(SystemExit) as raised:
            with contextlib.redirect_stderr(stderr):
                local_embeddings.parse_args(
                    ["--source-mode", "api", "--batch-size", "64"]
                )
        self.assertEqual(raised.exception.code, local_embeddings.USAGE_EXIT_CODE)
        message = stderr.getvalue()
        self.assertIn("--infer-batch-size", message)
        self.assertIn("EMBEDDING_INFER_BATCH_SIZE", message)

    def test_infer_batch_size_reads_the_environment_default(self):
        with patch.dict(os.environ, {"EMBEDDING_INFER_BATCH_SIZE": "128"}):
            args = local_embeddings.parse_args(
                []
            )
        self.assertEqual(args.infer_batch_size, 128)


if __name__ == "__main__":
    unittest.main()
