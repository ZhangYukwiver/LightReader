# 轻阅 · LightReader

一款隐私优先、专注阅读的 Android TXT / DOCX 阅读器。它把文件导入、批注、全文搜索、格式保留编辑和可选 AI 阅读助手放在同一个轻量流程里；不要求账号，也不强制使用云端服务。

## 适合谁

- 想在手机上安静阅读长篇 TXT 或 Word 文档的人。
- 需要边读边做批注、回到上次进度，并把修改后的 Word 导出的人。
- 想使用自己的 AI 服务商，而不是把阅读流程锁定在单一平台的人。

## 主要能力

- **TXT / DOCX 导入**：通过 Android 系统文件选择器打开本地文件；TXT 支持 UTF-8、UTF-16 和 GB18030 常见编码。
- **长文阅读**：大文本分块加载，保留阅读进度；支持字号、行距、段落间距、浅色/深色主题。
- **DOCX 解析与编辑**：识别标题、列表、表格、段落对齐、底色和常见文字样式；编辑后尽量保留原 Word 包结构并导出。
- **批注工作流**：选中文字添加批注，支持全局批注、批注列表、冲突检查，以及把 AI 回答加入批注。
- **搜索与目录**：在当前文档内搜索；TXT 章节和 Word 标题可生成目录。
- **可选 AI 助手**：支持 Responses 和 Chat Completions 两类协议，可保存多个渠道；Responses 渠道可按服务商能力启用联网搜索与引用。
- **最近文件**：记录最近打开项目，可置顶或移除；原始文件不会被应用覆盖，DOCX 修改以私有草稿保存。

## 与常见同类产品的区别

下表按产品形态概括，具体行为会随产品版本和服务商而变化。

| 维度 | 轻阅 | 通用办公套件 | 云端 AI 阅读器 | 传统 TXT 阅读器 |
| --- | --- | --- | --- | --- |
| 核心目标 | 手机端专注阅读 + 批注 | 全面的编辑、协作和办公 | 围绕对话和摘要阅读 | 只解决纯文本阅读 |
| 数据路径 | 本地优先；AI 仅在主动发送时出网 | 常见功能较重，常与账号/云盘结合 | 通常需要上传文档到服务端 | 多数只在本地处理 |
| DOCX 体验 | 样式感知、可编辑、尽量保留原包后导出 | 编辑能力强，但阅读流程更复杂 | 依赖服务端解析，离线能力有限 | 往往不支持或只做纯文本化 |
| AI 选择 | 用户自带 HTTPS 渠道，可切换服务商 | 取决于套件内置服务 | 常绑定单一模型或订阅 | 通常没有 |
| 使用负担 | 无账号、无强制同步、界面聚焦 | 功能多，学习和资源成本更高 | 依赖网络、账号与服务策略 | 功能轻，但扩展性有限 |

轻阅的取舍很明确：不追求办公套件的“大而全”，而是把本地阅读、可恢复的批注和可控的 AI 辅助做成一条短路径。

## 隐私与安全

- **默认不联网**：仓库中的网络请求只用于用户主动配置并发送的 AI 请求；本项目没有账号系统、埋点或云端同步代码。
- **密钥不进 WebView**：API Key 使用 Android Keystore 加密保存，网页层只收到 `hasKey` 状态，不会读回密钥明文。
- **HTTPS 强制**：AI 地址必须是 HTTPS；应用关闭明文流量，并拒绝把外部链接加载进本地阅读页。
- **解析边界**：DOCX XML 禁用 DOCTYPE、外部实体和外部 DTD；导入、解析、响应和编辑草稿都有大小上限。
- **输出转义**：DOCX 内容写入本地 HTML/XML 前会转义，避免文档文本被当成脚本执行。
- **本机数据隔离**：批注、阅读进度和 DOCX 草稿保存在应用私有存储；系统级备份是否启用由 Android 设备设置决定。
- **发布防线**：`local.properties`、构建产物、IDE 文件、签名文件和常见密钥文件已加入忽略规则；提交前仍应人工检查暂存区。

使用 AI 时，选中文字或问题会发送到所选服务商。请不要把敏感材料发送给未经信任的服务商，并为不同用途使用最小权限、可撤销的 API Key。

更具体的漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 快速开始

环境要求：Android Studio、JDK 17、Android SDK 36，以及可执行的 Android SDK Platform 26+。

```bash
git clone https://github.com/ZhangYukwiver/LightReader.git
cd LightReader
./gradlew assembleDebug
```

生成的调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。也可以直接在 Android Studio 中打开项目并运行 `app` 配置。

发布前的基础检查：

```bash
./gradlew assembleDebug
./gradlew lintDebug
```

`app/src/test` 中保留了可从主方法运行的 DOCX/AI smoke check；它们不是 JUnit 测试，因此不会被 Gradle 的 `test` 任务自动发现。

首次启动后：

1. 点击“导入”，从系统文件选择器选择 TXT 或 DOCX。
2. 选中文字即可添加批注、搜索或调用 AI 讲解/翻译。
3. DOCX 修改完成后点击“显示”进入编辑，再通过“导出 DOCX”保存副本。
4. 如需 AI，在“渠道设置”中填写服务商地址、模型和自己的 API Key；不配置也不影响本地阅读。

## 项目结构

```text
app/src/main/java/com/lightreader/app/
├── MainActivity.java          # 文件选择、WebView 容器和本地持久化
├── DocxRenderer.java          # 安全解析 WordprocessingML 并生成本地 HTML
├── DocxStyledExporter.java     # 将编辑后的样式块写回 DOCX
├── DocxPreservingExporter.java # 保留原包部件并附加批注
├── DocxExporter.java           # 无原包时的最小 DOCX 导出
├── AiClient.java               # HTTPS AI 请求与响应/引用解析
└── SecretStore.java            # Android Keystore 加密存储
```

界面和阅读交互集中在 `app/src/main/assets/reader.html`，通过受限的 JavaScript bridge 调用原生能力。

## 当前边界

- 目前只支持 TXT 和 DOCX，不是 PDF/EPUB 阅读器。
- 单个导入文件上限 20 MB；DOCX 渲染 HTML 和编辑草稿也有独立上限。
- AI 协议兼容性取决于服务商是否遵循对应接口；联网搜索需要 Responses 服务商支持 `web_search`。
- 当前没有云端同步、账号体系、多人协作或正式签名发布版 APK。

## 版本与许可证

当前应用版本为 `0.1.3`，项目仍处于早期迭代阶段。仓库暂未声明开源许可证；如需允许第三方复用，请由维护者确认后补充许可证文件。
