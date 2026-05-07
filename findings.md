# Findings

## Research Log
- 当前客户端 `DocumentAnalysisPage` 仍是“导入文件 + AI 解析项目概述/评分要求”的旧交互，导入后没有 Markdown 渲染原始提取内容。
- 当前 `client/electron/services/fileService.cjs` 只用 `mammoth.extractRawText` 和 `pdf-parse` 做纯文本提取，未按配置中的 `file_parser.provider` 分流，也未使用 `tools/doc2markdown-node` 的 Markdown 还原逻辑。
- 配置文件中 `file_parser.provider` 已存在，值为 `local`、`mineru-accurate-api`、`mineru-agent-api`，但文件解析服务没有读取配置。
- `tools/doc2markdown-node/src/convert.js` 是 ESM，实现包括 Markdown 编码识别、DOCX->HTML->GFM Markdown、PDF 文本/表格提取、DOC/WPS 经 LibreOffice 转 DOCX。要“100%还原”本地解析，应复用该模块而不是重写简化版。
- MinerU Agent 轻量 API：`POST https://mineru.net/api/v1/agent/parse/file` 获取 `task_id/file_url`，`PUT` 上传，`GET /parse/{task_id}` 轮询，完成后下载 `markdown_url`。无需 Token。
- MinerU 精准 API：`POST https://mineru.net/api/v4/file-urls/batch` 带 Bearer Token 获取 `batch_id/file_url`，`PUT` 上传，`GET /extract-results/batch/{batch_id}` 轮询，下载 `full_zip_url`，从 zip 中读取 `full.md` 或任意 `.md`。
- 已将 `tools/doc2markdown-node/src/convert.js` 复制到 `client/electron/services/doc2markdown/convert.mjs`，运行时不再依赖 `tools/` 目录。
- 前端 Markdown 渲染使用 `react-markdown`、`remark-gfm`、`rehype-raw`，用于展示 GFM 表格和 DOCX 转换保留下来的 HTML 表格。
- 技术方案 Markdown 结果此前只保存在 `TechnicalPlanHome` 内存状态；切换到设置页会卸载页面导致丢失。
- 临时新增的 `technicalPlanStorage.ts` 使用 Renderer `localStorage`，不适合保存招标文件 Markdown 这类大文本，应迁移到 Electron Main 的 `userData` 文件。
- 现有 IPC 注册集中在 `electron/ipc/index.cjs`，preload 暴露集中在 `electron/preload.cjs`，Renderer 类型来自 `src/vite-env.d.ts` 引用的 `shared/types`。
- Step02 需要实时显示模型输出，现有 `ai.chat()` 只能一次性返回；已新增 OpenAI-compatible SSE 解析通道，通过 `ai:stream-chat` IPC 和 `window.yibiao.ai.streamChat()` 向 Renderer 推送 chunk。
- 旧版目录生成核心在 `backend/app/services/outline_service.py` 和 `backend/app/utils/prompts/outline_prompts.py`：自由模式包含一次性生成、失败切分步生成、审核和二次生成；对齐模式先提取技术评分大类，再按大类生成二三级目录并审核。已迁入 client 的 `outlineWorkflow.ts` 与 `outlinePrompts.ts`。
- Step02/Step03 后台任务运行时，Renderer 的整包技术方案保存可能覆盖 Main 刚写入的任务进度；已在 `useTechnicalPlanWorkflow` 中跳过运行中任务状态下的 debounce/卸载保存，避免写入竞争。
- client 目录生成失败率高的根因是此前只仿写了 backend 流程，未迁移 `OpenAIUtil.collect_json_response()` 的完整链路；后端每一步 JSON 调用都在同一函数内执行解析、Pydantic schema 校验、业务 validator、JSON 修复和最多 3 轮重试，而 client 此前把业务校验放在 `requestJson()` 外部，导致校验失败不能进入修复/重试。
- 已将 client 目录生成 prompt 和 validator 对齐 backend：完整目录只要求非空且至少三级；一级目录只要求非空；children 只要求二级目录非空；不再额外把“无描述/没有提及”作为生成失败条件。
- backend `/api/content/generate-chapter-stream` 的契约很轻：请求包含 `chapter`、`parent_chapters`、`sibling_chapters`、`project_overview`，服务端用 `build_chapter_content_messages()` 后以 `temperature=0.7` 流式返回纯正文 chunk。
- 旧 `frontend/src/pages/ContentEdit.tsx` 已实现可参考的叶子节点收集、父级章节查找、同级章节查找、5 并发生成和 Word 导出 payload 构造；但旧版依赖浏览器 SSE、`file-saver` 和本地草稿缓存，client 需要改为 Main 后台任务与工作区文件存储。
- backend `/api/document/export-word` 的 payload 是 `{ project_name?, project_overview?, outline }`，其中 `outline` 节点包含 `id/title/description/children/content`；导出服务只对叶子节点渲染 `content`，Markdown 支持标题、列表、表格行、粗体/斜体/代码。
- client 现有 `exportService.cjs` 是未实现占位；`preload.cjs` 已暴露 `window.yibiao.export.exportWord(payload)`，但 Main 侧还需要实现保存对话框和 docx 写入。
