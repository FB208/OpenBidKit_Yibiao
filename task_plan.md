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
