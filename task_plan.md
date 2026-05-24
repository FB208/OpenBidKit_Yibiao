# Task Plan

## Current Task: GitHub 仓库统计接口修复

### Goal
修复 `GET /api/github-repo-stats` 返回 `code:0, repo:null, cached:false` 导致统计页读不到 GitHub stars/forks/open issues 的问题。

### Phases
- [completed] 1. 定位 Worker 路由和 Dashboard 调用路径，确认 `repo:null` 来自 GitHub 拉取失败被 catch 吞掉。
- [completed] 2. 验证 `FB208/OpenBidKit_Yibiao` GitHub API 和仓库页本身可访问，排除仓库名错误。
- [completed] 3. 改造 Worker：支持可选 `GITHUB_API_TOKEN`、GitHub HTML 兜底解析、手动 TTL 缓存和实时失败返回旧缓存。
- [completed] 4. 不再在无缓存失败时返回 `code:0, repo:null`，改为 502 和可诊断错误信息。
- [completed] 5. 运行 Worker 语法检查、handler 实测、HTML fallback 实测、stale cache fallback 实测和 diff 检查。
- [completed] 6. 按 review 修复 HTML fallback 部分字段解析失败会缓存 0 的问题，并补 Dashboard 自定义生图服务商中文标签。
- [completed] 7. 按 review 修复模型使用表 provider 标签：文本模型和生图模型分开使用标签表，避免文本 `custom` 显示成自定义生图服务。

### Decisions
- 使用现有 `NOTICE_STORE` KV 保存 GitHub stats 缓存，不新增 KV binding。
- 正常缓存新鲜度仍是 30 分钟；KV key 保留 7 天，用于 GitHub 实时接口失败时返回 stale 缓存。
- GitHub API 优先；API 失败后抓取公开仓库 HTML 中的 counters 兜底。
- HTML fallback 只有 stars、forks、open issues 三个字段全部解析成功才返回结果；部分字段缺失时不写入缓存，有旧缓存则返回旧缓存。
- Dashboard 模型使用表按分组区分 provider 标签：`textModelUsage` 使用文本模型服务商标签，`imageModelUsage` 使用生图服务商标签。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 生图模型测试超时

### Goal
给设置页生图模型测试增加 5 分钟超时，覆盖 OpenAI-like 和 Google AI Studio 生图测试。

### Phases
- [completed] 1. 为 OpenAI-like 生图测试接入 `AI_REQUEST_TIMEOUT_MS` 和 `AbortController`。
- [completed] 2. 为 Google AI Studio 生图测试接入同一个 5 分钟超时。
- [completed] 3. 运行 `node --check electron/services/aiService.cjs` 和 `npm run build`。

### Decisions
- 生图测试超时复用全局 `AI_REQUEST_TIMEOUT_MS = 300000`，不新增独立配置项。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 生图自定义 OpenAI-like 模式

### Goal
为生图模型新增 `custom` 服务商，允许用户填写自定义 Base URL/API Key/模型名称，并复用 OpenAI compatible `/images/generations` 生图接口完成测试、正文配图和模型列表获取。

### Phases
- [completed] 1. 梳理当前生图 provider、profiles、设置页和 Main 侧生图调用路径。
- [completed] 2. 扩展共享类型、Renderer 默认配置和 Main 配置归一化，加入 `custom` 生图 provider。
- [completed] 3. 调整设置页自定义生图 UI：Base URL 可编辑、API Key 获取提示、模型列表获取。
- [completed] 4. 将 Main 侧测试和正文配图的 OpenAI compatible 分支兼容 `custom`。
- [completed] 5. 运行语法检查和客户端构建验证。

### Decisions
- 自定义生图只按 OpenAI compatible 格式实现，不设计额外降级协议。
- 预置生图服务商仍锁定预置 Base URL，只有 `custom` 可编辑。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |

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

## Current Task: Step04 正文首批体验修正

### Goal
先修复已暴露的正文生成体验问题：规范 `<br>` 换行、去掉图例中的“AI 生成示意”、图片和图例居中、支持图片全屏查看，并在开发者模式下显示配图统计。

### Phases
- [completed] 1. 生成正文落盘前规范 `<br>`，并强化 Prompt 禁止随机 Mermaid 和 HTML 换行。
- [completed] 2. 修改图片图例文案为 `图：xxx`，前端和 Word 导出中图片/图例居中。
- [completed] 3. 正文 Markdown 图片支持点击全屏查看。
- [completed] 4. 后台任务写入配图统计，开发者模式下显示悬浮统计框。
- [completed] 5. 运行 `npm run build`、正文任务 smoke test、Word `<br>` 导出 smoke test 和 `git diff --check`。

### Decisions
- 表格单元格内的 `<br>` 统一规范为 `<br />`，前端通过 `rehypeRaw` 渲染换行，Word 导出把 `<br />` 转为真实 Word 换行。
- 当前批次不接 Mermaid 渲染和 Mermaid 导出，后续再做全局决策、Mermaid 与 AI 图二选一。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `SettingsPage.tsx` 导入 `ImageModelStatus` 时报共享类型入口未导出 | 第一次 `npm run build` | 在 `client/src/shared/types/index.ts` 补导出 `ImageModelStatus` |

## Current Task: Step04 Word 导出 Markdown 完整转换

### Goal
将 Step04 正文导出 Word 从“浅层 Markdown 文本处理”升级为“Markdown AST 到 Word 原生结构转换”，确保图片、表格、加粗、列表等 Markdown 语法在 `.docx` 中真实还原，而不是直接输出 Markdown 源文本。

### Phases
- [completed] 1. 检查现有 `exportService.cjs` 手写 docx XML 和 Markdown 正则解析实现。
- [completed] 2. 接入 `docx`、`unified`、`remark-parse`、`remark-gfm`、`image-size`。
- [completed] 3. 重写导出核心为 Markdown AST 递归转换 Word 段落、表格、列表、链接、图片等对象。
- [completed] 4. 保留现有 `exportWord(payload)` IPC 和保存对话框，不改 Renderer 调用链路。
- [completed] 5. 运行 docx buffer、表格文本、图片 media、`npm run build`、`npm audit` 和 `git diff --check` 验证。

### Decisions
- 不继续扩展正则和手写 Word XML，改用 `docx` 对象模型保证后续排版可控。
- 图片转换在 Electron Main 侧完成，支持 `data:image/*;base64`、`http/https`、`file://`、绝对路径和相对路径。

## Current Task: Step02/Step03 左侧进度块统一

### Goal
统一 Step02/Step03/Step04 左侧进度区域视觉和交互：Step02、Step03 使用 Step04 的 `content-outline-stats` 可折叠结构，并保持任务列表、生成日志和正文区域独立滚动。

