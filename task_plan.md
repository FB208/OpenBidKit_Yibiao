# Task Plan

## Current Task: Analytics 北京时间统一修复

### Goal
保证之后新增的客户端身份、Analytics Engine 近期查询、最近事件展示、留存计算和 Cron 汇总写入时间均统一使用北京时间 `Asia/Shanghai`；不修正已存在数据。

### Phases
- [completed] 1. 将客户端 `analytics_created_at` 生成口径改为北京时间日期。
- [completed] 2. 将 Worker 近期 AE 查询从 UTC 滚动窗口改为北京时间自然日范围。
- [completed] 3. 将最近事件、留存和 Cron 首次访问时间统一为北京时间展示/落库。
- [completed] 4. 运行语法检查、客户端构建、边界时间验证和 diff 检查。

### Decisions
- 不覆盖已存在的 `analytics_created_at`，只影响之后缺失身份的新客户端。
- `today/7/30/90` 这类统计范围按北京时间自然日计算，不按 `NOW() - INTERVAL` 的滚动窗口计算。
- Dashboard 仍直接展示 API 返回值，由 Worker 保证返回北京时间字符串。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 无 | 本轮实现 | 相关语法检查、客户端构建、北京时间边界验证和 diff check 通过 |

### Validation
- `node --check` 通过：`client/electron/services/configStore.cjs`。
- `node --check` 通过：`analytics/worker/src/utils.js`、`services/analyticsStatsStore.js`、`routes/latest.js`、`routes/retention.js`、`routes/resources.js`、`routes/projects.js`。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- 北京时间边界验证通过：`2026-06-12T16:30:00.000Z` 识别为 `2026-06-13 00:30:00`。
- `git diff --check` 通过，仅有 LF/CRLF 提示。

## Current Task: Analytics 统计功能新版完整重构

### Goal
按 `client/doc/统计改造计划.md` 的完整方案重构 `analytics/` 埋点统计功能：公告管理和资源管理保持不变；AE 采集字段保持不变；`ANALYTICS_DB` 统计库放弃旧表结构并基于新版 `stats_*` 表重建；`/track` 写 AE 并实时写客户端表；Cron 每天北京时间 2 点汇总前一天 AE 数据到 D1；Dashboard 按标签页懒加载，新增客户端统计，并按历史/D1、今天/7天/30天 AE 的口径查询。

### Phases
- [completed] 1. 重建 Analytics D1 schema、setup 脚本和旧统计入口清理。
- [completed] 2. 实现新版统计存储服务、`/track` 实时客户端写入和 Cron 汇总。
- [completed] 3. 替换 Worker 统计接口：overview、clients、client-detail、traffic、config/model、latest、projects、resources。
- [completed] 4. 改造 Dashboard：概览、客户端统计、访问分析、配置、模型、最近事件筛选和标签页加载。
- [completed] 5. 更新 `analytics/逻辑梳理.md`、README 和执行说明。
- [completed] 6. 运行 Worker/脚本/Dashboard 语法检查和必要验证。

### Decisions
- `ANALYTICS_DB` binding 名保留，但旧 `analytics_*` 统计表和旧数据可直接删除；用户可直接删除 Cloudflare D1 `openbidkit-analytics` 后由 setup 重建。
- D1 可以明文保存 `client_id`，用于客户端统计列表和新增客户端判断。
- 活跃客户端口径为任意有效事件去重客户端，不再限定 `app_open`。
- 历史范围读 D1；今天/7天/30天读 AE；最近事件只读 AE，不入 D1。
- 资源管理不属于埋点统计改造，功能保持不变；资源点击历史统计需迁移到新版统计表以保持资源点击数可用。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `git diff --check` 全仓检查报 `client/doc/统计改造计划.md:65 new blank line at EOF` | 最终空白检查 | 该文件是用户先改的需求文档，本轮未直接修改；已单独运行 `git diff --check -- analytics`，本轮 analytics 变更仅有 LF/CRLF 提示无空白错误 |

### Validation
- `node --check` 通过：`analytics/worker/src/services/analyticsStatsStore.js`、`routes/overview.js`、`routes/clients.js`、`routes/traffic.js`、`routes/configUsage.js`、`routes/latest.js`、`routes/track.js`、`routes/projects.js`、`routes/resources.js`、`src/index.js`。
- `node --check` 通过：`analytics/scripts/setup-analytics-storage.mjs`、`analytics/scripts/deploy-if-changed.mjs`、Dashboard `api.js`、`state.js`、`main.js`、`tabs.js`、`render.js`、`pages/overview.js`、`pages/clients.js`、`pages/traffic.js`、`pages/configUsage.js`、`pages/latest.js`、`pages/resources.js`。
- 旧引用扫描通过：旧 `analyticsD1Query`、`analyticsDailyRollup`、`/api/summary`、`backfill:analytics`、Queue、旧 `analytics_daily_*` / `analytics_monthly_*` / anonymous index 表引用已从 `analytics/` 代码和文档中清理。
- `git diff --check -- analytics` 通过，仅有 LF/CRLF 提示。

## Current Task: Analytics 长期统计去 Queue 与每日汇总改造

### Goal
按 `client/doc/统计改造计划.md` 的最终方案实现 Analytics 长期统计：`/track` 只写 Analytics Engine，Worker Cron 每天汇总昨日 Analytics Engine 聚合结果到 `ANALYTICS_DB` D1；D1 只保存每日聚合结果和匿名 hash 去重索引，不保存原始事件明细或明文 `client_id`。

### Phases
- [completed] 1. 梳理现有 Analytics Worker/Dashboard 边界并补充文件型计划。
- [completed] 2. 新增 D1 migration、Analytics storage setup 脚本、部署前 setup 接入。
- [completed] 3. 去除 Queue 热路径，新增 Analytics Engine track 服务和每日汇总服务。
- [completed] 4. 新增/改造 D1 查询接口：overview、traffic history、config/model/resource history、projects。
- [completed] 5. 改造 Dashboard 控件、概览页分区和各 Tab 历史总数。
- [completed] 6. 更新文档与运行语法检查/必要构建验证。
- [completed] 7. 新增 Analytics Engine 到 D1 的历史回填脚本、命令入口和文档说明。
- [completed] 8. 将旧 Queue/monthly 方案迁移为 D1 daily rollup + Cron，更新 setup、wrangler、README 和统计改造计划。

### Decisions
- 不改桌面客户端埋点入口；客户端继续 fire-and-forget。
- `/track` 不再生成 `event_id`、不投递 Queue、不中转 D1，只写 Analytics Engine。
- D1 不保存原始事件明细，只保存每日聚合表和匿名客户端/维度 hash 去重索引。
- 生产 Dashboard 不再允许任意 API 地址，固定使用 `https://analytics.agnet.top` 或当前同源；开发调试可通过构建/运行配置放开。
- 近期 7/30/90 天灵活分析暂保留 Analytics Engine 数据源；历史总数和长期累计读 D1，并在 Dashboard 标注数据源差异。
- Cron 固定为 `15 18 * * *`，北京时间每天 02:15 汇总昨日。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 本机非交互环境缺少 `CLOUDFLARE_API_TOKEN`，`npm run setup:analytics-storage` 无法创建/配置远程 D1 | 尝试执行生产回填前先运行 setup | 已确认未写入远程资源；需要设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 后重跑 setup，再执行 backfill |
| 旧 setup 补丁按上下文删除 Queue 函数失败 | `apply_patch` 局部匹配正则转义块 | 改为整文件替换 `setup-analytics-storage.mjs`，保留 D1 setup 并新增 Cron 检查 |

