# 轻阅网页端

浏览器本地阅读器。共享 `../app/src/main/assets/reader.html`、笔记和 PDF 实现，通过浏览器适配层替代 Android bridge，不需要 APK、账户、数据库服务或后端 API。

## 启动与构建

需要 Node.js 20+。在本目录执行：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:4173/`；端口被占用时使用 `PORT=4174 npm run dev`。按 Ctrl+C 停止。修改源码后重新执行 `npm run build` 并刷新网页，开发服务器没有自动热更新。

`npm run build` 从共享源码生成 `dist/`，并复制本地 PDF.js、pdf-lib、fflate、SHA-256、Transformers.js 和 ONNX Runtime 依赖及许可证。首次构建会下载固定版本的 BGE 模型并校验 SHA-256，后续复用有效文件；也可单独执行 `npm run prepare:embedding`。无运行时 CDN 请求。`npm start` 仅提供已构建的静态文件，绑定本机地址。部署时把 `dist/` 交给静态托管服务，使用 HTTPS；不要使用 `file://` 直接打开，PDF worker 和浏览器存储需要 HTTP(S) 来源。当前没有配置或发布任何线上站点。

## 使用

- 导入/拖放单个 TXT、DOCX 或 PDF，单文件上限 20 MB。同一原文件再次导入会恢复原有批注和草稿。
- 在书架点击文件继续阅读，右侧 `•••` 管理置顶和移除。移除会删除浏览器里的文件副本、批注、草稿和对话，不影响电脑上的源文件。
- 选中文字添加批注；PDF 支持整页批注。批注面板可导出 Markdown、备份和恢复 JSON。Word 和 TXT 导出带可读批注附录，PDF 导出标准批注及可见正文页。
- Word 点击“编辑”，修改正文或表格后点击“保存”；导出会生成副本，不覆盖原文件。
- AI 助手中配置 HTTPS 渠道及模型。只在主动发送时向该渠道发送问题或选文上下文，独立对话不会自动附上文档。
- 打开书籍，在“AI 对话 → 整本书分析”点击开始：按章节/段落分析后分层汇总，可查看分段依据、定位原文、围绕全书提问和导出 Markdown。开始前展示预计调用次数；启动会向所选渠道分段发送全文，可能产生调用费用。暂停会等待当前请求结束，后续不再发送；切换文档、刷新或关闭后可继续，已完成片段无需重跑（刷新后需补填 Key）。结果随文档保存；Word 正文修改后会标记旧报告，需重新分析。PDF 没有文字的页面会提示未分析，不支持 OCR/图片理解。
- 完整分析后自动建立每本书的本地 RAG 知识库，旧版完整报告在重开时补建。原文按约 1100 字符和 140 字符重叠建立索引，保留章节/页码、原文位置与引用编号。采用 BM25（中文单字/双字与 Unicode 词项）和本地语义向量混合检索。建库和“查看本书知识库”中的检索不调用远端 AI；问答检索至多四段原文，连同概要发送到已配置渠道，未命中时不调用 AI。正文变动后停用旧索引，重新分析后重建；模型输出未知引用编号时会提示核对。索引保存失败可点击“重建知识库”，无需重跑分析。不支持跨书检索。
- 网页端使用 `bge-small-zh-v1.5` 的 fp32 模型（94.9 MB 权重），Android 使用 q8（24.0 MB）；运行库和分词器另计。首次语义建库从当前站点加载资源，在 Web Worker 中用 WebAssembly 计算并缓存模型，不把书籍发给 Embedding API。长段落采用重叠 token 窗口覆盖全文，归一化 CLS 向量平均后再归一化。每本书保存 512 维向量与模型版本/精度标识，不混用两种精度。可暂停后继续；每完成 16 段和手动暂停时保存，意外关闭可能重算尚未保存的少量片段。模型加载、计算失败或暂停时使用关键词检索，支持重试。首次加载和整本书计算需要时间与内存，速度依设备而异。
- 快捷键：Cmd/Ctrl+O 导入、Cmd/Ctrl+F 文档搜索、编辑时 Cmd/Ctrl+S 保存、Esc 关闭面板或返回。

## 数据与边界

