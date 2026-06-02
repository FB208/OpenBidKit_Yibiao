# 技术方案 SQLite 改造方案

## 1. 改造目标

本次只改造 `client/` 中“技术方案”模块的本地数据存储，其他模块暂不迁移。

核心目标：

- 将技术方案从 `userData/workspace/technical_plan.json` 整包读写，改为 SQLite 结构化存储。
- 招标文件解析后的 Markdown 继续以 `.md` 文件保存，SQLite 只保存路径、hash、字符数、解析器等元数据。
- Renderer 不再长期持有或自动保存大文本状态，技术方案数据由 Electron Main 统一读写。
- 后台任务不再通过整包 `updateTechnicalPlan()` 反复读写完整 JSON，而是按任务、目录节点、小节、正文编排计划局部更新。
- 取消旧数据兼容，不迁移、不读取、不 fallback 到 `technical_plan.json`。
- 保持现有技术方案业务流程不变：上传招标文件、招标文件解析、目录生成、正文生成、扩写改写占位。

最终期望效果：

- 启动、切页、恢复技术方案状态时不再解析一个越来越大的 JSON 文件。
- 正文生成过程中，单个章节完成后只更新该章节和对应任务状态，不重写整份技术方案缓存。
- 目录编辑、添加、删除后，Main 侧事务清空旧正文内容、正文任务、正文编排缓存，避免旧正文污染新目录。
- `tasks:event` 不再高频广播完整大状态，尽量只广播任务状态和本次变化内容。
- 技术方案导入的招标文件 Markdown 可被页面按需读取，但不会进入全局 `TechnicalPlanState`。

## 2. 改造范围

本次纳入范围：

- 技术方案本地存储。
- 技术方案专用 IPC / preload API / TypeScript 类型。
- 技术方案上传招标文件、读取 Markdown、重置流程。
- 技术方案 Step02 招标文件解析任务。
- 技术方案 Step03 目录生成与目录人工编辑。
- 技术方案 Step04 正文生成、暂停、继续、单章节重新生成、手动保存正文。
- Word 导出读取当前页面状态的方式保持可用。

本次不纳入范围：

- 配置 `user_config.json`。
- 知识库存储，另见 `client/doc/sqlite改造方案_知识库.md`。
- 标书查重存储。
- 废标项检查存储。
- 旧 `technical_plan.json` 数据迁移。
- 原始 Word/PDF 文件长期保存。
- 图片文件存储方式重构。
- AI prompt、AI 生成策略、Word 导出版式重构。

其他模块如果后续需要复用技术方案中的招标文件 Markdown，应调用新的技术方案读取接口；本阶段不围绕其他模块做存储迁移设计。

## 3. 最终存储原则

大文本和结构化状态分离：

- 招标文件 Markdown：保存为 `userData/workspace/technical-plan/tender.md`。
- SQLite：保存技术方案结构化状态、任务状态、目录树、小节状态、正文编排计划和 Markdown 文件元数据。
- 生成图片、导入图片：继续保存到现有 `workspace/generated-images/`、`workspace/imported-images/`。
- SQLite 不保存图片 BLOB。
- SQLite 不保存原始 Word/PDF 文件。

权威来源：

- 招标文件正文以 `tender.md` 为权威来源。
- 目录结构以 `technical_plan_outline_nodes` 为权威来源。
- 正文内容以 `technical_plan_outline_nodes.content` 为权威来源。
- 小节生成状态以 `technical_plan_content_sections` 为权威来源。
- 正文编排计划以 `technical_plan_content_plans` 为权威来源。
- 后台任务状态以 `technical_plan_tasks` 为权威来源。

不再保留：

- `TechnicalPlanState.fileContent`。
- `TechnicalPlanState.fileName` 顶层字段。
- `workspace:load-technical-plan` 返回完整招标文件 Markdown。
- Renderer 侧 300ms 防抖保存完整 `TechnicalPlanState`。
- `tasks:startBidAnalysis({ fileContent })` 这类从 Renderer 传大文本给 Main 的调用方式。

## 4. 目标数据结构

### 4.1 文件路径

建议新增路径工具：

```text
userData/
  workspace/
    yibiao.sqlite
    technical-plan/
      tender.md
```

对应代码位置：

- `client/electron/utils/paths.cjs`

新增方法：

- `getWorkspaceDatabasePath(app)` -> `workspace/yibiao.sqlite`
- `getTechnicalPlanDir(app)` -> `workspace/technical-plan`
- `getTechnicalPlanTenderMarkdownPath(app)` -> `workspace/technical-plan/tender.md`

