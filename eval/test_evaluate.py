"""Offline harness checks. Fixtures here are not model outputs or evaluation evidence."""
import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import evaluate as ev


class EvaluationChecks(unittest.TestCase):
    def test_real_sources_and_task_balance(self):
        cases, _ = ev.validate()
        self.assertEqual(len(cases), 24)
        self.assertEqual(sum(c["language"] == "English" for c in cases), 12)

    def test_changed_quote_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            cases = ev.read_json(ev.EVAL / "cases.json")
            cases[0]["quote"] += "【仅用于测试的伪造文字】"
            ev.save_json(target / "cases.json", cases)
            ev.save_json(target / "sources.json", ev.read_json(ev.EVAL / "sources.json"))
            with patch.object(ev, "EVAL", target), self.assertRaisesRegex(ValueError, "逐字匹配"):
                ev.validate()

    def test_actual_reader_prompts_and_normalizer(self):
        cases = ev.read_json(ev.EVAL / "cases.json")
        raw = "## 结论\n**十九年**，数千牛。\n`x_y = -3`"
        for variant in ev.VARIANTS:
            adapter = ev.Rpc(["node", ev.EVAL / "reader_adapter.mjs", ev.PREPARED / variant / "reader.html"])
            try:
                explain = adapter.call({"op": "prompt", "mode": "explain", "quote": cases[0]["quote"]})["prompt"]
                self.assertIn(cases[0]["quote"], explain)
                self.assertTrue(explain.startswith("请解释以下选中文字"))
                translation = adapter.call({"op": "prompt", "mode": "translate", "target": "English", "quote": "原文"})["prompt"]
                self.assertIn("翻译成English，只返回译文", translation)
                followup = adapter.call({"op": "prompt", "mode": "chat", "quote": "原文", "raw": "为什么？"})["prompt"]
                self.assertIn("用户问题：为什么？", followup)
                displayed = adapter.call({"op": "normalize", "text": raw})["text"]
                self.assertEqual(displayed, raw if variant == "before" else "结论\n十九年，数千牛。\nx_y = -3")
            finally:
                adapter.close()

    def test_percentile_and_critical_failure_gate(self):
        self.assertIsNone(ev.percentile95([]))
        self.assertEqual(ev.percentile95(list(range(1, 21))), 19)
        scores = {name: "3" for name in ev.WEIGHTS}
        scores["critical_failure"] = "1"
        self.assertEqual(ev.quality(scores), (100, False))

    def test_unpaired_failed_unscored_and_setup_are_excluded(self):
        records, scores = [], {}
        for case in ("paired", "one_sided", "failed", "unscored", "setup"):
            for variant in ev.VARIANTS:
                if case == "one_sided" and variant == "after":
                    continue
                key = case + variant
                records.append({"record_id": key, "case_id": case, "variant": variant, "round": 1,
                                "primary": case != "setup", "status": "request_error" if case == "failed" and variant == "after" else "ok"})
                if not (case == "unscored" and variant == "after"):
                    scores[key] = {}
        pairs = ev.paired(records, scores)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(pairs[0]["before"]["case_id"], "paired")

    def test_review_requires_real_evidence_and_identified_reviewer(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            records = [{"record_id": "fixture", "raw_text": "仅为测试固定文本", "displayed_text": "仅为测试固定文本"}]
            ev.save_json(directory / "blind-map.json", {"B001": "fixture"})
            row = {**{k: "3" for k in ev.WEIGHTS}, "blind_id": "B001", "reviewer": "offline test",
                   "reviewed_at": "2026-09-12T00:00:00+00:00", "review_kind": "assistant", "critical_failure": "0",
                   "accuracy": "1", "failure_category": "test", "evidence": "不存在的片段", "reason": "测试证据校验"}
            def save():
                with (directory / "scores.csv").open("w", newline="", encoding="utf-8") as output:
                    writer = csv.DictWriter(output, fieldnames=ev.SCORE_FIELDS)
                    writer.writeheader()
                    writer.writerow(row)
            save()
            with self.assertRaisesRegex(ValueError, "真实片段"):
                ev.load_scores(directory, records)
            row["evidence"] = "测试固定文本"
            save()
            self.assertIn("fixture", ev.load_scores(directory, records))
            row["reviewer"] = ""
            save()
            with self.assertRaisesRegex(ValueError, "评审人"):
                ev.load_scores(directory, records)

    def test_missing_key_stops_before_any_model_client(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / "status.md").write_text("准备完成\n")
            with patch.object(ev, "prepare", return_value=([], {}, [])), patch.object(ev, "BUILD", directory), \
                 patch.dict(ev.os.environ, {"LIGHTREADER_EVAL_API_KEY": "", "LIGHTREADER_EVAL_KEY_FILE": str(directory / "missing")}), \
                 patch.object(ev, "Rpc") as rpc:
                with self.assertRaisesRegex(ValueError, "缺少 API Key"):
                    ev.run(1)
                rpc.assert_not_called()
                self.assertIn("没有发出模型请求", (directory / "status.md").read_text())

    def test_report_keeps_one_sided_result_out_of_pair_statistics(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            records = [
                {"record_id": "fixture-before", "case_id": "E01", "round": 1, "variant": "before",
                 "primary": True, "metric_task": "explain", "status": "ok", "request_ms": 1000,
                 "normalize_ms": 0.1, "raw_text": "仅用于离线工具测试", "displayed_text": "仅用于离线工具测试"},
                {"record_id": "fixture-after", "case_id": "E01", "round": 1, "variant": "after",
                 "primary": True, "metric_task": "explain", "status": "request_error", "request_ms": 2000,
                 "error": "离线错误夹具"}]
            (directory / "records.jsonl").write_text("\n".join(json.dumps(r) for r in records))
            ev.save_json(directory / "run.json", {"prepared": {"config": {"model": "offline-fixture"}},
                                                  "repeat": 1, "status": "offline_test"})
            ev.save_json(directory / "cases.json", [{"id": "E01", "task": "explain", "quote": "测试材料"}])
            ev.save_json(directory / "blind-map.json", {"B001": "fixture-before"})
            with (directory / "scores.csv").open("w", encoding="utf-8", newline="") as output:
                writer = csv.DictWriter(output, fieldnames=ev.SCORE_FIELDS)
                writer.writeheader()
                writer.writerow({"blind_id": "B001", "reviewer": "offline test", "review_kind": "assistant",
                                 "reviewed_at": "2026-09-12T00:00:00+00:00", "critical_failure": "0",
                                 **{k: "3" for k in ev.WEIGHTS}})
            with patch.object(ev, "BUILD", directory / "cache"):
                path = ev.report(directory)
            content = path.read_text()
            self.assertIn("完整最终轮评分配对 0/24", content)
            self.assertIn("| 全部最终轮 | 0 | 待评分", content)
            self.assertIn("request_error / 未评分 / 2000.0", content)
            self.assertIn("离线错误夹具", content)


if __name__ == "__main__":
    unittest.main()