- 原始文件及 RAG 索引用 IndexedDB 的独立对象仓库存储，文档状态、草稿、会话和渠道信息用 localStorage 存储。存储升级会保留旧文件；若旧标签页阻止升级，按提示关闭旧页面后重试。索引记录原文偏移和词项，不复制 AI 分析作为事实来源；单个索引上限 64 MB。API Key 仅放在页面内存，不写入两种存储，也不使用 Android Keystore；刷新、关闭页面后需重新填写。
- 数据按浏览器和网站来源隔离。更换端口、主机名、浏览器或设备会使用另一份书架，不与 Android 自动同步。无痕模式、存储配额或浏览器清理可能导致数据丢失；重要文件与笔记请导出备份。保存失败会提示，多个标签页修改同一文档时会阻止旧标签页覆盖新记录。
- AI 使用浏览器直接请求服务商。接口必须允许 CORS；应用没有转发代理。Chat Completions 和 Responses 请求、解析及失败提示通过模拟接口验证，未使用真实服务商 Key 做联网验收。
- DOCX 支持常见段落样式、标题、文字格式、列表、表格和常见内嵌图片。尽量保留原 ZIP 部件及未改动的 XML；修改段落会重建对应文字部分。复杂分栏、纵向合并表格、浮动对象、公式、页眉页脚等不能保证与 Word 一致，重要排版请用 Word 复核。暂不支持旧版 `.doc`、加密 Word、EPUB、PDF OCR。
- 网页端经过 Chromium 桌面和 390px 手机视口验证；未做 Safari、Firefox 或手机真实浏览器验收。

## 验证

```bash
npm run check
npm run build
node ../app/src/test/js/reader-notes-check.cjs
node ../app/src/test/js/reader-book-check.cjs
node ../app/src/test/js/reader-rag-check.cjs
node create-fixtures.mjs
python3 ../app/src/test/js/create-pdf-fixture.py output/playwright/fixtures/check.pdf
```

启动服务器后，使用 Playwright CLI 执行 `browser-check.js`，再执行 `browser-extra-check.js`：

```bash
playwright-cli -s=lightreader-check open http://127.0.0.1:4173/
playwright-cli -s=lightreader-check run-code --filename browser-check.js
playwright-cli -s=lightreader-check run-code --filename browser-extra-check.js
playwright-cli -s=lightreader-check run-code --filename browser-book-check.js
playwright-cli -s=lightreader-check run-code --filename browser-rag-check.js
playwright-cli -s=lightreader-check run-code --filename browser-embedding-model-check.js
playwright-cli -s=lightreader-check run-code --filename browser-embedding-flow-check.js
playwright-cli -s=lightreader-check close
```

浏览器检查创建独立临时 context，使用明确的测试文档和模拟 AI 请求，不调用真实 AI 服务。覆盖文件输入、搜索、划词批注、进度/草稿/对话恢复、文件实际下载及重开、存储失败、标签页冲突、大 TXT 分块和手机布局。截图及导出文件在被 Git 忽略的 `output/playwright/` 下。

全书检查额外验证实际请求覆盖完整原文、分层汇总、暂停与错误续跑、刷新恢复、跨文档迟到回复隔离、问答原文来源及报告下载。模型阅读质量仍需使用真实渠道验收。

相邻短章节会合并到不超过 7000 字符的分析批次中，保留原章节/页码边界供知识库检索。`browser-book-speed-check.js` 用 104 个短章节和 21 段已完成分析复现旧版过多请求的问题，验证自动调整待处理批次后只发出 12 次剩余请求、全部未读正文恰好覆盖一次，旧摘要与引用编号不变。调整不会自动启动付费请求；进行中的单次请求、已进入汇总的任务和完整报告不重排。

RAG 检查覆盖自动建库、旧报告补建、IndexedDB 升级保留旧文件、索引持久化、章节深处原文检索、未命中拒答、引用校验、保存失败与重建、文档切换时取消，以及书籍之间的索引隔离。BM25 的词频饱和与长度归一化采用 k1=1.2、b=0.75，参照 [SQLite FTS5 的 BM25 说明](https://www.sqlite.org/fts5.html#the_bm25_function)，IDF 使用正值变体；实现为共享 JavaScript，不依赖 SQLite 服务。

语义检查运行真实 q8/fp32 模型，验证中文改写排序、长文本 token 覆盖和阻止模型网络下载后的缓存复用。流程检查使用测试分析报告与真实 fp32 向量，覆盖自动建库、暂停重开续建、混合检索、推理失败回退、保存失败重试与完成索引复用；这些小样例不代表大规模检索质量评测。语义候选与词项候选采用倒数排名融合，语义相似度过滤阈值为 0.4；检索结果仍需核对原文。

## 文件

- `build.mjs`：从共享页面构建网页入口，不修改 Android 源码。
- `web-bridge.js`：文件、存储、下载和 AI 通信。
- `web-docx.js`：浏览器 Word 解析及原包导出。
- `web-ui.js` / `web.css`：桌面书架、拖放、快捷键及响应式布局。
- `server.mjs`：仅提供 `dist/` 的本地静态服务器。
