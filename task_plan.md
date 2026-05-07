# Task Plan

## Goal
重做客户端“导入招标文件/标书解析”页面：标题显示配置中的文件解析方式；页面主体用 Markdown 渲染上传招标文件直接提取出的内容；三种解析方式参考 `tools/mineru-agent-demo/`、`tools/mineru-accurate-demo/`、`tools/doc2markdown-node/`，优先完整还原 Node 版本地解析链路。

## Phases
- [completed] 1. 调研现有客户端导入页、配置读取、文件解析服务和三个工具示例。
- [completed] 2. 设计 Electron Main 文件解析服务分流：本地解析、MinerU 精准 API、MinerU Agent API。
- [completed] 3. 重做 DocumentAnalysisPage UI：配置标题、导入动作、Markdown 渲染内容。
- [completed] 4. 补齐类型、样式、Toast 错误提示和 Windows 兼容。
- [completed] 5. 运行构建和必要模块验证。

## Decisions
- 不引入降级策略；按用户配置的解析方式调用对应实现。
- 页面不加大标题横幅，只显示核心导入区和 Markdown 内容。

## Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `technicalPlanStorage.load()` 返回值包含 `undefined` 导致 TypeScript 构建失败 | 第一次 `npm run build` | 将返回值归一为 `state || null` |

## Current Task: 技术方案缓存迁移

### Goal
将技术方案流程中用到的缓存从 Renderer `localStorage` 迁移到 Electron Main 侧文件存储，并更新 `client/开发说明.md` 的数据存储约定。

### Phases
- [completed] 1. 梳理现有 IPC、preload、类型声明和技术方案缓存实现。
- [completed] 2. 新增 Main 侧工作区存储服务与 IPC/preload API。
- [completed] 3. 将技术方案 Hook 改为异步读写 Main 侧缓存。
- [completed] 4. 移除技术方案 localStorage 缓存实现，更新开发说明。
- [completed] 5. 运行构建和必要模块验证。

## Current Task: 严格迁移后端目录生成容错机制

### Goal
严格参照 backend `/api/outline/generate-stream` 的 `OutlineService` 和 `OpenAIUtil.collect_json_response()`，降低 client Step03 目录生成失败率。

### Phases
- [completed] 1. 对比 backend 路由、service、prompt、JSON 修复工具和 client 当前目录生成逻辑。
- [completed] 2. 在 client `aiService.cjs` 中迁移生成、解析、校验、修复、重试一体化机制。
- [completed] 3. 在 client `outlineGenerationTask.cjs` 中迁移 backend prompt、标准化 schema 和 validator。
- [completed] 4. 将目录生成每一步改为通过 `collectJsonResponse` 执行修复和重试。
- [completed] 5. 运行模块加载、假 AI 流程和 `npm run build` 验证。

## Current Task: Step04 正文生成与 Word 导出

### Goal
实现客户端 Step04“生成正文”：参考 backend `/api/content/generate-chapter-stream` 为目录叶子章节生成正文；页面左侧显示目录树和生成状态，右侧显示正文内容；展示全局统计；技术方案 toolbar 在 Step04 改为“导出 Word”和“继续扩写”。

### Phases
- [completed] 1. 记录后端契约、旧前端实现和当前 client 架构要点。
- [completed] 2. 新增 Main 侧正文生成后台任务、任务类型、IPC/preload API。
- [completed] 3. 扩展技术方案状态与 Renderer 类型，合并后台正文任务事件。
- [completed] 4. 重做 `ContentEditPage` 为左目录树、右正文阅读器、全局统计和生成入口。
- [completed] 5. 实现独立客户端 Word 导出服务，并接入 Step04 toolbar。
- [completed] 6. 补充样式，运行模块加载、假任务和 `npm run build` 验证。

### Decisions
- 正文生成继续放到 Electron Main 后台任务，Renderer 只启动任务、订阅任务事件并展示状态。
- 仅为叶子节点生成正文，父节点状态由子节点聚合。
- 正文内容直接回写到 `outlineData.outline[*].content`，导出 Word 直接复用这份结构。
- Step04 toolbar 不再出现“下一步”，而是显示“导出 Word”和“继续扩写”。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `contentGenerationTask.cjs` 中 `??` 和 `||` 混用导致 CJS 语法错误 | 第一次模块加载验证 | 将正文内容表达式拆成 `outlineContent` 中间变量 |
