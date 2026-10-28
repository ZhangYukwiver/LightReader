#!/usr/bin/env python3
"""Reproducible, source-verified reading evaluation; no provider SDK or invented outputs."""
import argparse
import collections
import csv
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import select
import shutil
import statistics
import subprocess
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parents[1]
EVAL = ROOT / "eval"
BUILD = ROOT / "build/reading-eval"
PREPARED = BUILD / "prepared"
VARIANTS = ("before", "after")
TASK_NAMES = {"explain": "解释", "translate": "翻译", "followup": "追问", "setup": "追问前置讲解"}
WEIGHTS = {"grounding": 30, "accuracy": 30, "clarity": 20, "task": 10, "format": 10}
SCORE_FIELDS = ["blind_id", "reviewer", "reviewed_at", "review_kind", *WEIGHTS,
                "critical_failure", "failure_category", "evidence", "reason"]


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def normalized(value):
    # Only normalize line wrapping; preserve wording, punctuation, variants and source markers.
    return re.sub(r"\s+", " ", value).strip()


class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.ignored = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.ignored += 1
        if tag in ("p", "div", "br", "h1", "h2", "h3"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.ignored = max(0, self.ignored - 1)

    def handle_data(self, text):
        if not self.ignored:
            self.parts.append(text)


def command(args, **kwargs):
    return subprocess.run([str(a) for a in args], cwd=ROOT, check=True, capture_output=True, **kwargs)


def download(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    # curl uses the host trust configuration. Never disable TLS verification.
    command(["curl", "--fail", "--location", "--silent", "--show-error",
             "--max-time", "40", url, "-o", temporary])
    temporary.replace(path)


def validate(refresh=False):
    cases, sources = read_json(EVAL / "cases.json"), read_json(EVAL / "sources.json")
    if len(cases) != 24 or collections.Counter(c["task"] for c in cases) != {
            "explain": 8, "translate": 8, "followup": 8}:
        raise ValueError("材料必须为 24 段，三种任务各 8 段")
    if len({c["id"] for c in cases}) != len(cases) or len({c["quote"] for c in cases}) != len(cases):
        raise ValueError("重复的材料 ID 或选文")
    evidence, texts = {}, {}
    for name, source in sources.items():
        path = BUILD / "sources" / (name + ".raw")
        if refresh or not path.exists():
            download(source["url"], path)
        data = path.read_bytes()
        text = data.decode("utf-8-sig")
        if source["format"] == "html":
            parser = HtmlText()
            parser.feed(text)
            text = "".join(parser.parts)
        texts[name] = normalized(text)
        evidence[name] = {**source, "source_sha256": digest(data),
                          "cached_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                          "excerpts": []}
    for case in cases:
        if len(case["quote"]) > 8000 or len(case["expected"]) < 2 or not case["failure_watch"]:
            raise ValueError(f"材料不完整或超过应用选文上限：{case['id']}")
        if case["task"] == "followup" and not case.get("followup"):
            raise ValueError(f"缺少真实追问：{case['id']}")
        if case["task"] == "translate" and case.get("target") not in ("English", "简体中文", "日本語"):
            raise ValueError(f"目标语言不受应用支持：{case['id']}")
        text, quote = texts[case["source"]], normalized(case["quote"])
        offset = text.find(quote)
        if offset < 0:
            raise ValueError(f"选文无法在来源逐字匹配：{case['id']}，请人工检查来源变动")
        evidence[case["source"]]["excerpts"].append({
            "case_id": case["id"], "section": case["section"],
            "normalized_source_offset": offset, "length": len(quote),
            "quote_sha256": digest(case["quote"].encode("utf-8")), "verbatim_match": True})
    save_json(BUILD / "source-evidence.json", evidence)
    return cases, sources


def java_tools():
    candidates = [os.environ.get("JAVA_HOME"),
                  str(Path.home() / ".cache/lightreader-toolchain/jdk-17/Contents/Home")]
    for candidate in candidates:
        if candidate and (Path(candidate) / "bin/javac").exists():
            return Path(candidate) / "bin/java", Path(candidate) / "bin/javac"
    if shutil.which("java") and shutil.which("javac"):
        return Path(shutil.which("java")), Path(shutil.which("javac"))
    raise ValueError("需要 JDK 17，请配置 JAVA_HOME")


class Rpc:
    def __init__(self, args, env=None):
        self.process = subprocess.Popen([str(a) for a in args], cwd=ROOT, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)

    def call(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], 90)
        if not ready:
            self.process.kill()
            raise RuntimeError("评测子进程超过 90 秒，已停止；该条不能当作服务端耗时")
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("评测子进程退出；检查 JDK、依赖或运行环境")
        result = json.loads(line)
        if "adapter_error" in result:
            raise RuntimeError(result["adapter_error"])
        return result

    def close(self):
        try:
            self.process.stdin.close()
            self.process.wait(timeout=2)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait()
        finally:
            self.process.stdout.close()


def prepare():
    cases, sources = validate()
    config = read_json(EVAL / "config.json")
    if config["protocol"] != "chat" or config["webSearch"] is not False:
        raise ValueError("这轮固定 Chat 协议且关闭联网；调整实验设计需同步更新标准")
    java, javac = java_tools()
    jar = BUILD / "deps/json-20240303.jar"
    if not jar.exists():
        download(config["json_jar_url"], jar)
    if digest(jar.read_bytes()) != config["json_jar_sha256"]:
        raise ValueError("org.json 依赖校验失败")
    manifest = {"prepared_at": now(), "config": config, "files": {}, "variants": {},
                "java": str(java), "case_count": 24, "planned_requests_per_round": 64,
                "timing_scope": "host JVM AiClient.request; normalization separate; TTFT and Android UI not measured"}
    for filename in ("cases.json", "sources.json", "rubric.md", "config.json",
                     "AiEvalRunner.java", "reader_adapter.mjs", "evaluate.py"):
        manifest["files"][filename] = digest((EVAL / filename).read_bytes())
    manifest["source_evidence_sha256"] = digest((BUILD / "source-evidence.json").read_bytes())
    planned = []
    for variant in VARIANTS:
        ref = config[variant]
        sha = command(["git", "rev-parse", "--verify", ref + "^{commit}"]).stdout.decode().strip()
        if sha != ref:
            raise ValueError("对照版本必须固定到完整 commit SHA")
        directory = PREPARED / variant
        directory.mkdir(parents=True, exist_ok=True)
        hashes = {}
        for path, filename in (("app/src/main/java/com/lightreader/app/AiClient.java", "AiClient.java"),
                               ("app/src/main/assets/reader.html", "reader.html")):
            content = command(["git", "show", f"{sha}:{path}"]).stdout
            (directory / filename).write_bytes(content)
            hashes[filename] = digest(content)
        classes = directory / "classes"
        classes.mkdir(exist_ok=True)
        command([javac, "-encoding", "UTF-8", "-cp", jar, "-d", classes,
                 directory / "AiClient.java", EVAL / "AiEvalRunner.java"])
        classpath = os.pathsep.join((str(classes), str(jar)))
        java_args = [str(java), "-cp", classpath, "com.lightreader.app.AiEvalRunner"]
        description = json.loads(command(java_args + ["describe", config["baseUrl"], config["protocol"]]).stdout)
        manifest["variants"][variant] = {"sha": sha, "hashes": hashes, "java_args": java_args, **description}
        adapter = Rpc(["node", EVAL / "reader_adapter.mjs", directory / "reader.html"])
        try:
            for case in cases:
                mode = "translate" if case["task"] == "translate" else "explain"
                first = adapter.call({"op": "prompt", "quote": case["quote"], "mode": mode,
                                      "target": case.get("target"), "raw": ""})["prompt"]
                planned.append({"case_id": case["id"], "variant": variant, "phase": "initial", "prompt": first})
                if case["task"] == "followup":
                    followup = adapter.call({"op": "prompt", "quote": case["quote"], "mode": "chat",
                                             "raw": case["followup"]})["prompt"]
                    planned.append({"case_id": case["id"], "variant": variant, "phase": "followup", "prompt": followup})
        finally:
            adapter.close()
    save_json(PREPARED / "manifest.json", manifest)
    save_json(PREPARED / "requests.json", planned)
    cards = ["# 24 段真实阅读材料", "", "来源已逐段按空白规范化后逐字匹配；用字、标点、强调和脚注标记保持来源版本。", ""]
    for case in cases:
        source = sources[case["source"]]
        cards += [f"## {case['id']} · {TASK_NAMES[case['task']]} · {case['difficulty']}", "",
                  f"[{source['title']}]({source['url']}) · {case['section']} · {case['language']}", "",
                  case["quote"], ""]
        if case.get("target"):
            cards += ["目标语言：" + case["target"], ""]
        if case.get("followup"):
            cards += ["先真实讲解，再追问：" + case["followup"], ""]
        cards += ["评分要点：", "", *["- " + item for item in case["expected"]], "",
                  "待观察失败（尚未发生）：" + "、".join(case["failure_watch"]), ""]
    (BUILD / "materials.md").write_text("\n".join(cards), encoding="utf-8")
    pending = ["# DeepSeek V4 Flash 阅读评测试评状态", "", "状态：准备已完成，尚未发出真实模型请求。", "",
               "- 材料：24 段，解释、翻译、追问各 8 段；逐字来源核验 24/24。",
               "- 对照：4847210（0.1.2）→ 675630c（0.1.3 纯文本调整）。",
               "- 模型：deepseek-v4-flash，Chat，官方 HTTPS，关闭联网。",
               "- 计划：64 次真实请求；前后各 32 次（含追问前置讲解）。",
               "- 输出、评分、典型失败、请求耗时、改善幅度：均未采集，不填推测值。", "",
               "[材料全文](materials.md) · [来源核验](source-evidence.json) · [版本及标准快照](prepared/manifest.json)", ""]
    (BUILD / "status.md").write_text("\n".join(pending), encoding="utf-8")
    return cases, manifest, planned


def percentile95(values):
    return sorted(values)[math.ceil(0.95 * len(values)) - 1] if values else None


def quality(score):
    total = sum(int(score[k]) / 3 * w for k, w in WEIGHTS.items())
    passed = total >= 80 and int(score["grounding"]) >= 2 and int(score["accuracy"]) >= 2 and score["critical_failure"] == "0"
    return total, passed


def paired(records, scores):
    groups = collections.defaultdict(dict)
    for record in records:
        if record["primary"] and record["status"] == "ok" and record["record_id"] in scores:
            groups[(record["round"], record["case_id"])][record["variant"]] = record
    return [group for group in groups.values() if set(group) == set(VARIANTS)]


def review_package(directory, records, cases):
    case_map = {case["id"]: case for case in cases}
    successful = [r for r in records if r["status"] == "ok"]
    random.SystemRandom().shuffle(successful)
    mapping, rows, pages = {}, [], ["# 匿名评分包", "", "按冻结标准评分；这里不显示版本或响应耗时。前置轮使用通用解释标准。", ""]
    for index, record in enumerate(successful, 1):
        blind_id = f"B{index:03d}"
        mapping[blind_id] = record["record_id"]
        rows.append({"blind_id": blind_id})
        case = case_map[record["case_id"]]
        criteria = case["expected"] if record["primary"] else ["准确解释选段主旨、关键词及关系；补充与原文分开；先结论再必要解释。"]
        pages += [f"## {blind_id} · {record['case_id']} · {TASK_NAMES[record['metric_task']]}", "", "原文：", "",
                  "```text", case["quote"], "```", "", "本轮发送的问题：", "", "```text", record["prompt"], "```", ""]
        if record["history"]:
            pages += ["上一轮显示回答：", "", "```text", record["history"][-1]["text"], "```", ""]
        pages += ["本轮显示回答：", "", "```text", record["displayed_text"], "```", "",
                  "评分要点：", "", *["- " + point for point in criteria], ""]
    save_json(directory / "blind-map.json", mapping)
    with (directory / "scores.csv").open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=SCORE_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    (directory / "review.md").write_text("\n".join(pages), encoding="utf-8")


def load_scores(directory, records):
    scores, lookup = {}, {r["record_id"]: r for r in records}
    mapping = read_json(directory / "blind-map.json")
    with (directory / "scores.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            fields = [row.get(k, "").strip() for k in SCORE_FIELDS if k != "blind_id"]
            if not any(fields):
                continue
            if row["blind_id"] not in mapping:
                raise ValueError("评分包含未知盲评 ID")
            record_id = mapping[row["blind_id"]]
            if record_id in scores:
                raise ValueError("评分包含重复盲评 ID")
            if any(row.get(k) not in ("0", "1", "2", "3") for k in WEIGHTS):
                raise ValueError(f"评分未完成或超范围：{row['blind_id']}")
            if row.get("critical_failure") not in ("0", "1") or not row.get("reviewer", "").strip():
                raise ValueError("需填写评审人和严重失败标记 0/1")
            if row.get("review_kind") not in ("human", "assistant"):
                raise ValueError("review_kind 应为 human 或 assistant")
            datetime.fromisoformat(row["reviewed_at"])
            has_failure = row["critical_failure"] == "1" or any(row[k] != "3" for k in WEIGHTS)
            if has_failure:
                evidence = row.get("evidence", "").strip()
                record = lookup[record_id]
                if not evidence or not (evidence in record["raw_text"] or evidence in record["displayed_text"]):
                    raise ValueError(f"扣分证据必须是原始或显示回答的真实片段：{row['blind_id']}")
                if not row.get("reason", "").strip() or not row.get("failure_category", "").strip():
                    raise ValueError("扣分需填写原因和失败分类")
            scores[record_id] = row
    return scores


def report(directory):
    directory = Path(directory).resolve()
    records = [json.loads(line) for line in (directory / "records.jsonl").read_text().splitlines() if line.strip()]
    manifest = read_json(directory / "run.json")
    scores = load_scores(directory, records)
    pairs = paired(records, scores)
    successful = [r for r in records if r["status"] == "ok"]
    expected = manifest["repeat"] * 64
    pages = ["# 阅读助手前后对比报告", "", f"运行：{directory.name}", "",
             f"模型：{manifest['prepared']['config']['model']}；版本 4847210 → 675630c。",
             f"真实请求有计时的记录 {sum(r.get('request_ms') is not None for r in records)}/{expected}；"
             f"成功回答 {len(successful)}；已评分 {len(scores)}/{len(successful)}；完整最终轮评分配对 {len(pairs)}/{24 * manifest['repeat']}。", "",
             "缺失、失败和未评分不计为 0 分；以下内容质量只统计双边成功且均已评分的最终任务轮。", "",
             "| 任务 | 完整配对 | 调整前均分 | 调整后均分 | 均分变化 | 通过 前→后 | 改善/持平/退步 |",
             "| --- | ---: | ---: | ---: | ---: | --- | --- |"]
    for task in ("all", "explain", "translate", "followup"):
        selected = [p for p in pairs if task == "all" or p["before"]["metric_task"] == task]
        label = "全部最终轮" if task == "all" else TASK_NAMES[task]
        if not selected:
            pages.append(f"| {label} | 0 | 待评分 | 待评分 | 未知 | 未知 | 未知 |")
            continue
        before = [quality(scores[p["before"]["record_id"]]) for p in selected]
        after = [quality(scores[p["after"]["record_id"]]) for p in selected]
        deltas = [b[0] - a[0] for a, b in zip(before, after)]
        pages.append(f"| {label} | {len(selected)} | {statistics.mean(v[0] for v in before):.1f} | "
                     f"{statistics.mean(v[0] for v in after):.1f} | {statistics.mean(deltas):+.1f} | "
                     f"{sum(v[1] for v in before)}/{len(selected)} → {sum(v[1] for v in after)}/{len(selected)} | "
                     f"{sum(d > 0.001 for d in deltas)}/{sum(abs(d) <= 0.001 for d in deltas)}/{sum(d < -0.001 for d in deltas)} |")
    pages += ["", "## 完整响应耗时", "", "宿主 JVM 请求至完整解析，单位毫秒；非首字时间、非 Android UI 时间。仅成功请求参与分位数，失败数另列。", "",
              "| 版本 | 任务 | 成功/记录 | 失败/未执行 | 中位数 | P95 | 最大值 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for variant in VARIANTS:
        for task in ("all", "explain", "translate", "followup", "setup"):
            selected = [r for r in records if r["variant"] == variant and (task == "all" or r["metric_task"] == task)]
            values = [r["request_ms"] for r in selected if r["status"] == "ok"]
            stats = f"{statistics.median(values):.1f} | {percentile95(values):.1f} | {max(values):.1f}" if values else "未采集 | 未采集 | 未采集"
            pages.append(f"| {variant} | {'全部请求' if task == 'all' else TASK_NAMES[task]} | {len(values)}/{len(selected)} | {len(selected) - len(values)} | {stats} |")
    pages += ["", "## 逐段最终轮比较", "", "全部案例保留；具体回答见 records.jsonl 和 review.md。未完成配对明确显示。", "",
              "| 轮次/材料 | before 状态/分数/耗时ms | after 状态/分数/耗时ms |", "| --- | --- | --- |"]
    indexed = {(r["round"], r["case_id"], r["variant"]): r for r in records if r["primary"]}
    for round_id in range(1, manifest["repeat"] + 1):
        for case in read_json(directory / "cases.json"):
            cells = []
            for variant in VARIANTS:
                item = indexed.get((round_id, case["id"], variant))
                if item is None:
                    cells.append("未执行 / — / —")
                    continue
                score = scores.get(item["record_id"])
                score_label = f"{quality(score)[0]:.1f}" if score else "未评分"
                timing = f"{item['request_ms']:.1f}" if item.get("request_ms") is not None else "—"
                cells.append(f"{item['status']} / {score_label} / {timing}")
            pages.append(f"| {round_id}/{case['id']} | {' | '.join(cells)} |")
    pages += ["", "## 失败证据", ""]
    failures = 0
    for record in records:
        score = scores.get(record["record_id"])
        if record["status"] != "ok":
            failures += 1
            pages += [f"- {record['record_id']}：{record['status']}；{record.get('error', '前置请求未成功')}；"
                      f"请求耗时 {record.get('request_ms', '未采集')} ms。"]
        elif score and (score["critical_failure"] == "1" or any(score[k] != "3" for k in WEIGHTS)):
            failures += 1
            pages += [f"### {record['record_id']} · {score['failure_category']}", "",
                      f"严重失败：{score['critical_failure']}；评审：{score['reviewer']}（{score['review_kind']}，{score['reviewed_at']}）", "",
                      "```text", score["evidence"], "```", "", score["reason"], ""]
    if not failures:
        pages += ["尚无已记录失败；若评分未完成，这不表示没有失败。"]
    comparison = ["# 逐段原文及输出对照", "", "包含原始返回文字和应用显示文字；没有回答时明确显示状态。", ""]
    for round_id in range(1, manifest["repeat"] + 1):
        for case in read_json(directory / "cases.json"):
            comparison += [f"## 第 {round_id} 轮 · {case['id']} · {TASK_NAMES[case['task']]}", "",
                           "原文：", "", "```text", case["quote"], "```", ""]
            if case.get("followup"):
                comparison += ["追问：" + case["followup"], ""]
            for variant in VARIANTS:
                item = indexed.get((round_id, case["id"], variant))
                comparison += [f"### {variant}", ""]
                if not item or item["status"] != "ok":
                    comparison += [item["status"] if item else "未执行", ""]
                    continue
                comparison += [f"请求 {item['request_ms']:.1f} ms；文字处理 {item['normalize_ms']:.3f} ms。", "",
                               "原始返回：", "", "```text", item["raw_text"], "```", "",
                               "应用显示：", "", "```text", item["displayed_text"], "```", ""]
    (directory / "comparison.md").write_text("\n".join(comparison), encoding="utf-8")
    pages += ["", "[逐段原文与完整输出对照](comparison.md) · [匿名评分包](review.md)", "",
              "## 未完成与限制", "", f"- 运行状态：{manifest['status']}。",
              f"- 尚缺 {expected - len(records)} 条执行记录、{len(successful) - len(scores)} 条成功输出评分。",
              "- 单轮小样本试评，不据此声称统计显著；供应商默认采样和思考设置可能变化。",
              "- 原始模型文字指 AiClient 返回、尚未经过纯文本清洗的文字；客户端不暴露 token 使用量或服务端模型快照。",
              "- 本轮未验证 Android 真机/UI、联网搜索、日语、现代文档或长历史。", ""]
    (directory / "report.md").write_text("\n".join(pages), encoding="utf-8")
    return directory / "report.md"


def run(repeat, ask_key=False):
    cases, prepared, planned = prepare()
    key = os.environ.get("LIGHTREADER_EVAL_API_KEY", "").strip()
    key_path = Path(os.environ.get("LIGHTREADER_EVAL_KEY_FILE", str(EVAL / ".api-key.local"))).expanduser()
    if not key and key_path.exists():
        key = key_path.read_text().strip()
    if not key and ask_key:
        key = getpass.getpass("DeepSeek API Key（不回显，仅本次进程使用）: ").strip()
    if not key:
        with (BUILD / "status.md").open("a", encoding="utf-8") as handle:
            handle.write("\n阻塞：未配置 LIGHTREADER_EVAL_API_KEY，且 eval/.api-key.local 不存在或为空。"
                         "没有发出模型请求，不能提供前后输出、典型模型失败或实际响应耗时。\n")
        raise ValueError("真实评测尚未启动：缺少 API Key。可在 eval/.api-key.local 写入密钥；此文件已忽略。")
    if "\n" in key or "\r" in key:
        raise ValueError("密钥文件只应包含一行密钥本身")
    directory = BUILD / "runs" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    directory.mkdir(parents=True, exist_ok=False)
    os.chmod(directory, 0o700)
    for filename in ("cases.json", "sources.json", "rubric.md", "config.json", "AiEvalRunner.java", "reader_adapter.mjs", "evaluate.py"):
        shutil.copy2(EVAL / filename, directory / filename)
    shutil.copy2(BUILD / "source-evidence.json", directory / "source-evidence.json")
    shutil.copy2(PREPARED / "requests.json", directory / "requests.json")
    manifest = {"started_at": now(), "prepared": prepared, "repeat": repeat, "status": "running"}
    save_json(directory / "run.json", manifest)
    plan = {(p["case_id"], p["variant"], p["phase"]): p["prompt"] for p in planned}
    config = prepared["config"]
    channel = {k: config[k] for k in ("baseUrl", "model", "protocol")}
    env = {**os.environ, "LIGHTREADER_EVAL_API_KEY": key}
    clients, adapters, records = {}, {}, []
    print(f"运行目录：{directory}；计划 {repeat * 64} 次真实请求", flush=True)
    try:
        for variant in VARIANTS:
            clients[variant] = Rpc(prepared["variants"][variant]["java_args"], env=env)
            adapters[variant] = Rpc(["node", directory / "reader_adapter.mjs", PREPARED / variant / "reader.html"])
        with (directory / "records.jsonl").open("a", encoding="utf-8") as output:
            for round_id in range(1, repeat + 1):
                for index, case in enumerate(cases):
                    order = VARIANTS if (index + round_id - 1) % 2 == 0 else tuple(reversed(VARIANTS))
                    for variant in order:
                        history = []
                        phases = ("initial", "followup") if case["task"] == "followup" else ("initial",)
                        for phase in phases:
                            primary = phase == "followup" or case["task"] != "followup"
                            prompt = plan[(case["id"], variant, phase)]
                            record = {"record_id": f"{round_id}-{case['id']}-{variant}-{phase}",
                                      "case_id": case["id"], "round": round_id, "variant": variant,
                                      "phase": phase, "primary": primary,
                                      "metric_task": case["task"] if primary else "setup",
                                      "started_at": now(), "prompt": prompt, "history": list(history)}
                            if phase == "followup" and not history:
                                record.update(status="skipped_setup_failed", request_ms=None)
                            else:
                                try:
                                    result = clients[variant].call({"channel": channel, "history": history, "prompt": prompt})
                                    record.update(result)
                                    if result["status"] == "ok":
                                        clean = adapters[variant].call({"op": "normalize", "text": result["raw_text"]})
                                        record.update(displayed_text=clean["text"], normalize_ms=clean["normalize_ms"])
                                        if phase == "initial" and case["task"] == "followup":
                                            history = [{"role": "user", "text": "请解释选中文字"},
                                                       {"role": "assistant", "text": clean["text"]}]
                                except (RuntimeError, BrokenPipeError) as error:
                                    record.update(status="harness_error", error=str(error))
                                    record.setdefault("request_ms", None)
                            records.append(record)
                            output.write(json.dumps(record, ensure_ascii=False) + "\n")
                            output.flush()
                            print(f"{len(records)}/{repeat * 64} {record['record_id']} {record['status']}", flush=True)
                            if record["status"] == "harness_error":
                                raise RuntimeError("评测工具中断，已保存可获得的原始响应；后续请求未执行")
                            if record.get("error") and re.search(r"HTTP (401|402|403)", record["error"]):
                                raise RuntimeError("渠道鉴权/额度错误，已停止后续调用；保留失败记录")
        manifest["status"] = "requests_finished_pending_review"
    except BaseException:
        manifest["status"] = "interrupted_or_blocked"
        raise
    finally:
        for process in [*clients.values(), *adapters.values()]:
            process.close()
        manifest["finished_at"] = now()
        save_json(directory / "run.json", manifest)
        (directory / "records.jsonl").touch(exist_ok=True)
        review_package(directory, records, cases)
        report(directory)
        print(f"结果与待评分包已保存：{directory}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    check = sub.add_parser("validate", help="核对真实来源；无模型调用")
    check.add_argument("--refresh-sources", action="store_true")
    sub.add_parser("prepare", help="编译两版原始客户端并冻结材料/标准；无模型调用")
    execute = sub.add_parser("run", help="使用已配置密钥执行真实对比并记录耗时")
    execute.add_argument("--repeat", type=int, default=1)
    execute.add_argument("--ask-key", action="store_true", help="在终端不回显输入密钥，不写入文件")
    summarize = sub.add_parser("report", help="核验 scores.csv 并汇总已完成配对")
    summarize.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "validate":
            validate(args.refresh_sources)
            print("24/24 段逐字来源核验通过；这不代表模型评测通过。")
        elif args.action == "prepare":
            prepare()
            print(f"24 段 / 64 次请求计划已准备，两版真实客户端编译通过。\n{BUILD / 'status.md'}")
        elif args.action == "run":
            if args.repeat < 1 or args.repeat > 10:
                raise ValueError("repeat 应为 1—10；每轮 64 次真实请求")
            run(args.repeat, args.ask_key)
        elif args.action == "report":
            print(report(args.directory))
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        # Commands never receive the key as an argument; do not echo captured process streams.
        print(f"评测未完成：{error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
