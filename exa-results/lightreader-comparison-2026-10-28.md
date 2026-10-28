# LightReader 同类项目对比与改进建议

LightReader 最值得借鉴的是 Koodo 的笔记整理与导出、Anx 的阅读内 AI 操作、MoRead 的上下文范围与原文引用。近期应优先完善批注保存与导出、对话保存和文档上下文，再改善流式响应、配置和导航。以当前 TXT / DOCX 阅读为中心，可以形成更清楚的使用价值。

比较基于 2026 年 10 月 28 日的 LightReader 当前工作区、三款产品的官方文档、发布说明和指定源码快照。本文保留调研时的功能快照，后续实现已发生变化；下方问题清单不代表最新发布版本仍存在这些问题。LightReader 工作区包含既有未提交改动，本次没有修改应用代码。未安装这三款应用进行真机对比，因此不对实际流畅度、耗电、复杂文件兼容率或 AI 回答质量作排名。默认分支源码中的功能不能自动视为正式安装包已有。

| 维度 | Koodo Reader | Anx Reader | MoRead | LightReader 当前实现 |
| --- | --- | --- | --- | --- |
| 主要用途 | 跨平台电子书管理、阅读与知识整理 | 电子书阅读、AI 理解和笔记 | Android 小说阅读与 AI 伴读 | Android 本地 TXT / Word 阅读、批注和可选 AI |
| 文件格式 | 包括 TXT、DOCX、EPUB、PDF 等多种格式 | 官方列表包括 EPUB、MOBI、AZW3、FB2、TXT、PDF | TXT、EPUB | TXT、DOCX，导入上限 20 MB |
| 阅读内 AI | 划词、翻译、词典、问书；可自定义模型 | 阅读内面板、分屏或弹窗；快捷提示词、模型切换 | 选段讨论、书籍进度、原文检索、脚注式引用 | 选文讲解/翻译、追问；已有可调高度面板和渠道切换 |
| 文档上下文 | 已发布功能包括基于原文语境的词义解释 | develop 源码包含目录、章节、书内关键词检索工具 | main 源码包含选段邻域、章节信息、检索和范围控制 | 选文模式主要传选文；独立 AI 页不自动附带文档 |
| 对话与等待 | 官方更新提供复制回答、清理历史等操作 | 流式输出、连接预览；源码保存会话及完成状态 | 流式、停止回复、会话历史、对话导出 | 等待整条响应；对话在内存中；未见停止与一键重试入口 |
| 批注整理 | 多样式、标签、笔记/高亮整理和多格式导出 | 颜色/样式、时间/章节排序；TXT/MD/CSV，develop 另有 JSON | 按书等条件回顾；Markdown 导出 | 当前文档列表、跳转、编辑、删除、全局批注；没有独立笔记导出入口 |
| 数据迁移 | 本地存储、备份和多种同步；功能存在 Pro 边界 | WebDAV；develop 笔记 JSON 包含书籍指纹 | 本地保存，WebDAV 备份、恢复前校验 | 本地进度、批注和草稿；没有用户可操作的完整备份恢复流程 |
| DOCX 修改与导出 | 已确认能阅读 DOCX；未确认具有与轻阅相同的保留格式编辑导出 | 当前官方格式列表未列 DOCX | 当前格式范围不含 DOCX | 可编辑并重写正文，保留原 ZIP 的其他部件；复杂对象保真仍需单独验证 |