### Validation
- `node --check` 通过：`src/services/analyticsTrack.js`、`src/services/analyticsDailyRollup.js`、`src/services/analyticsD1Query.js`、`src/routes/track.js`、`src/index.js`、`../scripts/setup-analytics-storage.mjs`、`../scripts/backfill-analytics-rollups.mjs`。
- `node --check` 通过：`src/routes/overview.js`、`src/routes/summary.js`、`src/routes/traffic.js`、`src/routes/configUsage.js`、`src/routes/projects.js`、`src/routes/resources.js`、`../scripts/deploy-if-changed.mjs`。
- `npm run backfill:analytics -- --project yibiao-client --start 2026-03-15 --end 2026-06-12 --dry-run` 通过。
- `git diff --check` 通过，仅有 LF/CRLF 提示。
- 历史记录：旧 Queue 版曾通过 Worker/Dashboard/setup/deploy/backfill 语法检查，现已被 daily rollup 方案替换。
- `node --check` 通过：Dashboard `public/src/api.js`、`state.js`、`main.js`、`pages/overview.js`、`pages/traffic.js`、`pages/configUsage.js`、`pages/resources.js`。
- `git diff --check` 通过，仅有 LF/CRLF 提示。
- `node --check analytics/scripts/backfill-analytics-rollups.mjs` 通过。
- `npm run backfill:analytics -- --project yibiao-client --start 2026-03-15 --end 2026-06-12 --dry-run` 通过。

## Current Task: 废标项检查多投标文件支持

### Goal
标书检查-废标项检查支持一个招标文件对应多份投标文件：投标文件上传样式参考标书查重；正文预览 Tab 动态显示“投标文件1/2/...”；多份投标文件一起提交给 AI；三类检查结果必须结构化归属到具体投标文件，并在 UI 中按文件筛选/分组展示。

### Phases
- [completed] 1. 更新计划文件并确认现有单投标文件边界。
- [completed] 2. 改造类型、IPC 类型和页面状态为多投标文件模型。
- [completed] 3. 改造 SQLite schema、Store 和文件导入/移除逻辑。
- [completed] 4. 改造废标检查 Main 任务与 Prompt，结果带投标文件归属。
- [completed] 5. 改造页面正文动态 Tab、结果筛选/分组和删除/复制交互。
- [completed] 6. 补充样式和 SQL 说明文件。
- [completed] 7. 运行 CJS 检查与客户端构建验证。

### Decisions
- 不保留旧 `bidDocument` 单份模型作为业务分支；运行态统一使用 `bidDocuments[]`。
- 结果结构必须包含 `bidDocumentId`，页面不依赖 AI 在证据文本中手写文件名来区分归属。
- “全部”结果视图按投标文件分组展示；文件筛选提供“全部/投标文件1/投标文件2”。
- 招标文件仍单份；投标文件支持追加上传、多选、去重和逐份移除。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| v12 迁移先调用完整废标 schema 会在旧表上创建 `role/sort_order` 索引，旧表缺 `sort_order` 导致升级失败 | 复核 `migrateRejectionCheckMultiBidDocuments()` | 改为先识别旧表并重命名/重建，或先补 `sort_order` 后再建完整 schema；Electron runtime 旧 v11 冒烟测试通过 |
| 普通 Node 运行迁移 smoke 时 `better-sqlite3` ABI 不匹配 | `node -e` 实例化测试库 | 改用 Electron runtime 执行临时 CJS 冒烟脚本，验证完成后删除临时脚本 |

### Validation
- `node --check electron\services\sqliteDatabase.cjs` 通过。
- `node --check electron\services\fileService.cjs` 通过。
- `node --check electron\services\rejectionCheckStore.cjs` 通过。
- `node --check electron\services\rejectionCheckTask.cjs` 通过。
- `node --check electron\preload.cjs` 通过。
- Electron runtime 旧 v11 废标项检查库升级到 v12 冒烟测试通过。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- `git diff --check` 通过，仅有 LF/CRLF 提示。
- 旧单文件字段残留复扫无 `state.bidDocument` / `bidDocument:` / `readDocumentMarkdown('bid')` 业务依赖。

## Current Task: 已有方案扩写 Step05 正文还原与扩写

### Goal
在 `existing-plan-expansion` 工作流中改造 Step05 正文生成：正文编排后新增原方案还原阶段，AI 只返回原方案段编号归属，程序拼接真实原文写入叶子节点；首轮正文生成对已还原节点走“基于原文优化扩写”分支；补目录时锁定已还原节点；原方案覆盖审计作为扩写模式专属设置项默认关闭。

### Phases
- [completed] 1. 梳理现有正文生成、配置 UI、任务阶段和 content plan 持久化边界。
- [completed] 2. 扩展 Renderer 类型和 Step05 设置 UI，增加扩写模式专属覆盖审计开关。
- [completed] 3. 扩展 Main 正文生成 plan 结构，新增原方案段落拆分、映射还原阶段和保存逻辑。
- [completed] 4. 改造首轮正文生成分支、续跑判断和补目录锁定规则。
- [completed] 5. 接入可选原方案覆盖审计和修复阶段。
- [completed] 6. 运行语法检查和客户端构建验证。
- [completed] 7. 修复评审发现的替换原方案下游状态失效和 Analytics 步骤映射问题。
- [completed] 8. 增加两种技术方案模式切换确认，确认后保留招标文件、Step02 解析和参考知识库，清空模式相关进度。

### Decisions
- 不新增 SQLite 表，原方案还原状态优先保存到 `contentGenerationPlans.plan.original_material`。
- 还原阶段 AI 只返回 `node_id/source_ids`，正文由程序按原方案段编号拼接真实原文。
- 已还原节点首轮生成替换还原正文，不追加正文，完成后设置 `optimized = true`。
- 字数扩充阶段保持现有逻辑，不额外注入原方案。
- 已还原节点在补目录上下文中标记 `locked-restored`，不允许作为新增目录父节点。
- 替换原方案后从 Step03 起全部失效：清空目录、全局事实、正文、正文编排/还原状态、runtime 和相关任务，但保留招标文件、Step02 解析结果和参考知识库选择。
- Analytics 子步骤上报使用 `${workflowKind}/${state.step}`，Dashboard 必须为 `existing-plan-expansion/*` 补中文映射。
- “生成技术方案”和“已有方案扩写”直接切换时必须先提示用户；确认后只保留招标文件、已选标段、Step02 解析结果和参考知识库选择，清空原方案、目录、全局事实、正文、正文生成配置/计划/runtime 和 Step03-Step05 任务。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 构建时报 `enable_original_plan_coverage_audit` 不在 `ConfigUsagePayload` | 第一次 `npm run build` | 已同步 `client/src/shared/analytics/analytics.ts` 的配置使用埋点类型和布尔值归一化；重跑构建通过 |

### Validation
- `node --check electron\services\technicalPlanStore.cjs` 通过。
- `node --check electron\ipc\technicalPlanIpc.cjs` 通过。
- `node --check electron\preload.cjs` 通过。
- `node --check analytics\dashboard\public\src\pages\traffic.js` 通过。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- `git diff --check` 通过，仅有 LF/CRLF 提示。

## Current Task: 资源管理 D1/R2 与客户端资源下载

### Goal
在 `analytics/` 增加全局资源管理能力：Dashboard 通过 D1+R2 管理图片、标题、标签、介绍和 Markdown 弹窗内容；Worker 提供公开资源读取与图片代理接口；`client/` 资源下载页从 Analytics 接口读取资源，支持搜索，图片为空时使用现有彩色书籍封面占位。