### Phases
- [completed] 1. 将 Step02 解析进度迁入左侧任务面板顶部，并改为可折叠 `content-outline-stats`。
- [completed] 2. 将 Step03 生成进度从日志列表中拆出，迁入左侧面板顶部，并改为可折叠 `content-outline-stats`。
- [completed] 3. 调整 CSS 布局，确保 Step02 任务列表、Step02 阅读器、Step03 日志列表独立滚动。
- [completed] 4. 清理旧 `.outline-ai-*`、`.bid-analysis-progress-*` 未引用样式。
- [completed] 5. 运行 `npm run build` 和 `git diff --check` 验证。
| 普通 Node 环境 require `updateService.cjs` 时 `electron-updater` 立即访问 Electron app 并报 `Cannot read properties of undefined (reading 'getVersion')` | 第一次模块加载验证 | 将 `electron-updater` 改为 `setupAutoUpdate()` 内、且 `app.isPackaged` 后懒加载 |
| Windows 本地打包解压 `winCodeSign` 时因当前用户无符号链接权限失败 | 第一次 Windows unpacked 打包验证 | 当前阶段不做签名，关闭 `win.signAndEditExecutable`，避免触发 winCodeSign 资源编辑链路 |
| Actions 成功但 Release 没有产物 | 首次 `v2.0.1` 远程发布验证 | 改为 `electron-builder --publish never` 只构建，再用 `gh release upload --clobber` 显式上传产物，避免 `existingType=release publishingType=draft` 冲突 |
| Release 说明只有 `Full Changelog` | 首次 `v2.0.1` 远程发布验证 | 改为 workflow 用 `git log` 生成提交列表，并在 Release 已存在时用 `gh release edit --notes-file` 更新说明 |
| Actions `Build renderer` 报 `TS2688: Cannot find type definition file for 'plist'` | 修复后手动重跑 `v2.0.1` | 显式安装 `@types/plist`，并在 workflow 中补 `npm install --no-save @types/plist` 兼容旧 tag |

## Current Task: 知识库完整分析流程重构

### Goal
按讨论定版方案重构知识库上传分析：程序预筛并保留 `filtered_blocks.json`，将正文切为 block，AI 两轮抽取知识条目，调试页设置每批匹配条目数，分批用稳定前缀提交全文 block 匹配段落范围，补漏最多两轮，程序回填正文生成最终知识条目、舍弃段落和处理报告。

### Phases
- [completed] 1. 梳理现有知识库 Electron 服务、IPC、前端页面、数据落盘格式和 AI 工具。
- [completed] 2. 设计并实现 block 预处理、筛除日志、条目抽取、补充抽取、分批匹配、补漏和最终回填流程。
- [completed] 3. 扩展 IPC/preload/type，使上传后进入可调试的“待匹配”状态，并支持按用户输入批量继续分析。
- [completed] 4. 重做知识库前端调试页面和详情页面，展示 block/条目/覆盖率/舍弃统计，并触发分批匹配。
- [completed] 5. 补齐进度事件、错误提示、数据兼容处理和处理报告落盘。
- [completed] 6. 运行 CJS 模块检查、关键纯函数 smoke test 和 `npm run build` 验证。

### Decisions
- 不做最小可执行版本，直接实现完整流程。
- 程序直接筛除明显无价值内容，但保存 `filtered_blocks.json` 调试日志。
- AI 不输出正文，只输出条目标题摘要、匹配段落范围、补漏新增条目和舍弃段落。
- 条目 ID 由程序统一生成，AI 只返回标题和摘要。
- 分批匹配提示词采用稳定前缀：固定规则 + 固定全文 block 在前，变量知识条目批次在最后，以利用服务商 prompt cache。
- 分批匹配只要求强相关，不强制覆盖；补漏阶段再要求所有遗漏 block 明确归属为已有条目、新增条目或舍弃。
- 不做冲突检查，先观察实际效果。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| `git diff --check` 报 `client/doc/知识库设计.md:63: new blank line at EOF` | 收尾检查 | 该文件非本次修改，按工作区保护规则未改动；本次修改文件仅有 LF/CRLF 提示 |

## Current Task: 标书查重目录分析首版

### Goal
在标书查重中新增纯程序目录查重：元数据提取完成后自动开始目录分析；基于已提取 Markdown 目录，不接 AI；招标文件只用于句子白名单，命中的投标目录项不计重复；投标文件之间做多级目录重复和相似度对比。

### Phases
- [completed] 1. 记录方案和现有查重服务接入点。
- [completed] 2. 扩展类型与工作区状态，加入目录分析结果。
- [completed] 3. 实现招标句子白名单、目录提取、多级树构建和重复比对。
- [completed] 4. 接入后台流程：元数据完成后启动目录分析，必要时等待正文提取结果。
- [completed] 5. 重做目录 Tab 展示：概览、相似度矩阵、文件目录树、重复组。
- [completed] 6. 运行 CJS/Preload 检查、构建和 diff 检查。

### Decisions
- 第一版不接 AI，不重新解析原始文件，直接读取 `duplicate-check/contents/*.md`。
- 招标文件不参与投标文件间比对，只拆句作为“不计重复”的白名单。
- 显式目录块优先，其次 Markdown 标题，最后语义标题兜底。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| `git diff --check` 报 `client/doc/标书查重.md:54 trailing whitespace` | 收尾检查 | 该文件是既有/用户改动，本轮未修改，按工作区保护规则未处理；本轮修改文件仅有 LF/CRLF 提示 |

## Current Task: AI 模型使用埋点与 Analytics 展示

### Goal
为客户端文本模型和生图模型 AI 请求增加服务商、Base URL、模型和 token 用量埋点；Analytics“模型使用”模块展示真实请求记录维度，不再按模型名 lower 聚合，按 total_tokens 从高到低排序。

### Phases
- [completed] 1. 改造客户端 `aiService.cjs`，异步吞错上报 AI 请求元数据与 token usage。
- [completed] 2. 改造 Analytics Worker `/track` 写入字段和 `/api/config-usage` 模型使用查询。
- [completed] 3. 改造 Dashboard “模型使用”表格展示服务商、Base URL、模型、客户端、次数和 token。
- [completed] 4. 更新 Analytics README 采集口径说明。
- [completed] 5. 运行客户端构建与 Worker/Dashboard 语法验证。

### Decisions
- 所有埋点必须异步执行，异常吞掉，不影响用户主流程。
- 允许牺牲部分准确性；token 缺失或解析失败时记 0。
- 流式文本请求尝试 `stream_options.include_usage=true`；服务商不支持时自动重试不带该字段。
- 模型使用统计保留真实 provider/base_url/model 字符串，不做 lower 聚合。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Analytics 远程公告通道

### Goal
基于 Cloudflare KV 在 `analytics/` 增加可管理的 Markdown 公告通道；客户端与现有 30 分钟版本检查共用轮询，但公告用独立弹窗展示，关闭后同一公告不再显示，除非后台发布新公告。

### Phases
- [completed] 1. 新增 Worker 公告公开读取与管理员读写接口，使用 KV binding `NOTICE_STORE`。
- [completed] 2. 在 Analytics Dashboard 增加公告管理 UI，支持读取、发布和停用最新公告。
- [completed] 3. 在客户端接入远程公告轮询，与版本检查共用定时器但展示互不干扰。
- [completed] 4. 更新 Analytics 部署文档，说明 KV 创建和接口。
- [completed] 5. 运行 Worker 语法检查、Dashboard 脚本检查和客户端构建验证。