### 4.2 SQLite 表

建议使用一个工作区数据库 `workspace/yibiao.sqlite`，本次只创建 `technical_plan_*` 表，后续其他模块如果迁移再复用同一个数据库。

数据库初始化建议：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

版本管理建议：

```sql
PRAGMA user_version = 1;
```

完整结构说明文件：

- 在仓库根目录维护 `sql/workspace_schema.sql`，保存工作区 SQLite 最新完整数据结构；技术方案是其中的 `technical_plan_*` 部分。
- SQL 文件用于开源开发者理解、评审和排查问题，不作为用户运行时手动执行脚本。
- 运行时建表和升级以客户端代码中的 migration 为准。
- 每次表结构变化后，必须同步更新 `sql/workspace_schema.sql` 和 migration 版本。

### 4.3 自动初始化与升级策略

SQLite 文件和表结构由客户端自动管理，用户安装或升级客户端后不需要手动执行 SQL。

首次创建流程：

- Electron Main 初始化 SQLite 服务时，先创建 `userData/workspace/` 目录。
- 调用 `new Database(getWorkspaceDatabasePath(app))` 打开数据库；文件不存在时 SQLite 会自动创建空 DB 文件。
- 执行基础 PRAGMA：`journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`。
- 读取 `PRAGMA user_version`，首次创建时值为 `0`。
- 依次执行 migration `1` 到当前代码版本。
- 每个 migration 成功后，把 `PRAGMA user_version` 更新到对应版本。

升级流程：

- 用户升级客户端后，安装包不会覆盖 `userData/workspace/yibiao.sqlite`。
- 新版本客户端启动时读取当前 DB 的 `user_version`。
- 如果 DB 版本低于代码中的 `schemaVersion`，自动按顺序执行缺失 migration。
- 如果 DB 版本等于 `schemaVersion`，只执行 PRAGMA 和基本完整性检查，不重复建表。
- 如果 DB 版本高于当前代码版本，说明用户可能用过更高版本客户端，应阻止技术方案功能继续写入，并提示客户端版本过低。

建议 migration 代码形态：

```js
const schemaVersion = 1;

const migrations = [
  {
    version: 1,
    description: '创建技术方案 SQLite 初始表结构',
    up(db) {
      db.exec(`
        CREATE TABLE technical_plan_meta (...);
        CREATE TABLE technical_plan_tasks (...);
      `);
    },
  },
];
```

执行规则：

- migration 必须幂等地按版本顺序执行，但单个版本不要求重复执行。
- 每个 migration 必须放进事务。
- migration 中只做结构变化和必要的数据搬迁，不执行 AI 请求、文件解析、图片生成、Word 导出等耗时任务。
- migration 成功后再更新 `user_version`。
- migration 失败时停止初始化技术方案存储，不能继续用半升级的库写入业务数据。

升级前备份策略：

- 当 `user_version > 0` 且需要升级时，升级前先执行 SQLite checkpoint，确保 WAL 内容落入主库文件。
- 复制 `yibiao.sqlite` 为 `yibiao.sqlite.backup-YYYYMMDD-HHmmss`。
- 如果存在 `yibiao.sqlite-wal`、`yibiao.sqlite-shm`，也一起复制备份。
- 备份失败时不继续升级，提示数据库备份失败。
- 首次创建新库时不需要备份。

升级失败处理：

- 不删除原 DB。
- 不自动回滚到旧结构后继续写入。
- 技术方案功能提示“本地数据库升级失败，请备份数据后联系开发者”。
- 日志中记录当前版本、目标版本、失败 migration 版本和错误信息。

开发约束：

- 不要只依赖 `CREATE TABLE IF NOT EXISTS` 管理结构变化，它只能处理首次建表，不能可靠处理新增字段、拆表、索引变更和数据搬迁。
- 不允许直接修改历史 migration；已经发布的 migration 只能追加新版本修正。
- `sql/workspace_schema.sql` 始终表示最新完整结构，migration 表示从旧版本升级到新版本的过程。

#### technical_plan_meta

保存技术方案单例元数据。