### Phases
- [completed] 1. 新增 D1/R2 自动化创建脚本、D1 migration，并接入 Worker 部署前 setup。
- [completed] 2. 新增 Analytics Worker 资源存储服务、公开资源接口、后台管理接口和 R2 图片代理。
- [completed] 3. 新增 Analytics Dashboard “资源管理” Tab，支持表格展示、编辑表单、图片上传/清空和删除。
- [completed] 4. 改造 Client 资源下载页：搜索框、接口读取、图片/默认封面展示、Markdown 弹窗内容。
- [completed] 5. 运行语法检查、Dashboard 脚本检查和客户端构建验证。
- [completed] 6. 将 Client 资源真实图片改为完整缩放显示，并完成构建与 diff 检查。

### Decisions
- R2 真实 bucket 名使用小写 `openbidkit`，展示名仍叫 `OpenBidKit`。
- 资源全局只有一套，不按 `projectName` 隔离。
- 弹窗内容按 Markdown 渲染，客户端必须 `allowRawHtml={false}`。
- 客户端公开读取接口不需要 `ADMIN_TOKEN`；Dashboard 管理接口继续复用 `ADMIN_TOKEN`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 无 | 本轮实现 | Analytics Worker/脚本/Dashboard `node --check`、`cd client; npm run build`、`git diff --check` 通过；构建仅有既有 chunk 体积警告，diff check 仅 LF/CRLF 提示 |

## Current Task: Step03 目录排序与局部正文保留

### Goal
技术方案 Step03 支持同级目录拖拽排序；排序只在前端重排，点击保存后再写 SQLite。目录保存改为按操作意图局部处理正文：排序不清空正文；编辑/删除只清空涉及节点；新增子目录只清空变为非叶子的父节点正文；任何目录操作不再清空全局事实。

### Phases
- [completed] 1. 调整 `saveOutline()` 保存语义和类型，支持 `reason/idMap/affectedNodeIds`。
- [completed] 2. Main 侧按映射迁移正文、正文状态和正文规划，保留全局事实。
- [completed] 3. Step03 实现排序状态、同级拖拽、本地草稿、保存排序和未保存离开确认。
- [completed] 4. 接入技术方案内部步骤切换和左侧主菜单切换守卫。
- [completed] 5. 同步样式，运行 CJS 检查和客户端构建。

### Decisions
- 不新增 IPC 通道，继续使用 `technical-plan:save-outline`。
- `saveOutline()` 入参改为对象形式，包含 `outlineData/reason/idMap/affectedNodeIds`。
- 排序必须传 `oldId -> newId` 映射，避免章节编号作为主键时正文串章。
- 目录重新生成仍清空正文和正文缓存，但不清空全局事实。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 删除目录编号复用可能误迁移旧子树正文 | 复核保存映射逻辑 | 删除时传入被删除子树全部旧 ID，Main 侧只按旧 ID 判断清空，避免旧 `2` 变新 `1` 时被误清空或旧 `1` 正文误挂载 |

## Current Task: 多模块开发者模式文件日志

### Goal
将开发者模式文件日志扩展到标书查重、废标项检查、文件解析和 Word 导出等模块，统一写入 `userData/logs/<module>/` 的 JSONL 文件；日志用于定位程序执行细节，不写 SQLite，不改变业务流程。

### Phases
- [completed] 1. 抽取通用开发者 JSONL 日志工具，统一路径、文件名、UTF-8 写入和 no-op 行为。
- [completed] 2. 接入文件解析链路，记录解析方式、文件类型、转换后端、耗时、输出 Markdown 指标和错误。
- [completed] 3. 接入标书查重链路，记录整轮分析、元数据/目录/正文/图片分析关键统计和错误。
- [completed] 4. 接入废标项检查链路，记录解析、废标项检查、错别字、逻辑谬误检查的输入规模、结果统计和错误。
- [completed] 5. 接入 Word 导出链路，记录导出章节、图片/Mermaid 处理、warnings 和结果。
- [completed] 6. 运行 CJS 语法检查、客户端构建和 diff 检查。

### Decisions
- 继续只在 `developer_mode` 开启时写文件。
- 每个模块写入独立目录：`logs/file-parser/`、`logs/duplicate-check/`、`logs/rejection-check/`、`logs/export/`。
- JSONL 只记录执行指标、hash、计数、错误，不记录 API Key、Token 等敏感配置。
- 不增加重试、fallback 或改变任务结果，只增加可观测性。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 无 | 本轮实现 | 相关 CJS `node --check`、`npm run build`、`git diff --check` 通过；构建仅有既有 chunk 体积警告，diff check 仅 LF/CRLF 提示 |

## Current Task: 技术方案开发者模式文件日志

### Goal
在开发者模式开启时，为技术方案正文生成链路增加类似 AI 日志的文件型调试日志，写入 `userData/logs/technical-plan/`，重点覆盖正文生成、一致性审计和一致性修复的程序执行细节；不改变现有业务逻辑，不把详细调试日志写入 SQLite。

### Phases
- [completed] 1. 记录现有日志边界，确认 SQLite 只保留任务状态/界面日志，详细调试日志应进入 `logs/technical-plan/`。
- [completed] 2. 新增开发者模式文件日志工具或 AI service 写入入口，统一 JSONL 输出、脱敏和 Windows UTF-8 写入。
- [completed] 3. 接入 `contentGenerationTask.cjs`，记录正文生成任务阶段、一致性审计 conflicts、一致性修复 patches、匹配/应用/保存结果。
- [completed] 4. 运行 CJS 语法检查、客户端构建和必要 diff 检查。

### Decisions
- 只在 `developer_mode` 开启时写文件日志。
- 文件日志放在 `userData/logs/technical-plan/`，不进入 SQLite。
- 不改变 AI prompt、修复判断规则、失败处理策略和 UI 任务日志。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 无 | 本轮实现 | `node --check`、`npm run build` 和 `git diff --check` 通过，diff check 仅 LF/CRLF 提示 |

## Current Task: Step05 全文一致性审计

### Goal
在技术方案 Step05 正文生成中新增可选“全文一致性审计”：默认开启，正文扩写完成后、配图前按目录顺序分组审计正文与 Step04 全局事实/Step02 关键解析项是否冲突；发现冲突后按小节并发执行 opencode 风格的 `old_text/new_text` 精确唯一局部替换修复，单章重新生成也执行同范围审计。

### Phases
- [completed] 1. 扩展正文生成配置、任务 stats 类型、前端配置开关、payload 和配置使用埋点。
- [completed] 2. 新增审计分组、审计 prompt、审计 JSON 归一化和修复 prompt。
- [completed] 3. 新增 `old_text/new_text` 精确唯一替换算法，行号辅助定位，找不到或多处命中时拒绝修改并重试。
- [completed] 4. 将审计/修复插入最低字数补足之后、配图之前，并覆盖单章重新生成。
- [completed] 5. 更新中断恢复阶段识别 `auditing`，运行 CJS 语法检查和客户端构建。
- [completed] 6. 运行最终 `git diff --check`。

### Decisions
- 审计默认开启；暂停状态下保持现有规则，只允许改正文生成并发速度。
- 分组阈值按正文内容 30 万字计算，目录编号/标题只进入 prompt，不参与总字数计算。
- 审计失败或修复失败不让正文任务整体失败；失败小节只记录日志，后续仍进入配图。
- 修复阶段不做模糊匹配、不做 replaceAll、不按相似度猜测；`old_text` 必须在当前小节唯一命中。
- 修复后若全文低于最低字数，会补足一次并再做一次一致性复审，避免死循环。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 配置弹窗首次补丁上下文不匹配 | 插入“全文一致性审计”开关 | 重新读取配置片段后用更小范围补丁插入 |

## Current Task: Step05 正文编排事实选择改造

### Goal
改造技术方案 Step05 正文生成：编排阶段额外读取 Step02 项目信息、甲方信息、交货和服务要求，并只传 Step04 全局事实标题，要求 AI 判断当前小节正文会用到哪些事实；正文生成、单章重新生成和扩写阶段再按编排结果传入所需事实的标题和详情，保证事实口径统一。