### Decisions
- 使用 Cloudflare KV，不使用 D1；只保存每个 projectName 的最新一份公告。
- 客户端公告内容用 Markdown 渲染，并禁用 raw HTML。
- 公告不预置任何内容，只从 Analytics Dashboard 发布。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| Dashboard 脚本检查命令报 `Unterminated regexp literal` | 第一次 Dashboard 检查 | PowerShell/Node `-e` 中正则字面量转义导致，改用字符串索引提取 `<script>` 内容 |
| `remoteNotice.ts` 构建报 `enabled` 类型比较恒定 | 第一次 `npm run build` | `normalizeNotice()` 过滤停用公告后直接归一为 `enabled: true` |

## Current Task: GitHub Release 自动打包与客户端更新检查

### Goal
为 `client/` 接入基于 GitHub Actions 的 Windows/macOS 自动打包和 GitHub Release 发布；Release 由 `v*` tag 触发并自动生成说明；客户端打包后启动时检查 GitHub Release 更新，询问用户是否下载并安装。当前阶段不做代码签名。

### Phases
- [completed] 1. 确认当前 Electron 入口、package 配置和 GitHub 仓库信息。
- [completed] 2. 安装并配置 `electron-builder`、`electron-updater`。
- [completed] 3. 新增 Main 侧自动更新服务，接入 `app.whenReady()`。
- [completed] 4. 新增 GitHub Actions Release 工作流，构建 Windows 和 macOS 产物并自动生成 Release notes。
- [completed] 5. 更新 `client/开发说明.md` 发布与更新说明。
- [completed] 6. 运行构建、模块加载和配置验证。

### Decisions
- tag 触发规则使用 `v*`，不加 `client-` 前缀。
- 第一阶段不做 Windows/macOS 代码签名。
- Release notes 使用 GitHub 原生 `generate-notes` 生成。
- 自动更新只在 `app.isPackaged` 打包应用中启用，开发模式跳过。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `contentGenerationTask.cjs` 中 `??` 和 `||` 混用导致 CJS 语法错误 | 第一次模块加载验证 | 将正文内容表达式拆成 `outlineContent` 中间变量 |

## Current Task: Toolbar 拖动与页面内部滚动

### Goal
优化客户端全局底部 `FloatingToolbar`：增加按住拖动图标并支持拖动位置；排查页面布局，让内容占满窗口且消除全局滚动条，页面内部自行滚动；同步更新 `client/开发说明.md`。

### Phases
- [completed] 1. 梳理 AppShell、FloatingToolbar、全局 CSS 和主要页面布局。
- [completed] 2. 实现 FloatingToolbar 拖动手柄、边界约束和基础位置恢复逻辑。
- [completed] 3. 调整全局/页面布局为视口内高度和内部滚动，不再为 toolbar 预留空间。
- [completed] 4. 更新开发说明中的布局与悬浮工具条约定。
- [completed] 5. 运行构建验证，必要时补充静态检查。

### Decisions
- 工具条只通过前置拖动手柄移动，避免普通按钮点击和拖动冲突。
- 工具条保持悬浮层，不要求页面底部额外留白。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 正文智能表格与可选配图

### Goal
优化 Step04 正文生成：让文本模型先做章节编排决策，自然决定是否生成表格和是否配图；只有设置页生图模型明确测试可用时才调用生图接口生成图片并插入正文；预览和 Word 导出都能显示这些生成图片。

### Phases
- [completed] 1. 补充配置中的生图模型可用状态，并在设置页明确显示状态。
- [completed] 2. 增加 Main 侧生图服务与工作区图片保存目录。
- [completed] 3. 改造正文生成任务：章节编排 JSON、正文 Markdown 提示、可选配图插入。
- [completed] 4. 增加 `yibiao-asset://generated-images/...` 预览协议和 Word 导出读取支持。
- [completed] 5. 运行模块 smoke test、`npm run build` 和 `git diff --check` 验证。

### Decisions
- 配图和表格是否出现由 AI 的结构化编排决策决定，代码不按关键词或章节类型写死规则。
- 正文文本模型不负责编造或输出图片链接；图片由生图接口生成后由程序插入 Markdown。
- 生图模型只有 `status === 'available'` 时参与正文配图；用户修改生图配置后状态重置为 `untested`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 正文第二批优化

### Goal
完成正文生成配置弹窗、Mermaid/AI 生图互斥、AI 生图整体择优，并修复 Mermaid 图片在预览 URL 与 Word 导出中的 mermaid.ink 编码和失败处理。

### Phases
- [completed] 1. 确认 mermaid.ink 源码解码逻辑和当前编码失败根因。
- [completed] 2. 将正文生成和 Word 导出的 Mermaid 编码改为压缩 JSON 状态。
- [completed] 3. 验证 Mermaid URL、正文任务插入 URL、Word 导出 media 嵌入。
- [completed] 4. 运行 `npm run build` 和 `git diff --check`。
- [completed] 5. 补齐最终进度记录和剩余手动验证提示。

### Decisions
- mermaid.ink `pako:` 编码使用 `zlib.deflateSync(JSON.stringify({ code, mermaid: { theme: 'default' } }))` + base64url。
- Word 导出下载图片失败时不再抛出到整个导出流程，而是在文档中写入“图片无法导出”占位。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 正文任务 smoke test 正则未提取到 Markdown 图片 URL | 第一次正文任务 URL 验证 | 改用字符串下标截取 URL |
| fake Mermaid 代码把 `\\n` 当作字面字符导致 mermaid.ink 返回 400 | 第二次正文任务 URL 验证 | 使用真实换行构造 Mermaid 代码 |

## Current Task: Step04 正文第三批优化

### Goal
实现 Mermaid 前端本地渲染，保留 Word 导出时通过 mermaid.ink 转图片；为导出过程增加友好提示、进度条、失败日志和导出后核对提示。