功能依据：[Koodo README](https://github.com/koodo-reader/koodo-reader/blob/51eb0fb7598804cf94cc2b99091eac7e000b8b62/README.md)、[Koodo v2.3.2 移动版说明](https://github.com/koodo-reader/koodo-reader/releases/tag/v2.3.2)、[Koodo 更新日志](https://www.koodoreader.com/en/changelog)、[Anx README](https://github.com/Anxcye/anx-reader/blob/0c7fc1ad4551f7dbbeba6a6468f69d830957fa2a/README_zh.md)、[Anx v1.14.0](https://github.com/Anxcye/anx-reader/releases/tag/v1.14.0)、[MoRead README](https://github.com/ovo066/MoRead/blob/60e627a762f74e168ff748de8eaf5ca77e5d6008/README.zh-CN.md)。

Koodo 的部分官方帮助页仍保留早期测试期措辞。移动端及同步有 Pro 边界，但本次不据此给出价格、所有功能的免费归属或购买建议；具体需以当前账户和安装包为准。桌面端更新中的侧栏操作也不能直接当成手机端交互证据。

**Koodo 最值得借鉴的是让阅读结果能继续使用。**

Koodo 将笔记、高亮、词汇与原书关联，并提供多种导出形式。它的价值在于读完之后，用户可以整理材料并转移到自己的知识工具。对 LightReader，最小可用版本是：导出当前文档的 Markdown 笔记，包含文档名、原文、批注、位置、时间和 AI 来源；再提供 JSON 导入导出用于恢复。无需先接入多个云服务。

源码里的导出类型包括 CSV、Markdown、TXT、HTML、PDF 和 JSON，并区分笔记、高亮等记录；这说明导出的是可复用的阅读成果。对应参考：[Koodo 导出模块](https://github.com/koodo-reader/koodo-reader/blob/51eb0fb7598804cf94cc2b99091eac7e000b8b62/src/utils/file/export.ts)。

另一项适合借鉴的是导航后返回原位置。用户为了查一个概念跳到目录、搜索结果或批注，再返回原段落，应有明确入口。LightReader 可先增加一次“返回刚才位置”，以后再按需求扩展导航历史。Koodo 的移动版发布说明明确记录了这类返回操作。

**Anx 最值得借鉴的是降低 AI 使用中的操作负担。**

Anx v1.14.0 已列出供应商连接测试、流式预览、模型选择、可调整面板和阅读内快速切换。LightReader 已有渠道下拉框和可调高度面板，这两项应保留；更有价值的增量是验证配置、保存对话、显示响应进度和改善失败后的操作。

LightReader 可以提供“测试连接”和一次简短的模型试答，分别展示地址/认证是否可达、所选模型能否真正回复。MoRead 的连接测试源码主要请求模型目录，这种测试值得借鉴，但模型目录请求成功不能代表某个对话模型、流式模式或联网工具一定可用。相关源码：[MoRead 连接测试](https://github.com/ovo066/MoRead/blob/60e627a762f74e168ff748de8eaf5ca77e5d6008/app/src/main/java/com/mozhi/reader/ai/provider/ProviderConnectionTester.kt)。

Anx 的会话实现会在请求前保存草稿状态，在成功或失败后更新记录；LightReader 可采用同样的状态思路，让用户退出阅读或遇到请求失败后仍能找回问题和已收到的内容。参考：[Anx 会话保存与流式处理](https://github.com/Anxcye/anx-reader/blob/0c7fc1ad4551f7dbbeba6a6468f69d830957fa2a/lib/providers/ai_chat.dart)。

**MoRead 最值得借鉴的是明确 AI 正在读什么，并能回到依据。**

MoRead 当前源码将书名、章节、进度、选段邻域和可见批注组织为上下文，并对上下文设置预算。检索结果和会话引用帮助用户回到原文。小说场景的“已读范围”可以转化为 LightReader 的“本次允许使用的文档范围”。参考：[MoRead 上下文构建器](https://github.com/ovo066/MoRead/blob/60e627a762f74e168ff748de8eaf5ca77e5d6008/app/src/main/java/com/mozhi/reader/ai/prompt/CompanionContextBuilder.kt)。

建议 LightReader 先提供“仅选文”和“选文及前后文”，随后扩展“当前章节”。发送前展示范围与大致字数；正文与用户指令分开组织；引用到哪个段落就能跳回哪个段落。整篇文档问答可以先使用本地关键词检索，取得少量带位置的原文段落，再交给模型。Anx 的书内检索工具本身就支持关键词、结果数量和片段长度限制，可作为较小实现的参考。[Anx 书内检索工具](https://github.com/Anxcye/anx-reader/blob/0c7fc1ad4551f7dbbeba6a6468f69d830957fa2a/lib/service/ai/tools/book_content_search_tool.dart)

MoRead 的角色卡、跨会话向量记忆、插图生成和多角色语音服务于小说伴读。LightReader 目前的专业文档阅读流程，优先需要准确定位、术语理解、笔记保存与导出。只有关键词检索在真实材料上显示出明确不足，再评估向量检索与重排的成本。

**当前实现中有六项具体问题，会影响上述改进的顺序。**

1. **应用内批注尚未接入导出路径。** 当前“导出 TXT / DOCX”调用 `prepareExport`：未编辑时复制原始文件，编辑过的 DOCX 调用样式导出器；没有将当前批注传入。仓库虽有 `DocxPreservingExporter`，实际按钮路径没有调用它。原始文件本来包含的 Word 批注与轻阅新增批注是两回事。应先增加明确的“导出笔记”，后续再决定是否将笔记作为 Word 附录或标准批注写入。[导出入口](../app/src/main/java/com/lightreader/app/MainActivity.java)

2. **改动选文会移除无法匹配的批注。** `reanchorNotes` 以原文精确匹配重新定位，找不到就跳过；保存后把剩余列表写入存储。用合成输入调用当前函数，原文从“原文术语”变为“修改后的术语”后，1 条批注变成 0 条。外部修改文件后，`loadNotes` 的文本哈希不符也会直接返回空列表；这不等同于立即删除底层记录，但用户无法在阅读页看到它们。应保留为“待重新定位”，展示原引用、批注正文和手动绑定入口。[重新定位](../app/src/main/assets/reader.html) · [加载批注](../app/src/main/java/com/lightreader/app/MainActivity.java)

3. **AI 对话尚未保存，文档范围也不完整。** `askSelection` 重新选文时清空选文会话，`goHome` 清空两类会话；当前没有历史落盘路径。`buildAiPrompt` 只带选文，`sendAiPage` 只带问题及会话历史。独立 AI 页中直接问“这份文档讲了什么”，当前并不会自动获得文档正文。应将文档会话与普通聊天的范围写清，并按文档保存会话。[选文入口](../app/src/main/assets/reader.html) · [独立 AI 请求](../app/src/main/assets/reader.html) · [返回主页](../app/src/main/assets/reader.html)

4. **讲解和翻译模式不使用输入框里的补充要求。** 在 `explain` / `translate` 分支，`buildAiPrompt(raw)` 直接返回固定模板。合成函数检查中，“请只用一句话解释”没有进入最终请求。普通追问分支会使用 `raw`，因此影响范围是仍处于讲解/翻译模式的那次请求。应将任务模板、用户补充要求和原文分开组合；保留一键讲解的默认短路径。[提示词构建](../app/src/main/assets/reader.html)

5. **DOCX 目录的产品说明与当前入口不一致。** README 提到 Word 标题可生成目录；源码中的目录按钮、目录展示均以 `TXT` 为条件，DOCX 标题目前主要保留样式。应先由 `data-style` 等信息生成可导航标题；对于自定义标题样式和 `outlineLvl`，再补明确的识别规则与层级处理。[按钮可见条件](../app/src/main/assets/reader.html) · [目录渲染](../app/src/main/assets/reader.html)

6. **保留 DOCX 的其他文件部件，尚不能证明复杂正文对象完整保真。** 编辑导出会重写 `word/document.xml`。当前渲染和序列化集中于文字、样式、段落、列表和表格；图片、公式、复杂域、合并单元格等需要逐项验证其正文引用和结构能否保留。改进方向是识别未支持的对象，尽量原样保留未修改节点，针对真实 Word 样本检查编辑前后变化。[正文重写](../app/src/main/java/com/lightreader/app/DocxStyledExporter.java) · [行内对象解析](../app/src/main/java/com/lightreader/app/DocxRenderer.java)

**建议分三批实施。** 成本为相对复杂度：小表示局部界面或数据处理；中表示跨前端与 Android 持久化/请求生命周期；大表示解析、渲染或数据迁移方面有较多兼容性工作。它们不是工期承诺。

| 批次 | 改动 | 收益 | 相对成本 | 可验收结果 |
| --- | --- | --- | --- | --- |
| 第一批 | 保留失去原文位置的批注，支持重新绑定 | 防止编辑导致阅读成果丢失 | 中 | 修改被批注原文后，批注数量不减少；可找到原引用并重新绑定 |
| 第一批 | Markdown 笔记导出和带文档指纹的 JSON 导入导出 | 笔记可带走、可恢复 | 中 | 导出包含原文与笔记；同一文档重新导入不重复；文档变化能提示冲突 |
| 第一批 | 按文档保存 AI 会话；问题、回答、选区和模型信息关联 | 返回、重启后可继续阅读讨论 | 中 | 退出再打开后能继续同一会话，两个文档的内容不串入 |
| 第一批 | 讲解/翻译合并用户补充要求 | 尊重用户当次意图 | 小 | 输入“一句话”“保留术语”等要求后，实际请求中可见该约束 |
| 第二批 | 可选上下文范围与段落来源跳转 | 增强解释依据与可核对性 | 中 | 回答中的来源可定位原文；用户能看到发送范围；缺少依据时明确说明 |
| 第二批 | 流式响应、停止、重试、复制；区分错误类型 | 降低等待期间的不确定性 | 中 | 收到内容即显示；停止能取消请求；失败后保留问题；手动上翻不被拉回底部 |
| 第二批 | DOCX 标题目录和返回刚才位置 | 改善长文导航 | 中 | 有层级的标题可跳转；从目录或批注跳走后可回到原阅读位置 |
| 第二批 | 渠道连接测试与模型试答 | 降低配置排错成本 | 小至中 | 可区分地址/鉴权、模型、限流、网络问题；目录可达与模型可用分别显示 |
| 第三批 | 笔记搜索、按位置/时间排序、少量分类 | 提高积累后的查找效率 | 小至中 | 大量笔记中可通过原文或批注关键字定位目标 |
| 第三批 | 备份恢复，再按需求接 WebDAV | 降低换机和重装成本 | 中 | 进度、批注、会话、草稿恢复一致；已有内容不会被空备份覆盖；密钥单独处理 |
| 第三批 | 复杂 DOCX 的保真编辑与对象覆盖扩展 | 加强 Word 场景差异 | 大 | 固定真实样本中的图片、公式、表格等在编辑导出后保持可用 |
| 需求确认后 | PDF、EPUB、新平台、TTS | 扩展可读内容与设备 | 大 | 先明确用户最常被哪一种格式阻塞，再定义选择、批注、AI 和导出的一条完整路径 |

对于经常阅读论文的人，PDF 可能比部分第二批功能更有价值；对于主要阅读电子书的人，EPUB 的收益更大。当前仓库明确围绕 TXT / DOCX，尚无材料占比数据，因此不将格式扩展自动排到最前面。系统朗读、阅读统计、云端同步也适合在出现明确使用需求后追加。

**AI 的改进应区分输出更好看、内容更准确和等待体验更好。**

仓库已有 24 段材料、64 次请求的旧版对照记录，适合继续作为回归基线。其报告中，0.1.3 完整响应中位数为 9.63 秒、P95 为 17.49 秒，但这来自 2026 年 9 月 12 日宿主 JVM 的一次运行，不是本次 Android 真机测量，也不是首字延迟。流式可以改善可见进度，不能据此承诺模型总响应更快。[已有评测报告](../eval/REPORT.md)

同一报告中，总分改善主要由显示格式贡献，其他内容项没有同步提升。下一轮 AI 评测应重点加入现代专业文档、上下文依赖、信息不足、用户补充要求和来源定位样本。流式、停止和会话恢复则用真实客户端路径验证。保留现有纯文本显示的可用性，不需要为了模仿竞品立即切换复杂富文本。

**源码复用应服从当前项目的维护成本。**

LightReader 现有 Java + WebView 足以承载上述第一、第二批改进。可以把 AI 请求、会话保存、批注定位等职责在改动对应功能时逐步分开；没有必要为了接近 Anx 或 MoRead 一次性迁移到 Flutter 或 Compose。功能思路与直接复制代码是不同决策，若后续选择移植某段源码，再核对该文件及依赖的许可证。

| 来源快照 | 本次核对范围 |
| --- | --- |
| LightReader `675630c` 加当前未提交改动 | README、reader.html、MainActivity、AiClient、DOCX 渲染/导出、Manifest、既有评测摘要 |
| Koodo `dev` 的 `51eb0fb` | README、导出与备份相关源码；发布记录另核对到 v2.4.6 |
| Anx `develop` 的 `0c7fc1a` | README、会话保存、提示词、书内检索、笔记导出/JSON；发布说明另核对 v1.14.0 |
| MoRead `main` 的 `60e627a` | README、上下文组织、连接测试、笔记与会话导出、检索评测边界；发布记录另核对 v1.4.1 |

补充参考：[Anx 笔记导出](https://github.com/Anxcye/anx-reader/blob/0c7fc1ad4551f7dbbeba6a6468f69d830957fa2a/lib/service/notes/export_notes.dart)、[Anx 笔记 JSON 与文档匹配](https://github.com/Anxcye/anx-reader/blob/0c7fc1ad4551f7dbbeba6a6468f69d830957fa2a/lib/service/notes/notes_json.dart)、[MoRead 笔记导出](https://github.com/ovo066/MoRead/blob/60e627a762f74e168ff748de8eaf5ca77e5d6008/app/src/main/java/com/mozhi/reader/core/library/NoteExporter.kt)、[MoRead 会话导出](https://github.com/ovo066/MoRead/blob/60e627a762f74e168ff748de8eaf5ca77e5d6008/app/src/main/java/com/mozhi/reader/feature/reader/ConversationExport.kt)、[Koodo 本地存储说明](https://www.koodoreader.com/en/document)。