### Phases
- [completed] 1. 扩展正文编排结果结构，新增 `facts.titles` 并同步 Renderer 类型。
- [completed] 2. 编排 prompt 增加 Step02 三项关键解析结果和 Step04 全局事实标题清单。
- [completed] 3. 正文生成按 `facts.titles` 解析事实标题+内容详情并注入 prompt；旧编排缓存缺少 facts 时视为需要重新编排。
- [completed] 4. 单章重新生成、正文扩写和 Mermaid 修复按当前章节编排结果注入选中事实详情。
- [completed] 5. 运行 `node --check`、`npm run build` 和 `git diff --check`。

### Decisions
- 编排阶段只暴露全局事实标题，不暴露事实内容，避免编排请求携带过多大文本。
- 正文生成和扩写阶段只传当前章节编排选中的事实详情，不再整包注入全部全局事实。
- 旧 `contentGenerationPlans` 若没有 `facts` 字段，则在新流程中不复用，单章重新生成会重新编排目标章节。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: Step04 全局事实设定

### Goal
在技术方案 Step03 目录生成后新增 Step04“全局事实设定”，自动基于招标文件 Markdown、已生成目录和选中知识库完整条目生成全文一致性事实；支持用户编辑；只有全局事实完成后才能进入后续正文生成，并将事实注入后续正文编排/生成/扩写，减少全文逻辑冲突。

### Phases
- [completed] 1. 扩展技术方案步骤、类型、SQLite schema、Store 和 IPC/preload 基础能力。
- [completed] 2. 新增 Main 侧全局事实两轮 AI 后台任务及任务组接入。
- [completed] 3. 新增 Step04 Renderer 页面，支持自动启动、左侧大项进度、右侧 Markdown 编辑/预览/保存/重解析。
- [completed] 4. 将全局事实注入正文编排、正文生成、补目录、正文扩写和 Mermaid 修复等后续任务，并补 Main 侧前置校验。
- [completed] 5. 更新样式、SQL 说明和步骤序号，运行 CJS 语法检查与客户端构建。

### Decisions
- Step04 使用独立 SQLite 表 `technical_plan_global_fact_groups`，按大项保存 Markdown 内容，便于左侧大项列表和右侧编辑。
- 全局事实 AI 任务两轮执行：第一轮生成完整大项和内容，第二轮只返回补充 patch，程序按目标大项合并。
- 进入 Step04 内容为空时自动启动；失败后不自动无限重试，由页面提供重新解析。
- 目录重新生成或招标解析强制重跑会清空全局事实和后续正文缓存。
- 用户保存编辑后的全局事实会清空后续正文缓存，避免旧正文继续引用旧事实。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `taskService.cjs` 首次补丁只落了启动入口和事件字段，缺少 runner 导入和任务定义 | 第一次任务服务接入补丁 | 改用小范围精确补丁补上 `runGlobalFactsTask` 导入、`global-facts-generation` 定义和正文任务 Step 05 |

## Current Task: 技术方案 SQLite 存储改造

### Goal
按 `client/doc/sqlite改造方案.md` 落地技术方案模块 SQLite 改造：招标文件 Markdown 文件化，结构化状态进入 `workspace/yibiao.sqlite`，移除技术方案旧 JSON workspace 链路，不兼容旧 `technical_plan.json`，并完成构建验证。

### Phases
- [completed] 1. 建立 SQLite 基础设施、schema migration、路径和技术方案 Store。
- [completed] 2. 新增技术方案 IPC/preload/types，并接入 Main 初始化。
- [completed] 3. 改造 Renderer 技术方案状态、导入 Markdown、步骤与配置保存链路。
- [completed] 4. 改造 Step02/Step03/Step04 后台任务，改为通过 technicalPlanStore 局部读写。
- [completed] 5. 清理旧技术方案 workspace API 和 fileContent/fileName 状态引用。
- [completed] 6. 运行 CJS 语法检查、客户端构建和必要 smoke test。

### Decisions
- 不兼容旧 `technical_plan.json`，不读取、不迁移、不 fallback。
- 招标文件 Markdown 保存为 `workspace/technical-plan/tender.md`，SQLite 只存路径和元数据。
- 技术方案不再使用 `window.yibiao.workspace.*TechnicalPlan`，改为 `window.yibiao.technicalPlan`。
- 后台任务不再从 Renderer 接收大文本或完整目录；Main 侧从 SQLite 和 `.md` 文件读取权威输入。
- 根目录 `sql/workspace_schema.sql` 是工作区 SQLite 开源说明文件；运行时建表升级以代码 migration 为准。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| SQLite 冒烟测试首次 `node -e` 报 `Unexpected end of input` | 第一次冒烟测试 | Windows `cmd` 引号嵌套错误导致脚本被截断；改成单层 `node -e "..."` 后通过 |
| `npm audit` 仍报 3 个漏洞 | 依赖审计 | 记录为当前依赖审计结果，未按本轮任务自动执行 `npm audit fix` |
| Electron 启动后 `config:load` 没有注册 handler | 用户反馈后复现 | `better-sqlite3` 按 Node ABI 137 编译，而 Electron 41 需要 ABI 145，SQLite 初始化在 IPC 注册前抛错；新增 `postinstall: electron-builder install-app-deps` 并重建 native 依赖，同时让基础 IPC 先注册、SQLite 初始化失败时只影响技术方案/任务接口 |

## Current Task: Step04 正文生成暂停与继续

### Goal
给技术方案 Step04 正文生成增加协作式暂停/继续：点击暂停后立即进入“正在暂停中”，不强制中断已发出的 AI 请求；当前并发请求结束后落盘为 paused，允许导出已完成部分；点击继续后从 workspace 中的正文、编排、最低字数扩写和配图进度继续，避免重复扩写或重复配图。

### Phases
- [completed] 1. 扩展后台任务状态、IPC/preload/types，支持 `pausing` / `paused` 和暂停请求。
- [completed] 2. 改造 `contentGenerationTask.cjs`，实现安全检查点、协作式暂停和 resume 恢复。
- [completed] 3. 持久化正文任务 runtime，覆盖扩写轮次、已尝试小节、本轮触达小节和配图恢复。
- [completed] 4. 改造 Step04 前端按钮和导出禁用条件，显示“暂停/正在暂停中/继续”。
- [completed] 5. 运行语法检查、暂停/继续 smoke test、客户端构建和 diff 检查。

### Decisions
- 暂停不取消任何正在执行的 AI 请求，只阻止调度下一批编排、正文生成、补目录、扩写或配图。
- `pausing` 期间仍视为任务占用中，导出禁用；`paused` 允许导出当前已生成内容。
- 继续使用 `startContentGeneration({ resume: true })`，不弹配置窗口，沿用 workspace 中的 `contentGenerationOptions` 和暂停 runtime。
- 扩写恢复需要稳定顺序和已尝试小节集合，不能依赖内存中的 `expansionOffset`。
- 配图恢复以本轮 `touchedItemIds` + 现有幂等检测为准，避免 paused/resume 后重复追加图片或 Mermaid。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| resume 后立即 error：没有可继续的已暂停正文生成任务 | 第一次暂停/继续 smoke test | `taskService` 启动新任务前会先把 workspace 任务写成 running，runner 再读取 workspace 时看不到 paused；改为把启动前 workspace 快照传给 runner，resume 用该快照校验和恢复 |
| 扩写暂停 smoke test 中左右小节也在首次暂停前被扩写 | 第一次扩写恢复 smoke test | 新 runtime 批次选择按并发数取了首批多个候选，破坏原“首批只扩写中位数”规则；改为当前扩写轮 attempted 为空时 batch size 固定为 1 |
| 软件重启后扩写中任务显示成编排中 | 用户复现 | 任务阶段更新只广播未落盘，重启后 workspace 保留初始 planning；改为 `updateTask()` 同步持久化任务快照，并在 `getActiveTasks()` 中把无 active task 的 running/pausing 正文任务恢复为 paused + 推断 phase |

