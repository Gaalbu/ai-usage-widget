import importlib.util
import json
import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()
