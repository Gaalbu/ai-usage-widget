import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).parents[1]
MODULE_PATH = ROOT / "ai-usage-widget@gaalbu.github.io" / "collector.py"
SPEC = importlib.util.spec_from_file_location("collector", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class CollectorParserTests(unittest.TestCase):
    def fixture(self, name):
        return json.loads((ROOT / "tests" / "fixtures" / name).read_text())

    def test_claude_windows(self):
        windows = collector.parse_claude_usage(self.fixture("claude_usage.json"))
        self.assertEqual([window["label"] for window in windows], ["5-hour window", "7-day window"])
        self.assertEqual([window["usedPercent"] for window in windows], [43.0, 21.0])

    def test_codex_windows(self):
        windows = collector.parse_codex_usage(self.fixture("codex_usage.json"))
        self.assertEqual([window["label"] for window in windows], ["5-hour window", "1-week window"])
        self.assertEqual([window["usedPercent"] for window in windows], [12.0, 31.0])

    def test_percentages_are_clamped(self):
        self.assertEqual(collector._window("test", 140)["usedPercent"], 100.0)
        self.assertEqual(collector._window("test", -4)["usedPercent"], 0.0)


class CollectorCacheTests(unittest.TestCase):
    NOW = 2_000_000_000
    WINDOWS = [{"label": "5-hour window", "usedPercent": 25.0, "resetLabel": None}]

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = mock.patch.dict(
            os.environ, {"XDG_CACHE_HOME": self.temporary.name}
        )
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def test_fresh_provider_cache_keeps_original_age(self):
        cached_at = self.NOW - 60
        collector._write_cache(
            {
                "version": 2,
                "providers": {
                    "claude": {"cachedAt": cached_at, "windows": self.WINDOWS}
                },
            }
        )
        with (
            mock.patch.object(collector.time, "time", return_value=self.NOW),
            mock.patch.object(
                collector,
                "collect_claude",
                side_effect=collector.CollectorError("offline"),
            ),
            mock.patch.object(
                collector,
                "collect_codex",
                return_value={"status": "ok", "windows": self.WINDOWS},
            ),
        ):
            result = collector.collect_all()

        self.assertEqual(result["providers"]["claude"]["status"], "stale")
        saved = collector._read_cache()
        self.assertEqual(saved["providers"]["claude"]["cachedAt"], cached_at)
        self.assertEqual(saved["providers"]["codex"]["cachedAt"], self.NOW)

    def test_expired_provider_cache_is_not_refreshed(self):
        collector._write_cache(
            {
                "version": 2,
                "providers": {
                    "claude": {
                        "cachedAt": self.NOW - collector.CACHE_MAX_AGE_SECONDS - 1,
                        "windows": self.WINDOWS,
                    }
                },
            }
        )
        with (
            mock.patch.object(collector.time, "time", return_value=self.NOW),
            mock.patch.object(
                collector,
                "collect_claude",
                side_effect=collector.CollectorError("offline"),
            ),
            mock.patch.object(
                collector,
                "collect_codex",
                return_value={"status": "ok", "windows": self.WINDOWS},
            ),
        ):
            result = collector.collect_all()

        self.assertEqual(result["providers"]["claude"]["status"], "error")
        self.assertNotIn("claude", collector._read_cache()["providers"])

    def test_cache_is_private_and_does_not_follow_destination_symlink(self):
        cache_path = collector._cache_path()
        cache_path.parent.mkdir(parents=True)
        target = pathlib.Path(self.temporary.name) / "target.json"
        target.write_text("do not overwrite", encoding="utf-8")
        cache_path.symlink_to(target)

        collector._write_cache({"version": 2, "providers": {}})

        self.assertEqual(target.read_text(encoding="utf-8"), "do not overwrite")
        self.assertFalse(cache_path.is_symlink())
        self.assertEqual(stat.S_IMODE(cache_path.stat().st_mode), 0o600)
        self.assertEqual(collector._read_cache(), {"version": 2, "providers": {}})

    def test_cache_reader_rejects_symlinks(self):
        cache_path = collector._cache_path()
        cache_path.parent.mkdir(parents=True)
        target = pathlib.Path(self.temporary.name) / "target.json"
        target.write_text('{"version":2,"providers":{}}', encoding="utf-8")
        cache_path.symlink_to(target)

        self.assertEqual(collector._read_cache(), {})


if __name__ == "__main__":
    unittest.main()