## Current Task: Step04 最低字数控制

### Goal
在技术方案 Step04 正文生成中实现最低字数配置：默认 0 不限制；生成后不足时按设计先补目录或直接扩写，扩写不设硬上限直到达标；补目录允许新增二/三/四级目录并在旧叶子变非叶子时返还表格、AI 图、Mermaid 图等编排额度；配图必须在最低字数达标后执行。

### Phases
- [completed] 1. 梳理当前 Step04 生成链路并建立实现计划。
- [completed] 2. 新增统一字数统计工具，接入 Renderer 总字数展示和 Main 判断。
- [completed] 3. 扩展 `ContentGenerationOptions`、任务 stats 类型和正文生成配置 UI。
- [completed] 4. 改造 `contentGenerationTask.cjs`：补目录、生成新增叶子、无限扩写、额度返还、阶段进度。
- [completed] 5. 运行 CJS 语法检查、客户端构建和必要 smoke test。
- [completed] 6. 按最新反馈完善 `client/doc/字数控制.md`，明确补目录/扩写阶段不配图，最低字数达标后统一配图。
- [completed] 7. 修正最终配图目标，进入图片阶段时按当前有效且正文成功的全部叶子统一汇总。
- [completed] 8. 修正补字数批次顺序，首批只扩写中位数节点，后续按左右两端成对扩写。
- [completed] 9. 增强补目录 JSON 严格校验和合并后完整目录校验。
- [completed] 10. 运行 CJS 语法检查、针对性 smoke test、客户端构建和 diff 检查。

### Decisions
- Renderer 只负责配置、启动和展示，最低字数补足全流程放在 Main 后台任务中。
- 最低字数为 `0` 时保持现有生成行为，不额外消耗 AI 请求。
- 补字数不设置硬上限；如果可选节点耗尽，允许重新从成功叶子中循环选择并继续扩写。
- 补目录最多 3 轮，最终达标责任交给补字数阶段。
- 尽量保留既有节点 ID；新增节点由程序分配不冲突 ID，旧叶子变非叶子时清空正文和编排计划并返还额度。
- 补目录 JSON 顶层只接受 `additions`；如果同时返回合法新增目录和 `outline`、正文、图片、表格、编排计划等非法字段，也必须触发 JSON 修复。
- 最终配图目标不再按本轮生成/扩写 ID 过滤，统一使用当前有效且 `status: success` 的叶子节点。
- 补字数选择顺序固定为首批中位数，第二批起按中位数左右偏移成对选择；可选节点耗尽后重新回到中位数。
- 最终配图目标改为本次任务实际生成、补目录生成或扩写过的成功叶子；历史成功但本次未触达的小节不重新配图。
- `minimumWords = 0` 不使用单独流程；进入最低字数检查后通过 `currentWords >= minimumWords` 自然跳过补目录/扩写。
- 配图阶段对正文中已有图片或 Mermaid 图的小节做幂等跳过，避免重复追加配图。
- 补字数不设置固定次数上限；完整覆盖一轮可选成功叶子后如果总字数没有增长，则结束扩写并报错，避免无限消耗 AI 请求。
- 扩写 JSON 必须保留原始 `operation` 并只允许 `insert` / `replace`；非法操作应触发 JSON 修复，不能默认当作 `insert`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 补目录 smoke test 访问 `children[0]` 报错 | 第一次补目录 smoke test | 测试初始正文过长，未触发补目录；改为按 stream 调用次数返回短初稿/长新增正文后通过 |
| 扩写顺序 smoke test 首次解析到根目录 `1` | 第一次扩写顺序 smoke test | 测试脚本从章节路径取了第一个 ID；改为取路径最后一段后通过 |
| 首次全文配图 smoke test 两个标题都解析成 `B Pic` | 第一次首次全文配图 smoke test | 测试脚本从 prompt 提取章节 ID 不可靠；改为按编排调用序号返回不同标题后通过 |
| 无增长保护 smoke test 扩写请求计数为 6 | 第一次无增长保护 smoke test | 测试最低字数过高导致先触发 3 轮补目录，计数混入补目录请求；改为直接进入扩写区间后通过 |
| 无 | 扩写非法 operation smoke test | `delete` 被 validator 拒绝，未追加非法 content，随后由无增长保护结束任务 |

## Current Task: 后台任务组锁与技术方案清空策略

### Goal
按 `client/开发说明.md` 新增的任务组规则落地当前已有后台任务：技术方案组内任务互斥，Step02/Step03/Step04 重新生成时由 Main 侧统一清空当前及后续缓存，避免下游 active task 与上游重跑交叉写入工作区。

### Phases
- [completed] 1. 梳理 `taskService`、技术方案任务和当前前端清空点。
- [completed] 2. 在 `taskService.cjs` 建立任务定义、任务组锁检查和冲突提示。
- [completed] 3. 将技术方案 Step02 全量重跑清空收敛到 Main 侧，并移除 Renderer 启动前业务清空。
- [completed] 4. 为 Step03/Step04 启动补齐后续缓存清空规则。
- [completed] 5. 运行 Main 语法检查与客户端构建验证。

### Decisions
- 先落地 `taskService` 内已有 `technical-plan` 与 `rejection-check` 任务；知识库、标书查重保留现有服务结构，后续再迁移统一事件体系。
- `technical-plan` 使用 `group-exclusive`，同组不同任务运行中直接拒绝启动；同类型运行中保持返回已有任务。
- 清空动作只在 Main 侧任务 runner 开始后执行，Renderer 不再在 IPC 确认前清空持久化业务数据。
- Step03 目录生成启动时由 `taskService` 初始状态清空旧 `outlineData` 和 Step04 缓存；Step04 全文重跑继续由 `contentGenerationTask.cjs` 在 Main 侧清空正文内容和章节缓存。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 标书查重迁入任务组体系

### Goal
将标书查重整轮分析纳入 `taskService` 的 `duplicate-check` 任务组，保留元数据、目录、正文、图片四个子流程的内部并发，统一由任务组负责启动、锁定、active task 和任务事件回放。

### Phases
- [completed] 1. 扩展 `taskService` 支持 `duplicateCheck` stateKey 和 `duplicate-analysis` 任务定义。
- [completed] 2. 改造 `duplicateCheckService`，新增 `runAnalysisTask()` 作为 taskService runner，保留内部子任务并发。
- [completed] 3. 同步 IPC、preload、共享类型和 `DuplicateCheckPage` 订阅逻辑，改为走 `tasks:event`。
- [completed] 4. 运行 CJS 语法检查、客户端构建、模块加载和任务注册 smoke test。

### Decisions
- `duplicate-check` 使用 `group-exclusive`，整轮分析对外是一个 `duplicate-analysis` 任务。
- `metadataAnalysis`、`outlineAnalysis`、`contentAnalysis`、`imageAnalysis` 继续作为业务子状态存在，不拆成四个独立 task。
- 保留旧 `duplicate-check:start-metadata-analysis` IPC 兼容入口，但内部优先转发到 `taskService.startDuplicateAnalysis()`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| `DuplicateCheckTaskState` 未从 `shared/types/index.ts` 导出导致构建失败 | 第一次 `npm run build` | 在共享类型入口补导出后重跑构建通过 |

## Current Task: DOC/WPS 本地转换后端自动识别

