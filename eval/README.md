# 阅读助手 24 段前后对比

这轮对照已有的 0.1.3 纯文本调整：before 为 `48472105160b737e94bd1c838454ccb3aee88e65`（0.1.2），after 为 `675630c0b35c613acb9373b6e0c9042c7c2a0af1`（0.1.3）。两版选文提示词相同，变化在纯文本系统指令及回答显示/历史处理。应用代码没有因评测而修改。

模型按用户指定使用 `deepseek-v4-flash`，配置为 DeepSeek 官方 `https://api.deepseek.com/chat/completions`、Chat 协议、关闭联网。模型标识与接口已核对 [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。采样参数、思考模式与 token 上限遵循原客户端行为，使用供应商默认值。

2026-09-12 已完成一轮 64 次真实请求及 Codex 辅助评分：[结果摘要](REPORT.md) · [逐段对照](results/2026-09-12-deepseek-v4-flash/comparison.md) · [完整统计及失败证据](results/2026-09-12-deepseek-v4-flash/report.md)。

## 已交付内容

- [cases.json](cases.json)：24 段真实选文，解释、翻译、追问各 8 段；每段带章节、难度、评分要点、待观察失败。
- [sources.json](sources.json)：7 部公版作品的原文地址及版本说明；中英文各 12 段。
- [rubric.md](rubric.md)：调用前定义的五项判断标准、严重失败门槛、盲评方法、统计口径与边界。
- [evaluate.py](evaluate.py)：直接编译并调用两个固定版本的真实 AiClient；执行原 reader.html 的提示词和显示处理函数。记录原始文字、显示文字、历史、异常及毫秒耗时，生成匿名评分包和逐段对照。

材料来自[《论语》](https://www.gutenberg.org/cache/epub/23839/pg23839.txt)、[《荀子·劝学》](https://zh.wikisource.org/wiki/%E8%8D%80%E5%AD%90/%E5%8B%B8%E5%AD%B8%E7%AF%87)、[《庄子·养生主》](https://zh.wikisource.org/zh/%E8%8E%8A%E5%AD%90/%E9%A4%8A%E7%94%9F%E4%B8%BB)、[Alice’s Adventures in Wonderland](https://www.gutenberg.org/cache/epub/11/pg11.txt)、[Pride and Prejudice](https://www.gutenberg.org/cache/epub/1342/pg1342.txt)、[The Chemical History of a Candle](https://www.gutenberg.org/cache/epub/14474/pg14474.txt)、[On the Origin of Species](https://www.gutenberg.org/cache/epub/1228/pg1228.txt)。只摘原著，保留来源异体字、标点、脚注号；仅折叠换行等空白，不使用现代译文或夹注。

## 准备与离线检查

需要 Python 3.10+、Node.js 18+、JDK 17、Git、curl。可设置 JAVA_HOME；本机既有 lightreader-toolchain 中的 JDK 会自动识别。首次准备从 Maven Central 下载约 80 KB 的 org.json，并校验固定 SHA-256；源码快照及下载均在被 Git 忽略的 build/reading-eval 中。

在仓库根目录执行：

```bash
python3 eval/evaluate.py prepare
python3 -m unittest discover -s eval -p 'test_*.py' -v
```

prepare 不调用模型。它会核验 24 段逐字来源匹配、编译两个历史版本，并生成 [材料阅读版](../build/reading-eval/materials.md)、[核验凭据](../build/reading-eval/source-evidence.json)、[请求及版本快照](../build/reading-eval/prepared/manifest.json) 和 [准备状态](../build/reading-eval/status.md)。需要重新抓取来源时执行 `python3 eval/evaluate.py validate --refresh-sources`；原文漂移导致不匹配会直接报错。

离线测试的固定文本仅用于验证工具，不计入模型质量、失败案例或请求耗时。

## 真实调用

在本机 `eval/.api-key.local` 文件中只写 API Key，一行即可。该文件已加入 Git 忽略；也支持环境变量 `LIGHTREADER_EVAL_API_KEY`，或用 `LIGHTREADER_EVAL_KEY_FILE` 指向已有专用密钥文件。密钥不会进入参数、日志、报告或 Git。

不希望写入文件时，可执行 `python3 eval/evaluate.py run --ask-key`，在终端不回显输入，仅供本次进程使用。

```bash
python3 eval/evaluate.py run
```

默认串行执行 64 次真实请求：24 段 × 两版，再加 8 段追问的两版前置讲解。解释和翻译各调用一次；追问先让该版真实讲解，再把该版显示回答与选文一起用于下一轮。轮内交替 AB/BA 顺序。缺 Key 时在出网前停止；鉴权或额度错误保留记录并停止。普通请求失败保留该次结果；不会自动重试或挑选最好输出。完整重跑使用新的运行目录；`--repeat 3` 表示 192 次真实请求，只有需要增加重复次数时才使用。

程序打印本次运行目录 `eval/results/<时间>/`。运行数据持续落盘；中断后已有记录可保留。该目录保存材料/标准快照、原始记录、评分及报告，便于随项目审阅；下载缓存和编译产物仍留在 build/。本轮首次采集在 build/ 中完成后归档到 results/，归档未改变输出或耗时。报告中的“原始返回”是 AiClient 返回的未清洗文字，不是完整 HTTP 响应；客户端不会暴露服务端模型快照、token 计数或首字时间。

## 评分与汇总

1. 按运行目录保存的 rubric.md 阅读匿名 review.md。不要先看 blind-map.json 或 comparison.md，以降低版本偏好。
2. 在 scores.csv 给每条成功回答填写五个 0—3 分、critical_failure（0/1）、reviewer、reviewed_at（ISO 8601）、review_kind（human/assistant）。扣分时填写 failure_category、evidence（回答中的真实片段）和 reason；评分证据与原始/显示输出不匹配会拒绝汇总。
3. 执行 `python3 eval/evaluate.py report eval/results/<时间>`。生成 report.md 汇总和 comparison.md 原文/输出对照，未执行、未评分和单边成功明确列出。只有完整评分配对才计算改善、持平、退步及通过情况。

五维评分及严重失败不能由字符串命中率代替。响应耗时单独汇总中位数/P95/最大值及失败；request_ms 为宿主 JVM 请求到完整解析，normalize_ms 为宿主文字处理，不代表 Android UI 或首字延迟。

当前材料与标准可直接复用。真实模型输出、典型失败和性能结论只有执行并评分后才成立；准备通过、编译通过和离线测试通过均不等于 DeepSeek 实测通过。