### Phases
- [completed] 1. 梳理正文预览、导出 IPC、preload 类型和 Word 导出服务。
- [completed] 2. 将正文生成中的 Mermaid 输出改为 Markdown `mermaid` 代码块，并在前端用 Mermaid 动态渲染。
- [completed] 3. 为 `export:word` 增加进度事件、Renderer 进度弹窗和导出友好提示。
- [completed] 4. 完善 Mermaid/图片导出失败 warning、控制台日志和导出结果核对提示。
- [completed] 5. 运行正文任务 smoke test、Word 导出 smoke test、失败路径 smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 正文中不再为新生成 Mermaid 图写入 mermaid.ink 图片 URL，改为保存 ` ```mermaid ` 代码块，方便前端本地渲染和人工编辑。
- Word 导出仍在 Electron Main 侧通过 mermaid.ink 转 PNG，Renderer 只显示导出进度和核对提示。
- 图片导出失败不阻断 Word 生成；失败信息写入文档占位、返回 `warnings`，并在导出弹窗中展示。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 评审问题修复

### Goal
修复评审指出的正文编排单点失败阻断全文生成、WebP 生成图无法导出 Word、`rehypeRaw` 预览与 Word 导出不一致风险。

### Phases
- [completed] 1. 将单章节编排失败降级为纯正文生成，不再阻断整批任务。
- [completed] 2. Word 导出识别 WebP，并在 Electron 运行时通过 `nativeImage` 转 PNG 后插入 docx。
- [completed] 3. Word 导出补充常见 HTML 节点转换：`br`、`img`、`table`、列表、引用、粗体、斜体、代码等。
- [completed] 4. 对不支持的 HTML 标签增加导出 warning，提示用户核对 Word。
- [completed] 5. 运行模块加载、编排失败降级、HTML 导出、`npm run build` 和 `git diff --check` 验证。

### Decisions
- 保留正文页 `rehypeRaw`，因为这是当前明确需求；通过增强 Word 导出支持来减少预览/导出差异。
- WebP 不直接写入 docx，避免 `docx` 默认 content type 不支持 WebP；导出前统一转 PNG。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 普通 Node 进程中 `electron.nativeImage` 不可用，WebP smoke test 只能走 warning | WebP Node smoke test | 保留 Electron Main 运行时 `nativeImage` 转 PNG；Node 环境仅验证失败不崩溃 |

## Current Task: Step04 编排进度展示优化

### Goal
将正文生成进度拆为编排进度和生成进度：编排阶段先显示绿色编排进度，并将目录待生成状态改为编排中；编排完成后再切回正文生成进度。

### Phases
- [completed] 1. 后台正文任务 stats 增加 `content.phase`、编排总数/完成数、生成总数/完成数。
- [completed] 2. 前端生成统计根据阶段显示“编排统计”或“生成统计”。
- [completed] 3. 编排阶段目录节点显示“编排中”，并使用绿色动效。
- [completed] 4. 运行模块加载、正文任务 stats smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 编排阶段不改写每个 section 的持久化状态，避免把临时 UI 阶段污染到正文结果；Renderer 根据 `task.stats.content.phase === 'planning'` 派生显示“编排中”。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 前端性能优化

### Goal
在不改流式 chunk 保存节流的前提下，降低 Step04 生成中和生成后 UI 卡顿：减少重复事件、避免目录统计重复递归、避免无关状态变化触发 Markdown 重解析，并限制 UI 日志体积。

### Phases
- [completed] 1. 合并正文任务中开始/完成/失败处的重复状态事件，保留 chunk 实时保存。
- [completed] 2. 预计算目录节点状态、叶子数和字数，`renderTree()` 直接读取缓存。
- [completed] 3. 将正文 Markdown 渲染拆为 `memo` 组件，只有正文内容变化才重新解析。
- [completed] 4. 前端任务状态日志裁剪为最近 80 条，并优先使用最新 `event.task`。
- [completed] 5. 运行模块加载、正文任务事件 smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 暂不做 chunk 级节流，保留当前实时落盘和实时显示策略。
- 日志裁剪只面向 Renderer UI 状态，用于降低每次 React state 更新的数据量。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `buildOutlineMeta()` 中叶子状态推断成 `string` 导致 TypeScript 构建失败 | 第一次 `npm run build` | 显式标注 `status: TreeStatus` 和 `nodeMeta: OutlineNodeMeta` |

## Current Task: Step04 全文重新生成清空旧内容

### Goal
点击“重新生成正文”应表示全文重新生成：开始前清空进度和已生成正文，不影响单章重新生成入口。

### Phases
- [completed] 1. 定位全文重新生成入口和 Main 侧正文任务初始化逻辑。
- [completed] 2. Renderer 确认开始全文重新生成时清空 outline content、`contentGenerationSections` 和 `contentGenerationTask` 并持久化。
- [completed] 3. Main 侧全文 `regenerate` 二次兜底清空 outline content，并用空 sections 计算初始进度。
- [completed] 4. 运行全文重新生成清空 smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 单章重新生成仍沿用原流程，不清空全文内容。
- 清空发生在生成配置弹窗点击“开始生成”后，而不是打开弹窗时。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 Mermaid 配图渲染失败自修复

### Goal
正文生成阶段在写入 Mermaid 代码块前先校验渲染结果；渲染失败时调用文本模型按错误信息最多修复 3 轮，仍失败则取消该 Mermaid 配图并保留正文，避免错误代码进入正文缓存。

### Phases
- [completed] 1. 补充 Mermaid 校验、修复 Prompt 和结构化修复结果处理。
- [completed] 2. 接入正文生成流程：通过才追加 Mermaid，持续失败则取消配图并记录日志/统计。
- [completed] 3. 运行修复成功与持续失败 smoke test。
- [completed] 4. 运行 `npm run build`、`git diff --check` 并更新进度记录。

### Decisions
- 校验放在 Electron Main 的正文任务中，发生在 `appendMermaidImageMarkdown()` 之前。
- 使用 mermaid.ink 图片接口做实际渲染校验，避免前端渲染失败后才发现问题。
- 单个 Mermaid 配图失败不阻断正文生成。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径指向 `$USERPROFILE\.opencode`，本机实际在 `.config\opencode` | 第一次 session catchup | 改用 `$USERPROFILE\.config\opencode\skills\...` 成功运行 |
| PowerShell 中直接用复杂 `node -e` smoke test 时引号被剥离，Node 误把 `-->` 当成参数 | 第一次 Mermaid smoke test | 改用临时 `.cjs` smoke 文件运行，验证完成后删除 |
| 修复成功 smoke test 预期修复 1 次，但 fetch stub 首次返回失败导致进入第 2 轮 | 第一次临时 smoke test | 调整 stub：初始失败由前端兼容规则触发，修复后首次 fetch 直接返回 PNG |

## Current Task: Step04 配图阶段重构

### Goal
将 Mermaid 图和 AI 生图从正文生成中拆到独立配图阶段；编排阶段允许同一章节同时成为 AI 生图和 Mermaid 候选；配图阶段优先按 AI 生图上限选择章节，未入选 AI 但具备 Mermaid 候选的章节降级为 Mermaid。AI 生图并发 2，Mermaid 校验/修复并发 5；AI 入选后生图失败不再降级 Mermaid。

### Phases
- [completed] 1. 改编排模型：允许 AI/Mermaid 双候选，并更新提示词和标准化/校验逻辑。
- [completed] 2. 将配图从 `runOne()` 正文生成中拆出，新增独立配图任务分配与执行。
- [completed] 3. 新增配图阶段进度 `illustrating` 和前端显示。
- [completed] 4. 运行 smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- AI 生图入选但失败时，即使该章节也有 Mermaid 候选，也不自动降级 Mermaid。
- AI 生图并发固定 2；Mermaid 校验/修复并发固定 5。
- 正文阶段只保存正文和表格，配图阶段再读取当前正文并追加图片或 Mermaid 代码块。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 Word 导出表格与编号修复

### Goal
修复正文预览正常但 Word 导出异常的问题：Markdown 表格在导出时应稳定识别为 Word 表格；不同正文块中的有序列表编号应独立，不再跨块连续计数。

### Phases
- [completed] 1. 排查 `exportService.cjs` 中 Markdown 解析、表格识别和有序列表 numbering reference 使用方式。
- [completed] 2. 在 Markdown 解析前接入表格预处理：统一换行、拆分被压成一行的表格、在表格前补空行。
- [completed] 3. 为每个有序列表块分配独立 Word numbering reference，并按实际使用的 reference 生成编号配置。
- [completed] 4. 运行导出 smoke test，验证压缩表格生成 `<w:tbl>`，两段独立有序列表使用不同 `numId`。
- [completed] 5. 运行模块加载、`npm run build` 和 `git diff --check` 验证。

### Decisions
- 表格修复限定在导出层，不改正文缓存内容，避免影响页面预览和用户编辑内容。
- 有序列表按 Markdown/HTML 列表块独立编号；每个 `ol` 或 Markdown ordered list 创建自己的 numbering reference。
- `Document` 的 numbering 配置在正文转换完成后按实际用到的 reference 动态生成；没有有序列表时不写 numbering 配置。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 Word 导出压缩表格二次修复

### Goal
修复导出 Word 时仍有一个 Markdown 表格未转换的问题：模型将 GFM 分隔行 `| :--- | ... |` 和第一行/多行数据压到同一行，导致 `remark-gfm` 无法识别表格。

### Phases
- [completed] 1. 根据截图复现“表头正常、分隔行后拼接数据”的 Markdown 形态。
- [completed] 2. 增强 `normalizeMarkdownTablesForDocx()`：按表头列数拆分压缩的分隔行和数据行。
- [completed] 3. 运行截图同形态导出 smoke test，确认生成 `<w:tbl>`、表格行数正确且不保留 `:---` 文本。
- [completed] 4. 运行模块加载、`npm run build` 和 `git diff --check` 验证。

### Decisions
- 继续只在导出层修复，不修改正文缓存中的 Markdown 原文。
- 压缩表格拆分只在“当前行是表头、下一行前 N 列均为分隔列且后续还有数据列”时触发，避免误伤普通表格。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 单章重新生成复用编排

### Goal
调整单章重新生成流程：优先复用全文生成时保存的编排结果，不再默认重新编排；如果历史编排缺失，则只对当前小节执行一次编排，然后重新生成正文并按编排结果重新配图。

### Phases
- [completed] 1. 增加 `contentGenerationPlans` 持久化字段和前端状态类型。
- [completed] 2. 全文生成整体编排完成后保存每个小节的最终配图决策：`ai`、`mermaid` 或 `none`。
- [completed] 3. 单章重新生成优先读取历史编排；有历史时跳过 `planAll()` 和 `planOne()`。
- [completed] 4. 单章历史缺失时仅编排目标小节，并保存该小节编排结果。
- [completed] 5. 单章重新生成正文后按最终编排结果执行 AI 生图或 Mermaid 配图。
- [completed] 6. 运行单章复用/缺失两条 smoke test、模块加载、`npm run build` 和 `git diff --check`。

### Decisions
- `contentGenerationPlans` 存在 `technical_plan.json` 根级，与 `contentGenerationSections` 同级。
- 保存的是最终执行决策，而不是单纯候选：AI 入选为 `ai`，Mermaid 执行为 `mermaid`，未配图为 `none`。
- 单章无历史编排时允许单章编排；单章编排中 Mermaid 默认可用，AI 生图仍受模型可用状态限制。
- 全文重新生成和目录重新生成会清空旧 `contentGenerationPlans`，避免复用过期目录的编排。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 Word 导出 HTML 容器修复

### Goal
修复评审指出的 Word 导出预览不一致问题：`div`、`section`、`article` 等 HTML 容器中包裹表格、列表、图片等块级内容时，应递归导出为 Word 原生结构，而不是压平成普通文本。

### Phases
- [completed] 1. 核对 `exportService.cjs` 中 HTML 节点导出路径，确认评审命中真实问题。
- [completed] 2. 新增块级子节点检测，块级容器包含表格/列表/引用/图片等内容时走 `htmlNodesToDocxBlocks()`。
- [completed] 3. 保留纯内联 `div/section/article` 的原段落导出行为，避免不必要的段落拆分。
- [completed] 4. 运行 HTML wrapper smoke test，验证包裹表格和列表仍导出为 Word 表格/列表。
- [completed] 5. 运行模块加载、`npm run build` 和 `git diff --check`。

### Decisions
- 只对包含块级子节点的容器拆块递归；纯文本或内联内容仍使用 `htmlInlineRuns()` 输出单段落。
- `p` 内如果出现表格、列表、图片等块级子节点，也拆块递归处理。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 Word 导出列表内表格修复

### Goal
修复 Markdown 列表项中的缩进表格导出 Word 时未被识别的问题。列表项内的 GFM 表格应保留缩进，让 `remark-gfm` 能识别为表格 AST，并最终导出为 Word 原生表格。

### Phases
- [completed] 1. 复现并定位：表格归一化中的 `expandInlineMarkdownTableRows()` 会丢掉分隔行前的列表缩进。
- [completed] 2. 修改表格行拆分逻辑，空白前缀代表缩进时保留缩进，文本前缀仍拆成正文行。
- [completed] 3. 修改压缩表格拆分逻辑，让拆出的分隔行和数据行继承表头行缩进。
- [completed] 4. 运行列表项内表格 smoke test，确认生成 Word 表格、外围列表保留且不残留管道表格文本。
- [completed] 5. 运行 `exportService` 模块加载、`npm run build` 和 `git diff --check`。

### Decisions
- 只在导出层修复 Markdown 归一化，不修改正文缓存原文。
- 对 `|` 前只有空白的表格行保留原缩进；对 `表题 | 表头 | ...` 这类文本前缀仍按“正文 + 表格”拆分。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step03 目录生成知识库选择 UI

### Goal
将 Step03 目录生成改为弹窗式配置：在弹窗内选择生成方式和本次参考知识库文档；页面原有生成方式切换去掉。本轮只做页面和前端状态，不改目录生成后台逻辑。

### Phases
- [completed] 1. 梳理现有 Step03 UI、目录生成参数、知识库列表类型和弹窗样式。
- [completed] 2. 扩展技术方案前端状态，保存本次参考知识库文档 ID。
- [completed] 3. 改造 `OutlineEditPage`：生成按钮打开配置弹窗，弹窗内选择生成方式和知识库文档。
- [completed] 4. 补充样式，移除页面原生成方式切换。
- [completed] 5. 运行构建验证并记录结果。

### Decisions
- 不新增 Step，知识库选择放在 Step03 目录生成弹窗内。
- 只允许选择处理完成的知识库文档，未完成/失败文档显示但禁用。
- 本轮不把知识库文档传给后台目录生成任务，避免提前改动目录生成逻辑。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step03 目录生成应用知识库

### Goal
完整接入 Step03 目录生成参考知识库：用户选择知识库文档后，目录生成仅在二三级目录阶段读取并参考选中文档的轻量知识条目，目录节点只保存 `knowledge_item_ids`，引用 ID 使用 `document_id::item_id` 避免跨文件冲突。

### Phases
- [completed] 1. 扩展前端类型和启动 payload，传递并保存参考知识库文档 ID。
- [completed] 2. 为 Main 侧任务服务注入知识库服务，并新增知识库只读引用方法。
- [completed] 3. 扩展目录生成任务：读取轻量知识条目、关键词筛选、prompt 注入、normalizer 保留合法 `knowledge_item_ids`。
- [completed] 4. 保证自由生成和评分项对齐都只在二三级目录阶段使用知识库，一级目录不参考。
- [completed] 5. 运行语法检查、构建和关键 smoke test。

### Decisions
- 只读取知识条目的 `id/title/resume`，不读取正文内容。
- 目录 JSON 只新增 `knowledge_item_ids`，不增加 `knowledge_usage_hint`。
- 跨文档引用统一使用 `document_id::item_id`。
- 无可用知识条目时，目录生成按普通流程继续执行。
- AI 返回不存在的 `knowledge_item_ids` 时过滤掉，不让引用字段影响目录生成主流程。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `node -e` smoke test 因 PowerShell 字符串转义导致 `SyntaxError: Unexpected end of input` | 第一次目录知识引用 smoke test | 改用不含 JSON 字符串比较的断言写法重跑 |
| 第二次 smoke test 中非法 `bad-id` 未被过滤 | 第二次目录知识引用 smoke test | 定位为 fake AI 未执行 `request.normalizer`；同时在目录合并阶段增加全局知识 ID 过滤作为双重保护 |
| 自由模式知识库边界 smoke test 触发 `完整目录至少需要三级结构` | 第一次自由模式 smoke test | fake AI 只返回二级目录，补充三级节点后重跑 |

## Current Task: Step03 知识库目录 Patch 增强

### Goal
将 Step03 知识库应用方式改为：先完全按原目录生成逻辑生成完整目录，不参考知识库；再把完整目录和选中知识库轻量条目交给 AI，让 AI 只返回二三级目录补充 Patch（bindings/additions），程序应用补丁并全局去重 `knowledge_item_ids`。

### Phases
- [completed] 1. 移除二三级目录分批 prompt 注入知识库逻辑，恢复原目录生成路径。
- [completed] 2. 新增知识库 Patch prompt、normalizer、validator 和补丁应用逻辑。
- [completed] 3. 将 Patch 增强接入自由生成和评分项对齐模式的完整目录生成之后。
- [completed] 4. 验证 Patch 只影响二三级目录、AI 不返回完整目录、知识 ID 全局最多保留一次。
- [completed] 5. 运行语法检查、构建、smoke test 和空白检查。

### Decisions
- AI Patch 只允许返回 `bindings` 和 `additions`，不允许返回完整 `outline`。
- 一级目录不可新增、不可修改、不可删除。
- 优先绑定已有二三级目录，只有现有目录无法承载时才新增二级或三级目录。
- 同一个 `knowledge_item_id` 在整份目录中最多保留一次。
- 新增目录由程序统一重编号，AI 不负责编号。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| PowerShell 长 `node -e` smoke test 中双引号被吞导致 `SyntaxError: Unexpected token '.'` | 第一次 Patch 流程 smoke test | 改用临时 `.cjs` 文件运行 smoke test，执行后删除临时文件 |

## Current Task: Step03 知识库 Patch 校验修复增强

### Goal
修复知识库目录 Patch 中模型照抄 `document_id::K000001` 占位 ID、将新增节点挂到三级目录导致全部过滤的问题；强化提示词，提供真实白名单，并让非法 Patch 进入 JSON 修复流程，同时在开发者模式下输出校验与应用日志。

### Phases
- [completed] 1. 强化 Patch prompt：移除占位示例，加入真实知识库 ID 示例、可绑定目录 ID、可新增父级 ID 和可用知识库 ID 白名单。
- [completed] 2. 增加严格 Patch 校验：非法知识 ID、短 ID、一级绑定、三级 parent、重复知识 ID、返回完整 outline 等都抛错。
- [completed] 3. 接入修复流程：严格校验错误交给 `collectJsonResponse` 的 JSON 修复链路处理。
- [completed] 4. 开发者模式增加任务日志：输出白名单规模、校验失败原因、原始尝试摘要、校验通过统计和应用统计。
- [completed] 5. 运行修复 smoke test、CJS 语法检查、`npm run build` 和 `git diff --check`。

### Decisions
- Patch normalizer 不再静默过滤非法模型输出，避免“任务成功但知识库没有生效”。
- 最终应用层仍保留过滤和全局去重，防止脏数据落盘。
- 三级目录不能作为 `additions.parent_id`；如果模型想补充三级目录，应绑定该三级目录或挂到其父级二级目录。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step03 知识库 additions-only 补三级目录

### Goal
将 Step03 完整目录后的知识库增强从 `bindings/additions + knowledge_item_ids` 改为 additions-only：知识库只作为参考材料，AI 只输出缺失三级目录，程序把新增目录追加到现有二级目录下并统一编号，不再写入任何 `knowledge_item_ids`。

### Phases
- [completed] 1. 核对旧 Patch 逻辑、修复链路和知识库轻量引用契约。
- [completed] 2. 替换 prompt、normalizer、validator 和应用逻辑为 additions-only。
- [completed] 3. 增加 smoke test 或等效验证，覆盖旧 bindings-only/多余字段/三级 parent 自动上提。
- [completed] 4. 运行 CJS 语法检查、客户端构建和 diff 检查。
- [completed] 5. 更新计划、发现和进度记录。

### Decisions
- 主目录生成仍不参考知识库；知识库增强只在完整目录生成和审核之后执行。
- AI 不再看到或返回知识库 ID，正文生成阶段再重新编排目录与知识条目关联。
- `parent_id` 只允许最终指向现有二级目录；如果模型误填三级目录，程序自动上提到其父级二级目录。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| additions-only smoke test 中完整目录 fake AI 返回旧编号，导致补目录阶段找不到 `1.1` | 第一次 smoke test | 将 fake 完整目录 ID 改为真实 `1`、`1.1`、`1.1.1` 后重跑通过 |

## Current Task: Step04 正文编排阶段关联知识库

### Goal
在现有每个叶子节点的正文编排 JSON 中增加 `knowledge.item_ids`，编排阶段只提交知识库 `id/title/resume`，不提交知识库正文；不做单独全局知识库分配，不限制同一知识条目被多个叶子节点复用。

### Phases
- [completed] 1. 核对现有正文编排 JSON、`contentGenerationPlans` 落盘结构和知识库轻量引用读取方式。
- [completed] 2. 扩展 `ContentGenerationPlanData` 与 Main 侧 `normalizeContentPlan()`，支持 `knowledge.item_ids`。
- [completed] 3. 在正文编排 prompt 中加入固定顺序的知识库轻量清单，并要求 `knowledge.item_ids` 只从清单 ID 中选择。
- [completed] 4. 让正文生成任务接收 `reference_knowledge_document_ids`，并复用知识库轻量条目读取服务。
- [completed] 5. 运行 CJS 语法检查、知识库编排归一化 smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 知识库关联直接并入现有叶子节点编排，不新增全局知识库编排阶段。
- 编排阶段不需要 `reason`；只落盘 `knowledge.item_ids`。
- 归一化只做本叶子节点内去重和非法 ID 过滤，不限制同一知识条目跨叶子节点复用。
- 本轮不改正文生成 prompt，不读取知识库正文，只先完成编排阶段关联落盘。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 活跃留存与配置使用统计

### Goal
只补充两类统计：活跃与留存、配置使用情况。客户端异步上报匿名配置状态，不采集 API Key、Base URL、模型名、文件名、路径、文档内容或生成内容；统计页展示活跃客户端、留存概览和配置分布。

### Phases
- [completed] 1. 扩展客户端配置和埋点封装：`analytics_created_at`、`config_usage`、配置字段白名单。
- [completed] 2. 在设置保存、Step02、Step03、Step04 启动点接入配置使用上报。
- [completed] 3. 扩展 Worker `/track`、`/api/summary`，新增 `/api/retention` 与 `/api/config-usage`。
- [completed] 4. 更新 Dashboard 展示活跃指标、留存概览、配置使用分布和最近事件分页。
- [completed] 5. 运行 Worker 语法检查、客户端构建和空白检查。

### Decisions
- `client_id` 和 `analytics_created_at` 都存入 Electron `userData/user_config.json`。
- 配置使用事件只记录枚举值和布尔值，不记录任何用户内容或密钥。
- 留存基于 `analytics_created_at` cohort 和 `app_open` 活跃事件计算；缺少创建日期的旧事件不参与留存。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| PowerShell 中首次 `node -e` smoke test 使用外层单引号导致传给 Node 的 JS 字符串引号被剥离 | 第一次 smoke test | 改用外层双引号、JS 字符串使用单引号后重跑通过 |

## Current Task: Step04 正文生成阶段应用知识库

### Goal
在正文生成阶段消费编排结果中的 `knowledge.item_ids`：程序读取对应知识条目的 `content`，并在正文生成 prompt 中只注入 content，不暴露知识库 ID、标题、简介或来源字段；素材消息放在章节动态信息之前以保持缓存友好。

### Phases
- [completed] 1. 确认知识库最终条目落盘字段和正文生成 prompt 当前消息顺序。
- [completed] 2. 新增知识库正文素材 Map，按 `documentId::itemId` 定位 `items.json` 中的 `content`。
- [completed] 3. 在 `runOne()` 中按当前小节 `contentPlan.knowledge.item_ids` 解析正文素材并传入正文生成 prompt。
- [completed] 4. 调整正文生成消息顺序：项目概述之后、上级/同级/当前章节之前注入知识库 content。
- [completed] 5. 运行 CJS 语法检查、正文 prompt content-only smoke test、`npm run build` 和 `git diff --check`。

### Decisions
- 给正文模型的知识库素材只包含 `content`，不传 `id/title/resume/source_file/source_block_ids`。
- 素材按知识库读取顺序输出，保证相同素材组合时 prompt 顺序稳定。
- 没有匹配内容或条目正文为空时不追加知识库素材消息。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 知识库查看链路性能埋点

### Goal
补充知识库开发者模式渲染调试日志，覆盖从点击“查看条目/Markdown”到 IPC 读取、状态更新、条目列表渲染、DOM 提交和下一帧可见的完整链路，用于定位用户感知慢点。

### Phases
- [completed] 1. 记录当前代码结构和已有日志覆盖范围。
- [completed] 2. 实现 `openDocument()` 读取链路日志和内容规模统计。
- [completed] 3. 给知识条目列表增加 Profiler、DOM 指标、Long Task 和下一帧可见日志。
- [completed] 4. 保持日志仅开发者模式启用，并兼容现有复制日志按钮。
- [completed] 5. 运行构建验证并记录结果。

### Decisions
- 不继续盲调 `查看原文`，先用日志确认慢点位于读取、IPC、JSON 解析、列表渲染还是单条原文渲染。
- 本轮只加开发者模式诊断日志，不改变知识库业务流程和自动匹配逻辑。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `collectItemsContentMetrics()` 返回的 `metrics` 被 TypeScript 推断成不含 `chars` 的窄类型 | 第一次 `npm run build` | 将集合指标显式声明为 `Record<string, number>` 后重跑构建通过 |

## Current Task: 知识条目原文弹窗化

### Goal
将知识库“查看原文”从页面内替换/跳转改为弹窗，关闭后保持条目列表 DOM 和滚动位置，避免用户在列表底部查看原文后回到顶部。

### Phases
- [completed] 1. 查找现有 Radix Dialog 用法和知识库原文查看代码。
- [completed] 2. 将原文查看改为 Dialog，条目列表始终渲染。
- [completed] 3. 新增知识库原文弹窗遮罩、卡片、标题和正文内部滚动样式。
- [completed] 4. 运行 `npm run build` 验证。

### Decisions
- 保留现有 `openSourceItem()`、`closeSourceItem()`、`sourceTrace` 和 `sourceRendering` 调试链路。
- 弹窗关闭只清理当前原文状态，不卸载条目列表。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 标书查重元数据模块

### Goal
实现标书查重 Step02 的元数据子模块：首次从 Step01 进入 Step02 时自动启动分析；正文内容提取和投标文件元数据提取并发执行，两条任务内部按文件线性处理；正文提取保留图片；元数据横向对比并标红重复项。

### Phases
- [completed] 1. 新增 Main 侧标书查重服务、IPC、preload 和类型。
- [completed] 2. 实现内容提取任务：所有文件线性提取 Markdown，`preserveImages: true`，按文件独立资源 scope 保存内容。
- [completed] 3. 实现元数据提取任务：投标文件线性提取文件系统、DOCX、PDF 元数据。
- [completed] 4. Renderer 接入 Step02 自动启动、事件合并和缓存持久化。
- [completed] 5. 元数据 tab 展示进度、横向对比表和重复项标红。
- [completed] 6. 运行 CJS 语法检查和客户端构建验证。

### Decisions
- 招标文件参与正文提取，不参与元数据横向对比。
- 正文提取必须保留图片，图片资源使用 `duplicate-check-content-<fileId>` 前缀，便于重置时清理。
- 元数据重复标红只比较同一元数据项下的非空规范化值；文件名、路径、扩展名、大小等基础标识不参与标红。
- 时间类元数据不要求完全一致；同一天出现于多份投标文件时用橙色高亮。
- “重新查重”使用 `force: true` 强制重跑当前文件批次。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| TypeScript 报 `file is possibly null` | 第一次 `npm run build` | 在计算签名前先构造 `LocalFileSelection[]`，避免 `filter(Boolean)` 后类型未收窄 |

## Current Task: 标书查重 WPS/DOC/PDF 元数据增强

### Goal
增强标书查重元数据读取能力，重点覆盖 `.wps/.doc` 的 OLE/HPSF 文档属性、LibreOffice 转 `.docx` 后的补充属性，以及 PDF 全量 Info/XMP/原始记录；尽可能识别 WPS/Kingsoft/账号相关痕迹。

### Phases
- [completed] 1. 新增 `cfb` 依赖并确认 CommonJS API 可用。
- [completed] 2. 将 legacy Word 转 DOCX 临时转换逻辑抽成 `withLegacyWordDocxFile()` 供元数据流程复用。
- [completed] 3. 实现 OLE Property Set Stream 解析，读取 `SummaryInformation`、`DocumentSummaryInformation` 和自定义属性。
- [completed] 4. `.doc/.wps` 元数据流程改为原始 OLE 属性 + 转换 DOCX 属性补充，失败时保留已读字段并记录 `metadata_error`。
- [completed] 5. PDF 元数据改为展开全部 `info`、可迭代 XMP、fingerprints、permissions 和原始 `/Author` 等记录。
- [completed] 6. 更新动态比较规则，新增 `converted_docx:`、`pdf_info:`、`pdf_xmp:`、`pdf_raw:`、`ole_signal:`、`wps:` 前缀参与横向比较。
- [completed] 7. 运行语法检查、模块加载、`npm run build`、`npm audit` 和 `git diff --check`。

### Decisions
- WPS 账号不是标准 Office 元数据字段，本轮只标记“疑似 WPS 用户/账号”字段，不承诺一定能从离线文件读出真实账号。
- `.doc/.wps` 转 DOCX 失败不阻断 OLE 元数据结果；同时在表格中写入 `metadata_error` 说明失败原因。
- PDF 保留跨格式可比的 canonical 字段，同时用 `pdf_info:*` / `pdf_xmp:*` / `pdf_raw:*` 展开来源字段。
- 原始 OLE/PDF 二进制扫描只截取命中 WPS/Kingsoft/account/email 等关键词的短片段，避免把整段正文或 XML 塞进对比表。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| `npm audit` 报 1 个 moderate 漏洞 | 依赖变更后审计 | 漏洞来自既有 `mermaid 11.14.0`，本次新增 `cfb` 未引入新审计项；未自动 `npm audit fix`，避免扩大依赖变更 |

## Current Task: 标书查重正文和图片比对

### Goal
在标书查重 Step02 中新增纯程序正文和图片比对：正文按句子聚合重复，引用招标文件句子不计重复；图片按 hash 筛选完全相同图片；正文和图片分析在正文 Markdown 提取完成后并发执行，不调用 AI。

### Phases
- [completed] 1. 记录范围和现有查重流程接入点。
- [completed] 2. 扩展共享类型和工作区状态，新增正文/图片分析状态。
- [completed] 3. 实现正文句子拆分、招标白名单排除和 Map 聚合重复句子。
- [completed] 4. 实现 Markdown 图片提取、`yibiao-asset` 本地解析、hash 聚合重复图片。
- [completed] 5. 接入后台流程，正文提取完成后并发运行目录、正文、图片分析。
- [completed] 6. 实现正文/图片 Tab UI：投标文件编号条、分页重复句子列表、分页重复图片列表。
- [completed] 7. 运行 CJS 检查、构建和 diff 检查。

### Decisions
- 不调用 AI，不做语义相似，只做规则拆句和精确规范化匹配。
- 正文比对忽略 Markdown 图片和 HTML 图片；投标文件中命中招标文件句子的内容不计重复。
- 图片只按 SHA256 字节 hash 判断完全一致，不做感知 hash 或截图相似度。
- 使用全局 Map 聚合，避免投标文件两两全文比较。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `git diff --check` 报 `client/doc/标书查重.md:54 trailing whitespace` | 收尾检查 | 该文件是既有/用户改动，本轮未修改；本轮相关文件 diff check 仅 LF/CRLF 提示 |

## Current Task: 标书查重正文分句结构化修复

### Goal
修复正文比对中 HTML/Markdown 表格单元格被拼成同一句的问题，移除“疑似表格拼接”特例过滤，把正文分句从字符串硬过滤改为先提取结构化文本块再分句。

### Phases
- [completed] 1. 复核正文分句链路、真实缓存表格形态和依赖。
- [completed] 2. 将 HTML 表格按 `<td>/<th>` 单元格提取文本块，保留 `<p>/<li>/<br>` 内部边界。
- [completed] 3. 将 Markdown 管道表按表格行列解析，不再把 `|` 替换成句号。
- [completed] 4. 移除 `isLikelyMergedTableSentence()` 特例过滤，正文清洗不再删除编号前缀。
- [completed] 5. 用真实缓存和合成 Markdown 表格验证错误拼接句消失。
- [completed] 6. 运行 CJS 检查、模块加载、`npm run build` 和本次文件 diff check。

### Decisions
- 表格边界由结构解析决定，不再通过 `无偏离` 等业务词特例过滤。
- 正文句子保留原始标点和编号；规范化只清理控制字符和空白。
- 短字段不一概丢弃，`交货期：30天`、`质保期：三年` 这类字段会保留；`无偏离` 这类低信息短词仍不进入重复句。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |

## Current Task: 标书查重正文比对忽略句首序号

### Goal
正文重复比对和招标引用排除都忽略句首结构性序号，避免 `3.特别要求：...` 与 `特别要求：...` 因序号差异无法匹配；展示句仍保留原文，正文内部数字、型号、标准号、金额、日期不受影响。

### Phases
- [completed] 1. 复现目标句在招标文件和投标文件中 normalized 不一致的问题。
- [completed] 2. 增加只处理句首结构性序号的规范化逻辑。
- [completed] 3. 用真实缓存验证目标句命中招标白名单并从重复句中消失。
- [completed] 4. 验证 `GB/T 29768-2013`、`交货期：30天`、`质保期：3年`、`第2包` 不被误删。
- [completed] 5. 运行 CJS 检查、模块加载、`npm run build` 和本次文件 diff check。

### Decisions
- 只剥离句首结构性序号：阿拉伯数字层级编号、中文编号、括号编号、圈号。
- 不处理正文中间的数字和业务字段；标点差异仍按不同内容处理。
- 当前继续复用 `normalized` 作为正文比对和招标白名单 key，`sentence` 保留原文用于展示。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 标书查重正文序号归一化二次修复

### Goal
修复截图中短标题类正文重复项仍出现的问题：重复判断和招标白名单阶段继续忽略句首结构序号，但不通过 UI 隐藏原文；调整正文句子入库顺序并补齐低风险序号格式。

### Phases
- [completed] 1. 核对当前序号覆盖范围、截图相关缓存结果和前端展示字段。
- [completed] 2. 定位短标题仍进入重复结果的真实原因：先按原句判断信息量，再去序号归一化。
- [completed] 3. 将正文分句流程改为先生成 `normalized`，再用 `normalized` 判断是否进入正文句库/招标白名单。
- [completed] 4. 补齐 Markdown 转义序号、全角数字、括号/圈号后分隔符和章节号等低风险句首结构序号。
- [completed] 5. 用真实缓存模拟正文分析，确认截图短标题重复项消失且招标引用排除仍有效。
- [completed] 6. 运行 CJS 检查、preload/IPC 检查、`npm run build` 和本次文件 diff check。

### Decisions
- 前端继续展示 `sentence` 原文作为证据，不改成 `normalized`。
- 重复聚合和招标文件白名单统一使用 `normalized`，即去句首结构序号后的文本。
- 不做全局 `NFKC`，不删除正文标点，只对句首结构序号做局部剥离。
- 英文字母编号、罗马数字、附件/表图编号暂不纳入本轮剥离，避免误伤型号或正文引用。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| VM 方式验证私有函数时相对 `require('../utils/paths.cjs')` 失败 | 第一次函数验证 | 使用 `module.createRequire(file)` 以服务文件路径创建本地 require |