### Goal
让上传 `.doc` / `.wps` 时不再只依赖 LibreOffice；在 Windows 桌面端自动尝试 WPS、Microsoft Word 和 LibreOffice，哪个能成功转换为 `.docx` 就使用哪个，并保持后续 Markdown 解析链路不变。

### Phases
- [completed] 1. 梳理当前 legacy Word 转换入口和错误提示边界。
- [completed] 2. 在 `doc2markdown/convert.mjs` 中实现多后端候选转换：LibreOffice CLI + Windows WPS/Word COM。
- [completed] 3. 更新 Main/Renderer 缺失提示文案，避免继续只提示安装 LibreOffice。
- [completed] 4. 运行语法检查、客户端构建和 diff 检查。

### Decisions
- 保留当前 `.doc/.wps -> .docx -> mammoth -> Markdown` 主链路，只替换前置转换后端选择。
- 自动识别以实际转换成功并产出 `.docx` 为准，不只依赖 exe 路径或注册表存在。
- WPS/Word COM 仅在 Windows 启用；其他平台继续走 LibreOffice。
- 不新增依赖，Windows COM 转换通过系统 PowerShell 调用 `New-Object -ComObject`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| planning skill 示例路径 `~/.opencode/.../session-catchup.py` 不存在 | 第一次 catchup | 改用实际路径 `~/.config/opencode/.../session-catchup.py` |
| 无真实 `.doc/.wps` 样本可用于端到端转换验证 | 本轮验证 | 完成语法、模块导入和构建验证；实际转换需在安装 WPS/Word/LibreOffice 的桌面环境用真实文件复验 |

## Current Task: 废标项检查流式检查与单项重试

### Goal
将废标项检查 Step03 的废标项、错别字、逻辑谬误三类 Main 侧 AI 主请求改为后端到 AI 服务商的流式请求，并支持某一类检查失败后只重试该类任务。

### Phases
- [completed] 1. 将流式 JSON 使用方式和 JSON 修复边界写入 `client/开发说明.md`。
- [completed] 2. 复用现有 `streamChat` 与 JSON 修复链路改造 Main 侧三类检查。
- [completed] 3. 改造 Step03 页面，错误态提供单项重试按钮且不覆盖其他结果。
- [completed] 4. 运行 CJS 语法检查、客户端构建和 diff 检查。
- [completed] 5. 修复小米模型返回 `1\.` 等非法 JSON 转义导致逻辑谬误结果解析失败的问题。

### Decisions
- 不新增 Main 到 Renderer 的流式返回能力；Renderer 仍只订阅后台任务事件和 workspace 快照。
- 主请求使用 `streamChat()`，JSON 修复继续复用非流式修复链路，因为修复输入是短 JSON/近似 JSON。
- `checkOptions` 保留 UI 配置含义，新增本次执行选项控制单项重试。
- 流式 chunk 接收过程不写入 workspace；后台任务事件只同步结果和任务状态，不覆盖用户当前查看的 Tab。
- JSON 解析仍优先使用原始模型输出；只有原始候选解析失败后才尝试修复字符串内部非法反斜杠转义，避免改变正常 JSON 语义。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

## Current Task: 废标项检查三类并发检查

### Goal
在 `client/` 废标项检查 Step03 中实现“废标项检查、错别字检查、逻辑谬误检查”三个任务并发执行；错别字结果必须通过本地算法校验并修正原文片段，逻辑谬误输出标题、原文/位置、原因和建议，三类结果都使用折叠列表展示。

### Phases
- [completed] 1. 扩展类型、工作区状态和归一化逻辑，支持三类独立检查结果。
- [completed] 2. 新增错别字与逻辑谬误 Prompt、AI 服务和错别字原文校验/修正算法。
- [completed] 3. 改造 Step03 页面：按配置并发启动三类任务，分别展示运行/成功/失败状态。
- [completed] 4. 实现错别字、逻辑谬误折叠列表 UI，错别字支持复制原文和删除。
- [completed] 5. 补充样式和移动端适配，运行构建与 diff 检查。

### Decisions
- 三个检查任务在 Renderer 层用 `Promise.allSettled()` 并发启动，单项失败只影响对应 Tab。
- 错别字和逻辑谬误只向 AI 提交投标文件原文和检查要求，不提交招标文件或 Step02 废标项解析结果。
- 错别字必须通过本地 `bidContent` 定位校验；无法在原文中定位的候选丢弃，原文片段由程序从真实位置截取。
- 结果详情中的 AI 输出仍通过 `MarkdownRenderer allowRawHtml={false}` 渲染。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

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
## Current Task: 废标项检查 Step03 结果与三轮 AI 检查

### Goal
实现 `client/src/features/rejection-check` 的 Step03“废标项检查”：基于 Step02 无效/废标项解析、自定义检查项和单份投标文件原文，执行三轮 AI 检查，并用可展开、可删除的结果列表展示风险项。

### Phases
- [completed] 1. 扩展废标项检查类型、结果状态和工作区持久化字段。
- [completed] 2. 实现 Step03 三轮纯 user prompt 和 AI 服务编排。
- [completed] 3. 接入页面开始/重新检查、运行态、持久化、删除和单项展开逻辑。
- [completed] 4. 补充结果列表样式和移动端适配。
- [completed] 5. 运行构建与差异检查验证。

### Decisions
- Step03 新检查逻辑不使用 `system` role；三轮请求均为多组 `user` messages。
- 为避免 JSON 修复链路引入系统提示词，Step03 使用 `aiClient.chat()` 搭配 `response_format: { type: 'json_object' }`，再在 Renderer service 中手动解析和规范化结果。
- 只实现 `废标项检查` Tab 的实际内容；`错别字检查`、`逻辑谬误检查` 暂保留占位。
- AI 检查仅覆盖电子投标文件中可判断的缺失、冲突、未响应和材料风险；排除签字、盖章、密封、纸质正副本、现场递交等纸质/线下事项。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

### Validation
- `cd client && npm run build` 通过；仅有既有 chunk 体积警告。
- `git diff --check` 通过；仅有 Git LF/CRLF 提示。

## Current Task: 标书查重与废标项检查 SQLite v2 改造

### Goal
将标书查重和废标项检查从旧 `workspace/*.json` 整包缓存迁入 `workspace/yibiao.sqlite` v2；Markdown 大文本文件化；不迁移、不读取旧 JSON；Renderer 改为功能专用 bridge API，后台任务从 Main Store 读取权威输入。

### Phases
- [completed] 1. 扩展 `sqliteDatabase.cjs` 到 schema v2，并新增两个模块路径 helper。
- [completed] 2. 新增 `duplicateCheckStore.cjs`、`rejectionCheckStore.cjs` 和对应 IPC/preload/types。
- [completed] 3. 改造 `taskService.cjs`、`duplicateCheckService.cjs`、`rejectionCheckTask.cjs` 使用新 Store。
- [completed] 4. 改造 `DuplicateCheckPage.tsx`、`RejectionCheckPage.tsx`，移除旧 workspace JSON 读写和大文本任务 payload。
- [completed] 5. 删除旧 `workspaceStore.cjs` / `workspaceIpc.cjs`，更新开发说明和 SQLite 方案文档。
- [completed] 6. 完成 CJS 语法检查、Electron SQLite v2 Store 冒烟、客户端构建和依赖审计。