```sql
CREATE TABLE technical_plan_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step TEXT NOT NULL DEFAULT 'document-analysis',
  tender_file_name TEXT,
  tender_markdown_path TEXT,
  tender_markdown_hash TEXT,
  tender_markdown_chars INTEGER NOT NULL DEFAULT 0,
  tender_parser_label TEXT,
  tender_imported_at TEXT,
  bid_analysis_mode TEXT NOT NULL DEFAULT 'key',
  outline_mode TEXT NOT NULL DEFAULT 'aligned',
  outline_project_name TEXT,
  outline_project_overview TEXT,
  content_generation_options_json TEXT,
  content_generation_runtime_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

说明：

- `projectOverview` 和 `techRequirements` 不作为独立权威字段保存，加载状态时从 `technical_plan_bid_items` 中的 `projectOverview`、`techRequirements` 派生。
- `bidAnalysisProgress` 不作为独立权威字段保存，加载状态时按当前 `bid_analysis_mode` 和解析项状态计算。

#### technical_plan_tasks

保存三类后台任务状态。

```sql
CREATE TABLE technical_plan_tasks (
  type TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  logs_json TEXT,
  stats_json TEXT,
  error TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

任务类型：

- `bid-analysis`
- `outline-generation`
- `content-generation`

#### technical_plan_bid_items

保存招标文件解析项。

```sql
CREATE TABLE technical_plan_bid_items (
  item_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  error TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
```

关键项：

- `projectOverview`
- `techRequirements`

加载 `TechnicalPlanState` 时：

- `projectOverview = technical_plan_bid_items.content where item_id = 'projectOverview' and status = 'success'`
- `techRequirements = technical_plan_bid_items.content where item_id = 'techRequirements' and status = 'success'`
- `bidAnalysisTasks` 由全部 `technical_plan_bid_items` 组装。

#### technical_plan_reference_docs

保存技术方案选择的参考知识库文档 ID。

```sql
CREATE TABLE technical_plan_reference_docs (
  document_id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

#### technical_plan_outline_nodes

保存目录树和正文内容。

```sql
CREATE TABLE technical_plan_outline_nodes (
  node_id TEXT PRIMARY KEY,
  parent_node_id TEXT,
  sort_order INTEGER NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_requirement_id TEXT,
  source_requirement_title TEXT,
  knowledge_item_ids_json TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX idx_technical_plan_outline_parent_order
ON technical_plan_outline_nodes(parent_node_id, sort_order);
```

说明：

- `node_id` 继续使用当前目录编号，例如 `1`、`1.1`、`1.1.1`。
- 目录编辑后需要重新编号时，在事务内删除并重写目录节点最简单可靠。
- 正文内容保存在 `content`，导出 Word 时仍组装成 `OutlineData.outline[*].content`。

#### technical_plan_content_sections

保存小节生成状态。

```sql
CREATE TABLE technical_plan_content_sections (
  node_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);
```

说明：

- 不重复保存正文内容。
- 加载 `contentGenerationSections` 时，从 `technical_plan_outline_nodes.content` 合并生成当前前端需要的 `content` 字段。

#### technical_plan_content_plans

保存正文编排计划。

```sql
CREATE TABLE technical_plan_content_plans (
  node_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL,
  illustration_type TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES technical_plan_outline_nodes(node_id) ON DELETE CASCADE
);
```

### 4.4 Renderer 目标状态

`TechnicalPlanState` 建议调整为：

```ts
export interface TechnicalPlanTenderFile {
  fileName: string;
  markdownPath: string;
  markdownChars: number;
  contentHash: string;
  parserLabel?: string;
  importedAt?: string;
  updatedAt: string;
}

export interface TechnicalPlanState {
  step: TechnicalPlanStep;
  tenderFile: TechnicalPlanTenderFile | null;
  projectOverview: string;
  techRequirements: string;
  bidAnalysisMode: BidAnalysisMode;
  bidAnalysisTasks: BidAnalysisTasks;
  bidAnalysisProgress: number;
  outlineMode: OutlineMode;
  referenceKnowledgeDocumentIds: string[];
  bidAnalysisTask?: BackgroundTaskState;
  outlineGenerationTask?: BackgroundTaskState;
  contentGenerationTask?: BackgroundTaskState;
  contentGenerationOptions?: ContentGenerationOptions;
  contentGenerationSections: ContentGenerationSections;
  contentGenerationPlans: ContentGenerationPlans;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  outlineData: OutlineData | null;
}
```

`DocumentAnalysisPage` 展示 Markdown 时单独维护 `tenderMarkdown` 本地 UI 状态，不进入 `TechnicalPlanState`。

## 5. IPC 与服务设计

### 5.1 新增 Main 侧服务

建议新增文件：

- `client/electron/services/sqliteDatabase.cjs`
- `client/electron/services/technicalPlanStore.cjs`

`sqliteDatabase.cjs` 职责：

- 打开 `workspace/yibiao.sqlite`。
- 初始化 PRAGMA。
- 读取 `PRAGMA user_version` 并执行自动 migration。
- 首次创建时自动建表，升级时自动补齐缺失结构。
- 升级前创建数据库备份，升级失败时阻止技术方案继续写入。
- 拒绝用低版本客户端写入高版本数据库。
- 暴露共享 DB 实例。
- 提供关闭钩子，应用退出前关闭 DB。

`technicalPlanStore.cjs` 职责：

- 导入招标文件并保存 `tender.md`。
- 读取招标文件 Markdown。
- 加载技术方案状态快照。
- 保存步骤、解析模式、目录模式、参考知识库、正文生成配置。
- 启动任务前执行清空规则。
- 任务执行过程中局部写入解析项、任务状态、目录节点、小节正文、编排计划、runtime。
- 重置技术方案，清空技术方案相关表和 `technical-plan/tender.md`。

### 5.2 新增 IPC

建议新增文件：

- `client/electron/ipc/technicalPlanIpc.cjs`

建议暴露到 `window.yibiao.technicalPlan`：

```ts
technicalPlan: {
  loadState: () => Promise<TechnicalPlanState>;
  importTenderDocument: () => Promise<{ state: TechnicalPlanState; markdown: string }>;
  readTenderMarkdown: () => Promise<string>;
  updateStep: (step: TechnicalPlanStep) => Promise<TechnicalPlanState>;
  saveOutlineConfig: (payload: { outlineMode: OutlineMode; referenceKnowledgeDocumentIds: string[] }) => Promise<TechnicalPlanState>;
  saveOutline: (outlineData: OutlineData) => Promise<TechnicalPlanState>;
  saveContentGenerationOptions: (options: ContentGenerationOptions) => Promise<TechnicalPlanState>;
  saveChapterContent: (payload: { nodeId: string; content: string }) => Promise<TechnicalPlanState>;
  clear: () => Promise<TechnicalPlanState>;
}
```

需要同步修改：

- `client/electron/preload.cjs`
- `client/src/shared/types/ipc.ts`
- `client/electron/ipc/index.cjs`

### 5.3 移除旧技术方案 workspace API

不再保留以下技术方案接口：

- `window.yibiao.workspace.loadTechnicalPlan`
- `window.yibiao.workspace.saveTechnicalPlan`
- `window.yibiao.workspace.updateTechnicalPlan`
- `window.yibiao.workspace.clearTechnicalPlan`

后续标书查重、废标项检查也已迁入 `duplicateCheckStore.cjs` / `rejectionCheckStore.cjs`，`workspaceStore.cjs` 不再作为有效工作区入口。

### 5.4 后台任务接口调整

`window.yibiao.tasks.startBidAnalysis()`：

- 旧：`{ mode, fileContent, task_ids, force_rerun }`
- 新：`{ mode, task_ids, force_rerun }`
- Main 侧从 `technicalPlanStore.readTenderMarkdown()` 读取当前招标文件 Markdown。

`window.yibiao.tasks.startOutlineGeneration()`：

- 旧：`{ overview, requirements, mode, reference_knowledge_document_ids }`
- 新：`{ mode, reference_knowledge_document_ids }`
- Main 侧从 `technical_plan_bid_items` 读取 `projectOverview`、`techRequirements`。

`window.yibiao.tasks.startContentGeneration()`：

- 旧：`{ outlineData, projectOverview, reference_knowledge_document_ids, regenerate, generationOptions, targetItemId, requirement }`
- 新：`{ regenerate, generationOptions, targetItemId, requirement }`
- Main 侧从 SQLite 读取目录、项目概述、参考知识库文档 ID、已有正文状态。

暂停接口保持：

- `window.yibiao.tasks.pauseContentGeneration()`

### 5.5 Task 事件调整

目标是不再高频发送完整 `TechnicalPlanState`。

建议技术方案任务事件结构：

```ts
interface TechnicalPlanTaskEvent {
  task: BackgroundTaskState;
  technicalPlanPatch?: Partial<TechnicalPlanState>;
  bidItem?: BidAnalysisTaskState;
  outlineData?: OutlineData;
  contentSection?: ContentGenerationSectionState;
  contentPlan?: ContentGenerationPlanState;
  contentRuntime?: ContentGenerationRuntimeState;
}
```

事件策略：

- 招标解析单项开始/成功/失败：发送 `bidItem`、`technicalPlanPatch.bidAnalysisProgress`、任务状态。
- 目录生成过程日志：只发送任务状态。
- 目录生成成功：发送完整 `outlineData`，并清空前端正文缓存。
- 正文生成过程日志：只发送任务状态、runtime 或 stats。
- 单个小节成功/失败：发送 `contentSection`，必要时发送该小节对应的 outline content。
- 补目录导致目录结构变化：发送完整 `outlineData`，并清空受影响小节缓存。
- 任务结束：发送任务状态和最终必要 patch。

## 6. 涉及功能及代码

### 6.1 Electron Main

新增：

- `electron/services/sqliteDatabase.cjs`
- `electron/services/technicalPlanStore.cjs`
- `electron/ipc/technicalPlanIpc.cjs`

修改：

- `electron/utils/paths.cjs`
- `electron/ipc/index.cjs`
- `electron/preload.cjs`
- `electron/services/taskService.cjs`
- `electron/services/bidAnalysisTask.cjs`
- `electron/services/outlineGenerationTask.cjs`
- `electron/services/contentGenerationTask.cjs`

重点变化：

- `taskService.cjs` 接收 `technicalPlanStore`，技术方案任务不再通过 `workspaceStore` 读写。
- `bidAnalysisTask.cjs` 不接收 `fileContent`，改为 Main 侧读取 `tender.md`。
- `outlineGenerationTask.cjs` 不接收 `overview`、`requirements`，改为读取解析结果。
- `contentGenerationTask.cjs` 不接收完整 `outlineData`，改为读取 SQLite 目录树。
- 任务内部只在关键节点写 SQLite，不把 AI 调用包在事务里。

### 6.2 Renderer

修改：

- `src/features/technical-plan/types.ts`
- `src/features/technical-plan/services/technicalPlanStorage.ts`
- `src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts`
- `src/features/technical-plan/pages/TechnicalPlanHome.tsx`
- `src/features/technical-plan/pages/DocumentAnalysisPage.tsx`
- `src/features/technical-plan/pages/BidAnalysisPage.tsx`
- `src/features/technical-plan/pages/OutlineEditPage.tsx`
- `src/features/technical-plan/pages/ContentEditPage.tsx`
- `src/shared/types/ipc.ts`

重点变化：

- `TechnicalPlanState` 移除 `fileName`、`fileContent`，新增 `tenderFile`。
- `useTechnicalPlanWorkflow` 只负责加载状态、维护 UI 状态，不再自动保存完整状态。
- `DocumentAnalysisPage` 调用 `technicalPlan.importTenderDocument()`，展示返回的 Markdown 或按需调用 `readTenderMarkdown()`。
- `BidAnalysisPage` 启动任务不再传 `fileContent`。
- `OutlineEditPage` 保存目录配置、人工编辑目录时调用技术方案专用接口。
- `ContentEditPage` 启动正文生成不再传完整目录，手动保存正文调用 `saveChapterContent()`。

### 6.3 依赖与打包

修改：

- `client/package.json`
- `client/package-lock.json`

新增依赖：

```text
better-sqlite3
```

注意：

- `better-sqlite3` 是原生模块，必须验证 Electron 开发启动和 `electron-builder` 打包。
- 依赖变更后需要运行 `npm audit`。
- Windows 中文路径必须作为默认场景验证。

## 7. 分批执行步骤

### 第 1 批：依赖、路径、SQLite 基础设施

目标：先把 DB 能打开、建表、自动升级、关闭，不接业务。

修改内容：

- 安装 `better-sqlite3`。
- 新增 DB 路径方法。
- 新增 `sqliteDatabase.cjs`。
- 建立 `technical_plan_*` 表。
- 实现 `schemaVersion`、migration 列表、`PRAGMA user_version` 升级流程。
- 实现升级前备份、升级失败中断、DB 版本高于代码版本时拒绝写入。
- 将根目录 `sql/workspace_schema.sql` 作为最新完整结构参考文件纳入维护。
- 在 IPC 初始化时创建 DB 实例，并传给 `technicalPlanStore`。

验收标准：

- `node --check` 通过新增 `.cjs` 文件。
- `npm run build` 通过。
- `npm run dev` 启动后 `userData/workspace/yibiao.sqlite` 可创建。
- 新库 `PRAGMA user_version` 等于当前 `schemaVersion`。
- 手工把测试库 `user_version` 调低后，启动应用会自动升级到当前版本。
- 手工把测试库 `user_version` 调高后，技术方案功能会拒绝继续写入并给出明确错误。

### 第 2 批：技术方案专用 Store 和 IPC

目标：建立新接口，但暂不迁移所有页面逻辑。

修改内容：

- 新增 `technicalPlanStore.cjs`。
- 新增 `technicalPlanIpc.cjs`。
- preload 暴露 `window.yibiao.technicalPlan`。
- TypeScript 补齐 `YibiaoBridge.technicalPlan` 类型。
- 实现 `loadState()`、`clear()`、`readTenderMarkdown()` 的基础能力。

验收标准：

- 页面能调用新 API。
- 空库时 `loadState()` 返回初始技术方案状态。
- `clear()` 后所有技术方案表为空，`tender.md` 被删除。

### 第 3 批：招标文件导入改造

目标：招标文件 Markdown 文件化，状态结构去掉 `fileContent`。

修改内容：

- `technicalPlanStore.importTenderDocument()` 复用 `parseDocumentWithConfig()`。
- 解析成功后写入 `technical-plan/tender.md`。
- 计算 Markdown hash 和字符数。
- SQLite 保存 `tenderFile` 元数据。
- 导入新文件时清空 Step02/Step03/Step04 相关表。
- Renderer `TechnicalPlanState` 移除 `fileName`、`fileContent`。
- `DocumentAnalysisPage` 使用 `importTenderDocument()` 和 `readTenderMarkdown()`。
- `TechnicalPlanHome` 下一步判断从 `state.fileContent` 改为 `state.tenderFile`。

验收标准：

- 上传招标文件后页面能展示 Markdown。
- 重启应用后 Step01 仍能通过 `readTenderMarkdown()` 展示 Markdown。
- `loadState()` 不返回完整 Markdown。
- 重新上传文件后，解析结果、目录、正文缓存被清空。

### 第 4 批：招标文件解析任务改造

目标：Step02 从 SQLite/Markdown 文件读取输入，解析结果按项落库。

修改内容：

- `startBidAnalysis()` 去掉 `fileContent` 参数。
- `bidAnalysisTask.cjs` 从 `technicalPlanStore.readTenderMarkdown()` 获取招标文件 Markdown。
- 每个解析项开始时更新 `technical_plan_bid_items.status = running`。
- 每个解析项成功/失败后只更新该行。
- `projectOverview`、`techRequirements` 从解析项派生。
- 全量重新解析时，事务清空目录和正文相关表。
- `BidAnalysisPage` 启动任务不再传 `fileContent`。

验收标准：

- 无招标文件时启动解析给出明确错误。
- 关键模式和完整模式都能运行。
- 单项失败重试只更新该项。
- 全量重新解析会清空后续目录和正文缓存。

### 第 5 批：目录生成与人工编辑改造

目标：Step03 目录树进入 SQLite，目录变更事务清空正文缓存。

修改内容：

- `startOutlineGeneration()` 去掉 `overview`、`requirements` 参数。
- Main 从 `technical_plan_bid_items` 获取项目概述和技术评分要求。
- 目录生成成功后写入 `technical_plan_outline_nodes`。
- 保存 `outline_project_name`、`outline_project_overview`。
- 保存目录模式和参考知识库文档 ID。
- `OutlineEditPage` 的目录配置保存调用 `saveOutlineConfig()`。
- 目录人工编辑、添加、删除调用 `saveOutline()`。
- `saveOutline()` 在同一事务内重写目录节点，并清空正文任务、正文状态、正文编排计划、runtime。

验收标准：

- 生成目录后重启应用，目录仍存在。
- 人工编辑目录后重启应用，目录仍为编辑后的结构。
- 目录编辑、添加、删除后正文内容和正文生成缓存被清空。
- 目录重新生成后旧正文不会出现在新目录中。

### 第 6 批：正文生成任务改造

目标：Step04 高频写入改成局部落库。

修改内容：

- `startContentGeneration()` 不再接收完整 `outlineData`、`projectOverview`、`reference_knowledge_document_ids`。
- Main 从 SQLite 读取目录树、项目概述、正文生成配置、参考知识库文档 ID。
- `contentGenerationTask.cjs` 单章节开始/成功/失败时只更新：
  - `technical_plan_outline_nodes.content`
  - `technical_plan_content_sections`
  - `technical_plan_tasks`
- 正文编排计划写入 `technical_plan_content_plans`。
- runtime 写入 `technical_plan_meta.content_generation_runtime_json`。
- 补目录时事务更新目录节点，清空被影响节点正文和编排计划。
- 暂停、继续、应用重启恢复逻辑从 SQLite 读取任务和小节状态。

验收标准：

- 正文生成可以从空目录状态开始。
- 生成过程中切页再回来能看到当前任务进度。
- 单章节完成后刷新页面能看到该章节正文。
- 暂停后重启应用，再进入技术方案能显示暂停状态并可继续。
- 单章节重新生成只覆盖该章节。
- 全量重新生成会清空旧正文并重新生成。

### 第 7 批：清理旧技术方案 workspace 链路

目标：删除临时兼容和旧技术方案 JSON 入口。

修改内容：

- 移除 preload 中 `workspace.*TechnicalPlan` 方法。
- 移除 `workspaceIpc.cjs` 中技术方案 handle；后续 v2 已删除旧 workspace IPC。
- `workspaceStore.cjs` 删除技术方案相关方法；后续 v2 已由功能专用 Store 完全替代。
- 删除或重命名 `technicalPlanStorage.ts` 中旧的整包 save 语义，改成技术方案专用 client。
- 全仓搜索 `fileContent`、`loadTechnicalPlan`、`updateTechnicalPlan`、`saveTechnicalPlan`，移除技术方案旧调用。

验收标准：

- 技术方案功能不再引用旧 workspace API。
- `technical_plan.json` 不再创建。
- `npm run build` 无类型错误。

## 8. 风险点和注意事项

### 8.1 better-sqlite3 原生模块风险

`better-sqlite3` 是原生模块，Electron 开发环境和打包环境都要验证。

注意事项：

- 本地 Windows 需要能正常 `npm ci`。
- `npm run dev` 需要能加载原生模块。
- `npm run dist:win` 需要验证 `electron-builder` 是否正确打包原生模块。
- Release CI 使用 Node 22，也需要关注 native module 安装和打包行为。

### 8.2 不要把 AI 请求放进事务

SQLite 事务只包快速本地写入。

禁止：

- 在事务中等待 AI 请求。
- 在事务中执行文件解析、图片下载、Word 导出。

正确方式：

- 任务阶段开始时快速写入 running。
- AI 请求完成后快速写入结果。
- 失败时快速写入 error。

### 8.3 Markdown 文件和 SQLite 元数据一致性

导入招标文件时涉及文件写入和 DB 写入。

建议流程：

- 解析成功后写 `tender.md.tmp`。
- 写入完成后 rename 为 `tender.md`。
- 再用事务更新 SQLite 元数据并清空后续数据。
- 如果 DB 写入失败，删除本次新写入的 `tender.md`，避免孤儿文件。

### 8.4 不做旧数据兼容

本次明确不兼容旧 `technical_plan.json`。

注意事项：

- 不读取旧 JSON。
- 不迁移旧 JSON。
- 不提供 fallback。
- 改造后第一次打开技术方案就是空状态。

### 8.5 任务事件不能继续传完整大状态

如果继续在每次任务更新时调用完整 `loadState()` 并广播，会削弱 SQLite 改造收益。

注意事项：

- 招标解析每项完成只发该项。
- 正文生成每小节完成只发该小节。
- 只有目录结构真的变化时才发完整 `outlineData`。
- 日志列表仍需限制长度，Renderer 继续只展示最近日志。

### 8.6 目录节点 ID 仍使用章节编号

当前目录 ID 同时承担章节编号和节点标识。

注意事项：

- 人工编辑导致重新编号时，直接事务重写整棵目录最可靠。
- 重写目录必须同步清空正文缓存。
- 不要在同一轮改造中引入内部 UUID，否则会扩大前端树编辑、导出和提示词上下文的改动面。

### 8.7 生成图片清理不在本次核心目标内

正文生成图片仍保存在 `workspace/generated-images/`。

注意事项：

- 本次不把图片塞进 SQLite。
- 本次不强行重构生成图片清理策略。
- 如后续要清理生成图片，应先让图片文件带上技术方案或章节作用域，再做安全删除。

### 8.8 Windows 中文路径

必须继续显式使用 UTF-8。

注意事项：

- `tender.md` 读写使用 `utf-8`。
- SQLite DB 路径来自 `app.getPath('userData')`，要兼容中文用户名路径。
- 文件路径不要手写分隔符，使用 `path.join()`。

### 8.9 SQL 说明文件维护

根目录 `sql/workspace_schema.sql` 是给开源开发者阅读的最新完整结构，不是运行时唯一来源。

注意事项：

- 修改表结构时，必须同时追加 migration 和更新 `sql/workspace_schema.sql`。
- 不要让 SQL 文件和实际 migration 产生字段差异。
- Code Review 时要检查 schema 文件、migration、TypeScript 类型三者是否一致。
- SQL 文件可以使用 `CREATE TABLE IF NOT EXISTS` 方便开发者本地查看，但产品运行时仍必须通过 migration 管理升级。

## 9. 验证方法

### 9.1 静态检查

涉及 Electron Main / preload 改动后运行：

```powershell
cd client
node --check electron\preload.cjs
node --check electron\ipc\technicalPlanIpc.cjs
node --check electron\services\sqliteDatabase.cjs
node --check electron\services\technicalPlanStore.cjs
node --check electron\services\taskService.cjs
node --check electron\services\bidAnalysisTask.cjs
node --check electron\services\outlineGenerationTask.cjs
node --check electron\services\contentGenerationTask.cjs
npm run build
```

依赖变更后运行：

```powershell
cd client
npm audit
```

### 9.2 手动功能验证

运行：

```powershell
cd client
npm run dev
```

验证清单：

- 首次打开技术方案为空状态。
- 上传招标文件后能看到 Markdown 预览。
- 关闭应用再打开，技术方案仍显示已上传文件元数据，Markdown 可按需读取展示。
- `workspace/technical-plan/tender.md` 存在，内容是解析后的 Markdown。
- `workspace/yibiao.sqlite` 存在。
- 不再生成 `workspace/technical_plan.json`。
- 点击下一步进入招标文件解析。
- 关键模式解析成功后可以进入目录生成。
- 完整模式解析成功后所有解析项能正确展示。
- 单个解析项失败后可以单项重试。
- 目录生成成功后能展示目录树。
- 目录人工编辑、添加、删除后刷新页面仍保留编辑结果。
- 目录变更后正文缓存被清空。
- 正文生成可以启动。
- 正文生成过程中切换页面再切回，进度继续展示。
- 单个小节成功后，刷新页面仍能看到正文。
- 暂停正文生成后重启应用，回到技术方案显示暂停状态。
- 继续正文生成后可以从暂停状态恢复。
- 单章节重新生成只覆盖该章节。
- 手动编辑章节正文并保存，刷新页面仍保留。
- 导出 Word 能使用当前目录和正文内容。
- 重置技术方案后，数据库技术方案表清空，`tender.md` 被删除，页面回到初始状态。

### 9.3 打包验证

Windows 本地打包验证：

```powershell
cd client
npm run dist:win
```

重点检查：

- 打包应用能启动。
- 打包应用能加载 `better-sqlite3`。
- 打包应用能创建 `workspace/yibiao.sqlite`。
- 打包应用能完成技术方案上传、解析、目录生成、正文生成的主流程。

### 9.4 数据一致性验证

可在开发阶段增加临时调试日志或一次性检查脚本，但不要把调试脚本作为产品功能暴露。

建议检查：

- 导入新招标文件后，`technical_plan_bid_items`、`technical_plan_outline_nodes`、`technical_plan_content_sections`、`technical_plan_content_plans` 为空。
- 招标解析每完成一项，只新增或更新对应 `technical_plan_bid_items` 行。
- 目录生成后，`technical_plan_outline_nodes` 行数等于目录节点总数。
- 正文生成每完成一节，只有对应目录节点 `content` 和对应 section 状态变化。
- 目录编辑后，正文 section 和 plan 表被清空。
- 重置后，所有 `technical_plan_*` 表回到空状态或单行初始状态。

### 9.5 自动升级验证

建议在开发环境准备临时测试库验证升级逻辑。

验证清单：

- 删除 `workspace/yibiao.sqlite` 后启动应用，数据库自动创建，`PRAGMA user_version` 等于当前 `schemaVersion`。
- 使用旧 schema 测试库启动新客户端，migration 自动执行，原有可保留数据仍可读取。
- 升级前能生成 `yibiao.sqlite.backup-YYYYMMDD-HHmmss` 备份文件。
- 人为制造 migration SQL 错误后，技术方案功能停止写入并提示数据库升级失败。
- 人为把 `PRAGMA user_version` 设置为高于当前代码版本后，技术方案功能提示客户端版本过低。
- 检查 `sql/workspace_schema.sql` 与实际升级后的数据库结构一致。

## 10. 执行优先级建议

最高优先级：

- 招标文件 Markdown 文件化。
- 移除 `fileContent` 全局状态。
- 正文生成局部写入。

中优先级：

- 目录树拆表。
- 任务事件 patch 化。
- 移除旧 workspace 技术方案 API。

低优先级：

- DB 检查脚本。
- 生成图片清理策略。
- 后续其他模块迁移。

技术方案主流程已迁入 SQLite v1；标书查重和废标项检查已按独立方案迁入 v2；知识库迁移方案见 `client/doc/sqlite改造方案_知识库.md`，目标为 v3 且必须保留用户既有知识库数据。
