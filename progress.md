# Progress

## Session Log
- 已初始化文件型计划，用于跟踪导入招标文件页面重做任务。
- 已查看客户端导入页、现有文件解析服务、配置存储和工具目录概览，确认需要重做 UI 并重写解析服务分流。
- 已细读 doc2markdown-node、MinerU Agent、MinerU 精准 API demo 的关键流程，下一步迁入/复用解析逻辑。
- 已完成客户端解析链路改造：Electron 文件服务按配置分流本地解析、MinerU-Agent、MinerU 精准 API；导入页改为配置标题 + Markdown 渲染器。
- 已通过 `node -e "require('./electron/services/fileService.cjs'); console.log('file service ok')"`、`node -e "import('./electron/services/doc2markdown/convert.mjs').then(() => console.log('converter ok'))"`、本地 Markdown 转换 smoke test、`npm run build`、`npm audit`。
- 开始技术方案缓存迁移：目标是从 Renderer `localStorage` 改为 Electron Main 侧 `userData` 文件存储，并同步开发说明。
- 已完成技术方案缓存迁移：新增 `workspaceStore.cjs`、`workspaceIpc.cjs`、preload `window.yibiao.workspace`，技术方案 Hook 改为异步读写 Main 侧缓存；`npm run build` 通过。
- 已完成 Step02 招标文件解析：新增解析模式切换、并发流式解析、进度与结果展示，项目概述和技术评分要求成功且进度 100% 后才允许进入目录生成；`npm run build` 通过。
- 已重做 Step02 用户体验：模式选择改为明确的按钮式 Segmented Control，结果展示改为左侧任务列表 + 右侧单项阅读器，不再把所有解析结果铺满页面；`npm run build` 通过。
- 已完成 Step03 目录生成迁移：将旧版后端目录生成 Prompt 与自由/评分项对齐工作流迁入 client service，新增目录生成页面、过程日志、目录树、详情编辑、添加/删除目录项；`npm run build` 通过。
- 已完成 Step02/Step03 后台任务化：新增 Main 侧 `taskService`、`bidAnalysisTask`、`outlineGenerationTask` 和 `tasks:*` IPC/preload，招标文件解析和目录生成切页面不中断，任务状态与结果持续写入 `technical_plan.json`；`npm run build` 和任务模块加载验证通过。
- 已严格对齐后端 `/api/outline/generate-stream` 的目录生成容错机制：client `aiService` 新增 `collectJsonResponse`，目录生成每一步改为 schema 标准化 + validator + JSON 修复 + 最多 3 轮重试；`outlineGenerationTask.cjs` prompt、validator 和工作流已按 backend `OutlineService` 迁移；模块加载、假 AI 流程和 `npm run build` 验证通过。
- 开始 Step04 正文生成与 Word 导出：已确认后端正文生成接口、导出 Word payload、旧前端叶子节点生成逻辑和 client 当前任务/导出占位结构。
- 已新增 Main 侧正文生成任务、任务 IPC/preload 入口、技术方案正文状态类型、Step04 页面主体和 Word 导出服务；首次 CJS 模块验证发现 `??`/`||` 混用语法错误，已改为中间变量修复。
- Step04 正文生成与 Word 导出已完成集成：模块加载验证、Word buffer 生成、假 AI 正文任务流程和 `npm run build` 均通过；构建仍有既有 chunk 体积警告。
- 已核对并修复 Step04 代码评审问题：目录变更时清空正文生成缓存和 outline 节点旧 content；正文 Markdown 渲染移除 `rehypeRaw`，避免模型输出 HTML 被渲染成 DOM；任务模块加载和 `npm run build` 通过。
- 已给正文生成结果增加开头重复章节标题过滤：在 Main 侧流式结果写入工作区前清理独立标题行，覆盖编号标题、Markdown 标题、加粗标题和中文序号标题；针对性用例、假 AI 任务和 `npm run build` 通过。