### Decisions
- 旧 `duplicate_check.json` / `rejection_check.json` 不迁移、不读取、不 fallback；升级后两个模块以空 SQLite 状态启动。
- SQLite runtime schema 版本升为 `PRAGMA user_version = 2`，与 `sql/workspace_schema.sql` 保持一致。
- 标书查重继续复用现有 runner 逻辑，但 `updateDuplicateCheck()` 由 Store 拆写 SQLite 表，不再写 JSON 文件。
- 废标项检查任务只从 Main Store 读取招标/投标 Markdown 和解析结果；Renderer 启动任务只传运行选项。
- 从技术方案导入废标项检查招标文件时，立即写入本模块 `rejection-check/tender.md` 快照；如果技术方案已有废标项解析结果，同步保存为本模块解析结果。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| SQLite Store 冒烟在普通 Node 下加载 `better-sqlite3` 失败，提示 Node ABI 137 与 Electron ABI 145 不匹配 | 第一次 SQLite 冒烟 | 这是当前 native 依赖为 Electron 重建后的预期状态；改用 Electron 运行时执行临时 smoke 脚本验证 v2 Store |
| 标书查重目录项 ID 在不同投标文件中重复，直接写入 `duplicate_check_outline_items.item_id` 会主键冲突 | 复查 `duplicateCheckStore.cjs` 目录保存链路 | Store 内部改用 `file_id::item_id` 作为 SQLite 主键，API 读回时还原原 ID；分组恢复按 `file_id` 精确标记，避免同名 ID 串到其他文件 |
| 方案复查发现标书查重文件重选未删除旧 Markdown/图片、content_hash 未落库，废标项任务仍保留大文本 payload fallback | 对照 SQLite v2 方案逐项搜索 | 补充清理 `duplicate-check/contents/` 和 `duplicate-check-content-*`，清空时删除整个 `duplicate-check/`，正文提取后写入 SHA256，移除废标项大文本 fallback，并删除未引用 Renderer 服务 |

### Validation
- `node --check` 通过：`sqliteDatabase.cjs`、`duplicateCheckStore.cjs`、`rejectionCheckStore.cjs`、`duplicateCheckService.cjs`、`rejectionCheckTask.cjs`、`taskService.cjs`、`preload.cjs`、`ipc/index.cjs`、`duplicateCheckIpc.cjs`、`rejectionCheckIpc.cjs`。
- Electron 运行时 SQLite v2 Store 冒烟通过：schemaVersion=2，标书查重元数据读回，废标项检查 Markdown 文件读回。
- Electron 运行时标书查重目录回归 smoke 通过：不同投标文件相同目录项 ID 可写入，父子关系读回保持原 API ID，未参与分组的同 ID 目录项不会被误标记。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- `cd client; npm audit` 仍报 3 个既有漏洞：2 moderate、1 high。
- `git diff --check` 仅有既有 LF/CRLF 提示。

## Current Task: 知识库 SQLite v3 文档设计

### Goal
先只更新文档、SQL 说明和开发说明，明确知识库从旧 `knowledge-base/index.json` 与每文档 JSON 文件迁入 `workspace/yibiao.sqlite` v3 的目标结构和用户确认迁移流程：用户升级后首次进入知识库，如检测到历史知识库数据，必须提示确认后自动迁移；迁移完成并校验后删除旧索引/结果 JSON，下次进入不再弹窗。

### Phases
- [completed] 1. 新增知识库 SQLite v3 独立设计文档。
- [completed] 2. 更新 `sql/workspace_schema.sql`，补充 knowledge_* v3 目标表结构。
- [completed] 3. 更新 `client/开发说明.md`，记录知识库存储边界、迁移弹窗和清理规则。
- [completed] 4. 更新既有 SQLite 文档中的知识库后续范围引用。
- [completed] 5. 运行文档差异检查并记录结果。

### Decisions
- 知识库是长期用户资产，不能像查重/废标项一样丢弃旧数据；必须显式提示并迁移。
- 迁移由用户进入知识库页面触发确认，不在应用启动时静默执行。
- 迁移成功后删除旧 `index.json` 和每文档旧结果 JSON；原始上传文件、`content.md`、导入图片资产和开发者日志不作为废弃历史数据删除。
- 本轮只改文档和 SQL 说明，不改运行代码；runtime migration 后续单独实施。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

### Validation
- `git diff --check` 覆盖本轮已跟踪文档/SQL/计划文件，通过且仅有 LF/CRLF 提示。
- 使用 Grep 搜索 `client/doc/*.md` 行尾空白，未发现匹配。

## Current Task: 知识库 SQLite v3 运行实现

### Goal
将知识库从旧 `knowledge-base/index.json` 与每文档结果 JSON 迁入 `workspace/yibiao.sqlite` v3；进入知识库页面时检测旧数据并提示用户确认迁移；迁移成功并校验后清理旧索引和结果 JSON，同时保留 `source.<ext>`、`content.md`、导入图片和开发者日志。

### Phases
- [completed] 1. 扩展 `sqliteDatabase.cjs` 到 schema v3，新增 `knowledge_*` runtime migration。
- [completed] 2. 新增 `knowledgeBaseStore.cjs`，实现知识库 CRUD、结构化结果读写、旧 JSON 迁移、校验和清理。
- [completed] 3. 改造 `knowledgeBaseService.cjs`，业务流程保留在 Service，持久化读写委托 Store。
- [completed] 4. 接入 IPC、preload、共享类型和知识库页面迁移确认流程。
- [completed] 5. 运行 CJS 语法检查、Electron 运行时迁移 smoke、客户端构建和 diff 检查。
- [completed] 6. 按方案复查补齐迁移关键结果数校验、stale running 恢复和迁移期间操作禁用。

### Decisions
- 知识库 SQLite v3 与技术方案、标书查重、废标项检查共用 `workspace/yibiao.sqlite`。
- 旧知识库必须迁移，不做升级后空置；迁移只在用户进入知识库页面并确认后执行。
- 迁移确认弹窗必须明确提示：只迁移旧版 `status = success` 的已完成文档，未完成或处理中的文档会被丢弃且不会迁移到新版本知识库。
- 迁移清理只删除旧 `index.json` 和每文档结果 JSON，不删除原始上传文件、Markdown 原文、导入图片和开发者日志。
- 知识库暂不接入统一 `taskService.cjs`，仍由 `knowledgeBaseService.cjs` 按 `documentId` 管理准备和匹配互斥。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| Electron 迁移 smoke 报 `ReferenceError: markdown_hash is not defined` | 第一次知识库 v3 迁移 smoke | `insertOrUpdateDocument()` 中对象参数误用蛇形变量名；改为显式映射 `markdown_hash: markdownHash` 和 `markdown_chars: markdownChars` 后 smoke 通过 |
| 复查发现旧 `index.json` 解析失败不会写入迁移错误状态，且迁移校验只查文档 | 迁移事务复查 | 将旧索引读取和解析纳入 `try/catch`，失败时写 `knowledge_migration_meta.status = error`；迁移后同时校验文件夹和文档存在 |
| 方案复查发现关键结果数未校验、迁移期间 UI 操作未全禁用、旧 running 状态不会恢复 | 对照 `client/doc/sqlite改造方案_知识库.md` 审查 | 迁移事务内补齐 block/条目/来源关系/报告等数量校验；页面增加 `migrationRunning` 统一禁用；Service 调 Store 恢复无 active 任务的处理中状态为 error |

### Validation
- `node --check` 通过：`electron/services/sqliteDatabase.cjs`、`electron/services/knowledgeBaseStore.cjs`、`electron/services/knowledgeBaseService.cjs`、`electron/ipc/knowledgeBaseIpc.cjs`、`electron/ipc/index.cjs`、`electron/preload.cjs`。
- Electron 运行时知识库 v3 迁移 smoke 通过：schemaVersion=3，旧 `index.json` 检测为需迁移，确认迁移后 SQLite 列表/条目/技术方案引用可读，旧结果 JSON 与 `index.json` 已删除，`content.md` 保留。
- Electron 运行时知识库 v3 回归 smoke 通过：迁移关键结果数校验失败时事务回滚、旧 `index.json` 和结果 JSON 保留、`knowledge_migration_meta.status = error`；无 active 任务的 `matching` 文档恢复为 `error`。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- `git diff --check` 通过，仅有 LF/CRLF 提示。

## Current Task: SQLite 改造后废弃代码清理

### Goal
仅清理已确认无引用、会误导后续开发的 Renderer 旧服务、占位 Prompt、未实现占位工具和旧错误工具；保留仍被开发者测试页或 Main 运行链路使用的代码。

### Phases
- [completed] 1. 搜索并确认废弃 Renderer 旧服务、占位 Prompt 和未实现 JSON 修复工具的引用边界。
- [completed] 2. 删除明确废弃文件并更新 `shared/prompts`、`shared/ai` 导出与开发说明。
- [completed] 3. 继续清理无引用的 `ClientNotImplementedError` / `getErrorMessage()` 旧占位工具文件。
- [completed] 4. 重新搜索残留引用，确认仅剩 Main 侧真实实现函数命中。
- [completed] 5. 运行客户端构建和 diff 检查。

### Decisions
- 保留 `outlineWorkflow.ts` 和 `bidAnalysisWorkflow.ts`，因为仍被开发者测试页或现有页面使用。
- 保留 `jsonRepairPrompts.ts` 和 Main 侧 `repairJsonResponse()`，它们是当前 AI JSON 修复链路的真实实现，不属于已删的 `jsonRepair.ts` 占位工具。
- 删除 `client/src/shared/utils/errors.ts`，因为 `ClientNotImplementedError` 和 `getErrorMessage()` 均只在自身文件中出现。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

### Validation
- 残留搜索通过：`ClientNotImplementedError|getErrorMessage|NotImplemented|尚未实现` 在 `client/src` 无命中。
- 残留搜索通过：`contentWorkflow|duplicateCheckService.ts|knowledgeBaseService.ts|contentPrompts|duplicatePrompts|expandPrompts|jsonRepair.ts|buildDuplicateCheckMessages|buildExpandOutlineMessages|JsonRepairIssue` 在 `client` 无命中。
- `buildChapterContentMessages` 和 `repairJsonResponse` 的剩余命中均位于 Electron Main 真实运行实现。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。
- `git diff --check` 通过，仅有 LF/CRLF 提示。

## Current Task: 知识库迁移完成态过滤评审修复

### Goal
修复评审指出的旧知识库运行中状态迁移后首屏 stale running 问题，并按用户确认改为只迁移旧版 `status = success` 的已完成文档；未完成、处理中或未知状态文档在确认提示中明确告知会被丢弃且不会迁移到新版本知识库。

### Phases
- [completed] 1. 核查 `migrateLegacy()`、`list()` 和 `recoverInterruptedDocuments()` 调用链，确认评审有效。
- [completed] 2. 修改 `knowledgeBaseStore.migrateLegacy()`，只写入 success 文档并统计跳过数量。
- [completed] 3. 修改 `knowledgeBaseService.migrateLegacy()`，迁移后执行恢复并返回最新 `list()`。
- [completed] 4. 更新页面确认提示、迁移状态/结果类型和知识库迁移文档。
- [completed] 5. 运行 CJS 语法检查、Electron smoke、客户端构建和残留搜索。

### Decisions
- 旧知识库文件夹继续迁移；旧文档只有 `status = success` 才迁移。
- 非完成状态文档不写入 SQLite；迁移成功后旧 `index.json` 和旧结果 JSON 会清理，因此这些文档不会再出现在新版本知识库。
- 原始上传文件、`content.md`、导入图片和开发者日志仍按既有规则保留，不在迁移清理中删除。
- 页面确认框必须显示总文档数、已完成数量和未完成/处理中数量，并明确未完成或处理中文档会被丢弃。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |

### Validation
- `node --check electron\services\knowledgeBaseStore.cjs` 通过。
- `node --check electron\services\knowledgeBaseService.cjs` 通过。
- Electron 运行时 `knowledge-v3-smoke.cjs` 通过。
- Electron 运行时 `knowledge-v3-regression-smoke.cjs` 通过。
- Electron 运行时 `knowledge-v3-skip-smoke.cjs` 通过：3 个旧文档中只迁移 1 个 success，跳过 2 个非完成/未知状态文档，旧索引删除，跳过文档 `content.md` 保留。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。

## Current Task: 知识库迁移确认弹窗统一风格

### Goal
把知识库旧数据迁移确认从系统 `window.confirm` 替换为项目内 Radix Dialog，并重新排版长提示文案：明确当前版本不支持继续处理旧版知识库，提示用户如有未完成文档需回退旧版本解析为“已完成”后再更新，只迁移已完成文档并展示统计数量。

### Phases
- [completed] 1. 核查项目内 Dialog 组件和既有弹窗样式复用点。
- [completed] 2. 改造 `KnowledgeBasePage.tsx`，检测迁移后打开页面内 Dialog，不再调用迁移用 `window.confirm`。
- [completed] 3. 新增迁移弹窗结构：标题、旧版不再支持处理提示、迁移规则警告、旧文档统计、开始/暂不迁移按钮。
- [completed] 4. 新增 `.knowledge-migration-*` 样式和移动端单列布局。
- [completed] 5. 更新开发说明和知识库 SQLite 方案文档。
- [completed] 6. 运行 CJS 语法检查、客户端构建和 diff 检查。

### Decisions
- 迁移确认使用 `@radix-ui/react-dialog` 和既有 `.content-regenerate-modal` 遮罩，按钮继续复用 `primary-action` / `secondary-action`。
- 迁移弹窗关闭或“暂不迁移”只暂缓本次迁移，下次进入知识库继续提示。
- 迁移执行中禁用关闭和按钮，避免中途误操作。
- 本轮只替换知识库迁移确认弹窗；知识库页删除/重命名的既有系统确认不是本次迁移流程。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| TypeScript 报迁移后读取结果可能为 `undefined` | 第一次 `npm run build` | 对 `result.index || knowledgeBase.list()` 的结果显式判空，失败时抛出可读错误 |

### Validation
- `node --check electron\services\knowledgeBaseStore.cjs` 通过。
- `node --check electron\services\knowledgeBaseService.cjs` 通过。
- `cd client; npm run build` 通过，仅有既有 chunk 体积警告。

## Current Task: client 开发说明精简整理

### Goal
按“快速理解架构、统一协作规范、组件复用和验证标准”的目标，精简 `client/开发说明.md`，删除偏功能实现流水账和过细记录，保留对开发人员与 AI 有长期指导价值的架构边界和约束。

### Phases
- [completed] 1. 复核当前开发说明中的过细实现记录和过期表述。
- [completed] 2. 重写文档结构，聚焦技术栈、架构边界、目录职责、Main/IPC/Store、数据存储、后台任务、UI、AI、埋点、发布和验证标准。
- [completed] 3. 保留近期关键协作约束：Main 后台任务、SQLite Store、大文本文件化、项目内 Dialog、Toast、埋点不可删、Electron native 验证。
- [completed] 4. 运行文档 diff 检查。

### Decisions
- 删除 preload API 全量清单，改为以 `src/shared/types/ipc.ts` 为 bridge 类型权威。
- 删除技术方案 Step04、发布细节等过细流水账，只保留可长期复用的原则和入口。
- 保留知识库迁移的核心协作规则，但把详细实现指向 `client/doc/sqlite改造方案_知识库.md`。

### Errors Encountered
| Error | Attempt | Resolution |
| --- | --- | --- |
| 首次覆盖文档的 patch 缺少结束标记 | 第一次 apply_patch | 重新提交完整 Delete/Add patch 后成功 |

### Validation
- `git diff --check -- client/开发说明.md` 通过，仅有 LF/CRLF 提示。
