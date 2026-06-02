# 废标项检查和标书查重 SQLite 改造方案

## 1. 改造目标

本方案记录 `client/` 中“废标项检查”和“标书查重”两个模块的本地数据存储升级设计；运行代码已按该方案迁入 SQLite v2。

核心目标：

- 将废标项检查从 `userData/workspace/rejection_check.json` 整包读写，改为 SQLite 结构化存储。
- 将标书查重从 `userData/workspace/duplicate_check.json` 整包读写，改为 SQLite 结构化存储。
- 大文本 Markdown 文件化，SQLite 只保存路径、hash、字符数、解析器、任务状态和结构化结果。
- 后台任务不再通过 JSON 整包 `updateDuplicateCheck()` / `updateRejectionCheck()` 重写完整状态，而是按文件、任务、分析类别、结果项局部更新。
- 不迁移旧 JSON 数据，不读取、不 fallback 到旧 `duplicate_check.json` 或 `rejection_check.json`。
- 保持当前业务流程和 UI 交互不变：标书查重仍包含元数据、目录、正文、图片四类分析；废标项检查仍包含无效与废标项解析、废标项检查、错别字检查、逻辑谬误检查。

最终期望效果：

- 页面恢复状态时不再解析越来越大的 JSON 文件。
- 单个分析子任务完成时只更新对应表和任务状态。
- 投标文件、招标文件 Markdown 可按需读取，不进入 Renderer 的长期全局状态。
- 标书查重和废标项检查与技术方案共用 `workspace/yibiao.sqlite`，统一初始化、备份和版本升级。

## 2. 改造范围

本次纳入设计范围：

- 废标项检查本地存储。
- 标书查重本地存储。
- 废标项检查和标书查重的 Store、IPC、preload、Renderer 类型改造边界。
- `taskService.cjs` 对两个模块 Store 的注入方式。
- SQLite schema v2 目标结构。
- 文件路径、清空规则、验证标准。

本次不纳入范围：

- 知识库存储迁移，另见 `client/doc/sqlite改造方案_知识库.md`。
- 配置 `user_config.json` 迁移。
- 旧 `duplicate_check.json` / `rejection_check.json` 数据迁移。
- AI prompt、算法和 UI 视觉重构。
- 原始 Word/PDF 文件长期复制保存。
- 图片资产存储方式重构。

## 3. 总体存储原则

### 3.1 统一数据库

继续使用技术方案已引入的工作区数据库：

```text
userData/
  workspace/
    yibiao.sqlite
```

本方案目标是把 schema 从 v1 升级到 v2：

- v1：技术方案 `technical_plan_*` 表。
- v2：新增 `duplicate_check_*` 和 `rejection_check_*` 表。

运行时代码仍必须以 Electron Main 侧 migration 为准；SQL 文件只作为开源开发者阅读、评审和排查问题的说明。

### 3.2 大文本文件化

SQLite 保存结构化状态，不保存大段 Markdown 原文。

标书查重：

```text
userData/workspace/duplicate-check/
  contents/
    <fileId>.md
```

废标项检查：

```text
userData/workspace/rejection-check/
  tender.md
  bid.md
```

图片：

- 继续保存到 `workspace/imported-images/`。
- 正文中继续使用 `yibiao-asset://imported-images/...` 引用。
- SQLite 不保存图片 BLOB。

### 3.3 权威来源

标书查重：

- 文件选择列表以 `duplicate_check_files` 为权威来源。
- 提取后的 Markdown 路径以 `duplicate_check_content_files` 为权威来源。
- 元数据项以 `duplicate_check_metadata_items` 为权威来源。
- 目录结果以 `duplicate_check_outline_items`、`duplicate_check_outline_groups`、`duplicate_check_outline_pairwise` 为权威来源。
- 正文重复结果以 `duplicate_check_content_duplicates` 和 `duplicate_check_content_occurrences` 为权威来源。
- 图片重复结果以 `duplicate_check_duplicate_images` 和 `duplicate_check_image_occurrences` 为权威来源。
- 后台任务状态以 `duplicate_check_tasks` 和 `duplicate_check_analysis_sections` 为权威来源。

废标项检查：

- 招标/投标文档元数据以 `rejection_check_documents` 为权威来源。
- Markdown 原文以 `rejection-check/tender.md`、`rejection-check/bid.md` 为权威来源。
- 无效与废标项解析结果以 `rejection_check_extraction` 为权威来源。
- 三类检查状态以 `rejection_check_results` 为权威来源。
- 三类检查明细分别以 `rejection_check_risk_findings`、`rejection_check_typo_findings`、`rejection_check_logic_findings` 为权威来源。
- 后台任务状态以 `rejection_check_tasks` 为权威来源。

### 3.4 不再保留

- `workspace:load-duplicate-check` / `saveDuplicateCheck` / `clearDuplicateCheck` 作为标书查重权威 API。
- `workspace:load-rejection-check` / `saveRejectionCheck` / `clearRejectionCheck` 作为废标项检查权威 API。
- Renderer 自动保存完整 `DuplicateCheckWorkspaceState`。
- Renderer 自动保存完整 `RejectionCheckWorkspaceState`。
- `tasks:startRejectionItemsExtraction({ tenderContent })` 这类从 Renderer 传大文本给 Main 的调用方式。
- `tasks:startRejectionCheck({ bidContent, invalidBidAndRejectionItems })` 这类从 Renderer 传大文本给 Main 的调用方式。

## 4. SQLite 版本与 SQL 说明文件

目标版本：

```sql
PRAGMA user_version = 2;
```

SQL 说明文件：

- 将根目录 `sql/technical_plan_schema.sql` 重命名为 `sql/workspace_schema.sql`。
- 文件内容调整为工作区 SQLite 最新完整结构说明。
- 包含已落地的 `technical_plan_*` 表、本方案目标新增的 `duplicate_check_*`、`rejection_check_*` 表，以及后续知识库 v3 目标表。
- 文件顶部必须注明：运行时代码以 Electron Main 侧 migration 为准，说明文件可能先记录下一阶段目标结构。

## 5. 标书查重表设计

### 5.1 duplicate_check_meta

保存标书查重页面级状态。

字段建议：

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `step TEXT NOT NULL DEFAULT 'upload'`
- `active_analysis_tab TEXT NOT NULL DEFAULT 'metadata'`
- `current_signature TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 5.2 duplicate_check_files

保存当前招标文件和投标文件选择结果。

字段建议：

- `file_id TEXT PRIMARY KEY`
- `role TEXT NOT NULL`：`tender` / `bid`
- `file_name TEXT NOT NULL`
- `file_path TEXT NOT NULL`
- `extension TEXT NOT NULL`
- `size INTEGER NOT NULL DEFAULT 0`
- `modified_at TEXT`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `content_hash TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

说明：

- `file_id` 继续使用当前 `stableFileId()` 口径，保证内容提取路径稳定。
- 招标文件可为空；投标文件至少一份才能进入分析。

### 5.3 duplicate_check_tasks

保存外层 `duplicate-analysis` 任务状态。

字段建议：

- `type TEXT PRIMARY KEY`
- `task_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `progress INTEGER NOT NULL DEFAULT 0`
- `logs_json TEXT`
- `stats_json TEXT`
- `error TEXT`
- `payload_signature TEXT`
- `started_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 5.4 duplicate_check_analysis_sections

保存四类分析子状态：元数据、目录、正文、图片。

字段建议：

- `section TEXT PRIMARY KEY`：`metadata` / `outline` / `content` / `image`
- `status TEXT NOT NULL`
- `progress INTEGER NOT NULL DEFAULT 0`
- `message TEXT NOT NULL DEFAULT ''`
- `signature TEXT`
- `stats_json TEXT`
- `started_at TEXT`
- `updated_at TEXT NOT NULL`

说明：

- `stats_json` 保存当前 UI 需要的汇总统计，例如 `tenderSentenceCount`、`totalImageCount`、`extraction` 进度等。
- 大结果明细拆入专门表，不放在 JSON 中。

### 5.5 duplicate_check_content_files

保存文件 Markdown 提取状态。

字段建议：

- `file_id TEXT PRIMARY KEY`
- `status TEXT NOT NULL`
- `content_path TEXT`
- `content_length INTEGER NOT NULL DEFAULT 0`
- `parser_label TEXT`
- `error TEXT`
- `updated_at TEXT NOT NULL`

### 5.6 duplicate_check_metadata_items

保存每个投标文件的元数据项。

字段建议：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `file_id TEXT NOT NULL`
- `key TEXT NOT NULL`
- `label TEXT NOT NULL`
- `value TEXT NOT NULL DEFAULT ''`
- `normalized TEXT`
- `date_day TEXT`
- `comparable INTEGER NOT NULL DEFAULT 0`
- `date_comparable INTEGER NOT NULL DEFAULT 0`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `UNIQUE(file_id, key)`

说明：

- 当前 `rows` 可在读取时由 `metadata_items` 程序计算，也可新增视图或缓存表；第一版建议读取时计算，避免双写。

### 5.7 duplicate_check_outline_items

保存投标文件目录提取结果。

说明：

- 业务层目录项 ID 在单个投标文件内生成，例如 `O00001`，不同文件会重复。
- SQLite 内部落库时使用 `file_id::item_id` 作为 `item_id`，`parent_item_id` 同步使用同一作用域 ID；Store 聚合返回给 Renderer 时再还原为原业务 ID。

字段建议：

- `item_id TEXT PRIMARY KEY`
- `file_id TEXT NOT NULL`
- `parent_item_id TEXT`
- `level INTEGER NOT NULL`
- `number TEXT`
- `title TEXT NOT NULL`
- `normalized_title TEXT NOT NULL`
- `path_titles_json TEXT NOT NULL`
- `normalized_path TEXT NOT NULL`
- `source TEXT NOT NULL`
- `confidence REAL NOT NULL DEFAULT 0`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `from_tender INTEGER NOT NULL DEFAULT 0`
- `matched_tender_sentence TEXT`

### 5.8 duplicate_check_outline_groups

保存目录重复/相似组。

字段建议：

- `group_id TEXT PRIMARY KEY`
- `type TEXT NOT NULL`
- `title TEXT NOT NULL`
- `score REAL NOT NULL DEFAULT 0`
- `file_ids_json TEXT NOT NULL`
- `item_ids_json TEXT NOT NULL`
- `paths_json TEXT NOT NULL`
- `sort_order INTEGER NOT NULL DEFAULT 0`

### 5.9 duplicate_check_outline_pairwise

保存文件两两目录相似度。

字段建议：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `file_a_id TEXT NOT NULL`
- `file_b_id TEXT NOT NULL`
- `score REAL NOT NULL DEFAULT 0`
- `title_overlap REAL NOT NULL DEFAULT 0`
- `path_overlap REAL NOT NULL DEFAULT 0`
- `order_similarity REAL NOT NULL DEFAULT 0`
- `shared_count INTEGER NOT NULL DEFAULT 0`
- `risk TEXT NOT NULL DEFAULT 'none'`
- `UNIQUE(file_a_id, file_b_id)`

### 5.10 duplicate_check_content_duplicates

保存跨投标文件重复句。

字段建议：

- `duplicate_id TEXT PRIMARY KEY`
- `sentence TEXT NOT NULL`
- `normalized TEXT NOT NULL`
- `file_ids_json TEXT NOT NULL`
- `first_order INTEGER NOT NULL DEFAULT 0`

### 5.11 duplicate_check_content_occurrences

保存重复句在各文件中的出现次数。

字段建议：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `duplicate_id TEXT NOT NULL`
- `file_id TEXT NOT NULL`
- `occurrence_count INTEGER NOT NULL DEFAULT 0`
- `UNIQUE(duplicate_id, file_id)`

### 5.12 duplicate_check_image_files

保存每个文件的图片统计。

字段建议：

- `file_id TEXT PRIMARY KEY`
- `status TEXT NOT NULL`
- `image_count INTEGER NOT NULL DEFAULT 0`
- `unique_image_count INTEGER NOT NULL DEFAULT 0`
- `error TEXT`
- `updated_at TEXT NOT NULL`

### 5.13 duplicate_check_duplicate_images

保存重复图片组。

字段建议：

- `image_id TEXT PRIMARY KEY`
- `hash TEXT NOT NULL`
- `preview_url TEXT NOT NULL`
- `file_ids_json TEXT NOT NULL`
- `sort_order INTEGER NOT NULL DEFAULT 0`

### 5.14 duplicate_check_image_occurrences

保存重复图片在各文件中的出现次数和位置。

字段建议：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `image_id TEXT NOT NULL`
- `file_id TEXT NOT NULL`
- `occurrence_count INTEGER NOT NULL DEFAULT 0`
- `locations_json TEXT`
- `UNIQUE(image_id, file_id)`

## 6. 废标项检查表设计

### 6.1 rejection_check_meta

保存废标项检查页面级状态。

字段建议：

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `step TEXT NOT NULL DEFAULT 'documents'`
- `active_document_tab TEXT NOT NULL DEFAULT 'tender'`
- `active_result_tab TEXT NOT NULL DEFAULT 'analysis'`
- `active_check_result_tab TEXT NOT NULL DEFAULT 'rejection'`
- `custom_check_items TEXT NOT NULL DEFAULT ''`
- `check_options_json TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 6.2 rejection_check_documents

保存招标文件和投标文件元数据。

字段建议：

- `role TEXT PRIMARY KEY`：`tender` / `bid`
- `source TEXT NOT NULL`：`upload` / `technical-plan`
- `file_name TEXT NOT NULL`
- `markdown_path TEXT NOT NULL`
- `content_hash TEXT NOT NULL`
- `content_chars INTEGER NOT NULL DEFAULT 0`
- `parser_label TEXT`
- `imported_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

说明：

- 招标文件来自技术方案时，`source='technical-plan'`，仍建议写入本模块自己的 `rejection-check/tender.md` 快照，避免后续技术方案重新导入导致检查口径变化。

### 6.3 rejection_check_tasks

保存废标项检查后台任务状态。

字段建议：

- `type TEXT PRIMARY KEY`：`rejection-items-extraction` / `rejection-check-run`
- `task_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `progress INTEGER NOT NULL DEFAULT 0`
- `logs_json TEXT`
- `stats_json TEXT`
- `error TEXT`
- `started_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 6.4 rejection_check_extraction

保存无效投标与废标项解析结果。

字段建议：

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `status TEXT NOT NULL DEFAULT 'idle'`
- `content TEXT NOT NULL DEFAULT ''`
- `source TEXT`
- `tender_signature TEXT`
- `error TEXT`
- `updated_at TEXT`

说明：

- 这段结果属于中等文本，但不是原始大文档，第一版可直接存 SQLite。

### 6.5 rejection_check_results

保存三类检查的运行状态。

字段建议：

- `result_type TEXT PRIMARY KEY`：`rejection` / `typo` / `logic`
- `status TEXT NOT NULL DEFAULT 'idle'`
- `input_signature TEXT`
- `active_finding_id TEXT`
- `progress_message TEXT`
- `error TEXT`
- `updated_at TEXT`

### 6.6 rejection_check_risk_findings

保存废标项检查风险项。

字段建议：

- `finding_id TEXT PRIMARY KEY`
- `type TEXT NOT NULL`
- `severity TEXT NOT NULL`
- `title TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `requirement TEXT NOT NULL`
- `bid_evidence TEXT NOT NULL`
- `risk_reason TEXT NOT NULL`
- `suggestion TEXT NOT NULL`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 6.7 rejection_check_typo_findings

保存错别字检查结果。

字段建议：

- `finding_id TEXT PRIMARY KEY`
- `wrong_text TEXT NOT NULL`
- `correct_text TEXT NOT NULL`
- `original_excerpt TEXT NOT NULL`
- `reason TEXT NOT NULL`
- `location_hint TEXT`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### 6.8 rejection_check_logic_findings

保存逻辑谬误检查结果。

字段建议：

- `finding_id TEXT PRIMARY KEY`
- `title TEXT NOT NULL`
- `original_text TEXT NOT NULL`
- `location_hint TEXT NOT NULL`
- `fallacy_reason TEXT NOT NULL`
- `suggestion TEXT NOT NULL`
- `sort_order INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

## 7. Store 与 IPC 设计

### 7.1 新增 Store

新增文件：

- `client/electron/services/duplicateCheckStore.cjs`
- `client/electron/services/rejectionCheckStore.cjs`

Store 职责：

- 屏蔽 SQLite 表细节。
- 提供页面需要的快照读取方法。
- 提供任务执行过程中的局部写入方法。
- 统一执行清空规则。
- 统一读写 Markdown 文件。
- 删除业务资源时清理 imported images。

### 7.2 新增 IPC

新增文件：

- `client/electron/ipc/duplicateCheckIpc.cjs`
- `client/electron/ipc/rejectionCheckIpc.cjs`

preload API：

```ts
window.yibiao.duplicateCheck.loadState()
window.yibiao.duplicateCheck.saveFiles(payload)
window.yibiao.duplicateCheck.saveUiState(payload)
window.yibiao.duplicateCheck.updateState(partial)
window.yibiao.duplicateCheck.clear()

window.yibiao.rejectionCheck.loadState()
window.yibiao.rejectionCheck.importDocument(role)
window.yibiao.rejectionCheck.importTenderFromTechnicalPlan()
window.yibiao.rejectionCheck.removeDocument(role)
window.yibiao.rejectionCheck.saveUiState(payload)
window.yibiao.rejectionCheck.updateState(partial)
window.yibiao.rejectionCheck.clear()
```

旧 workspace API 最终删除：

```ts
window.yibiao.workspace.loadDuplicateCheck()
window.yibiao.workspace.saveDuplicateCheck()
window.yibiao.workspace.clearDuplicateCheck()
window.yibiao.workspace.loadRejectionCheck()
window.yibiao.workspace.saveRejectionCheck()
window.yibiao.workspace.clearRejectionCheck()
```

## 8. 后台任务改造

### 8.1 taskService 注入

`createTaskService()` 增加：

- `duplicateCheckStore`
- `rejectionCheckStore`

根据 task definition 的 `stateKey` 分发到对应 Store：

- `technicalPlan` -> `technicalPlanStore`
- `duplicateCheck` -> `duplicateCheckStore`
- `rejectionCheck` -> `rejectionCheckStore`

### 8.2 标书查重任务

`duplicateCheckService.cjs` 内部通过 `duplicateCheckStore.loadDuplicateCheck()` / `updateDuplicateCheck()` 写入 SQLite，不再读写整包 JSON。

改造后：

- `runContentExtraction()` 每个文件完成后写 `duplicate_check_content_files`。
- `runMetadataExtraction()` 每个文件完成后写 `duplicate_check_metadata_items`。
- `runOutlineAnalysis()` 完成后替换本轮目录结果表。
- `runContentDuplicateAnalysis()` 完成后替换正文重复结果表。
- `runImageDuplicateAnalysis()` 完成后替换图片重复结果表。
- 外层 `analysisTask` 写 `duplicate_check_tasks`。
- 四类子状态写 `duplicate_check_analysis_sections`。

### 8.3 废标项检查任务

- `runRejectionItemsExtractionTask()` 从 `rejectionCheckStore.readDocumentMarkdown('tender')` 读取招标 Markdown。
- `runRejectionCheckTask()` 从 `rejectionCheckStore.readDocumentMarkdown('bid')` 读取投标 Markdown。
- `invalidBidAndRejectionItems` 从 `rejection_check_extraction` 读取。
- 自定义检查项和检查选项从 `rejection_check_meta` 读取；任务 payload 只传运行选项，不传招标/投标 Markdown 或解析结果大文本。
- 三类结果分别写三张 findings 表。

## 9. Renderer 改造

### 9.1 标书查重页面

改造原则：

- 页面挂载后调用 `window.yibiao.duplicateCheck.loadState()`。
- 页面只保存轻量 UI 状态，例如当前步骤和 Tab。
- 文件选择变更通过 `duplicateCheck.saveFiles()` 写入 Main。
- 不再 autosave 完整 `DuplicateCheckWorkspaceState`。
- 结果展示继续使用与当前类型兼容的快照结构，由 Store 聚合返回。

### 9.2 废标项检查页面

改造原则：

- 页面挂载后调用 `window.yibiao.rejectionCheck.loadState()`。
- 文档内容由 `loadState()` 聚合返回，Markdown 原文仍由 Main 侧文件管理。
- 导入文档由 Main 侧完成解析、写 Markdown 文件和更新 SQLite。
- 不再 autosave 完整 `RejectionCheckWorkspaceState`。
- 启动任务只传运行选项，不传大文本。

## 10. 清空规则

### 10.1 标书查重

重新选择招标文件或投标文件：

- 清空 `duplicate_check_tasks`。
- 清空四类 analysis section。
- 清空 content files、metadata items、outline、content duplicate、image duplicate 相关表。
- 删除 `duplicate-check/contents/` 中旧 Markdown。
- 清理 `duplicate-check-content-*` 图片资产。
- 保留新选择文件列表。

重新分析：

- 保留当前文件列表。
- 清空旧分析结果和任务状态。
- 重新写入本轮签名和初始子状态。

清空标书查重：

- 删除所有 `duplicate_check_*` 表数据。
- 删除 `workspace/duplicate-check/`。
- 清理 `duplicate-check-content-*` 图片资产。

### 10.2 废标项检查

重新导入招标文件：

- 替换 `rejection-check/tender.md`。
- 清空 `rejection_check_extraction`。
- 清空三类检查结果。
- 清空任务状态。
- 保留投标文件。

重新导入投标文件：

- 替换 `rejection-check/bid.md`。
- 清空三类检查结果。
- 清空检查任务状态。
- 保留招标文件和无效/废标项解析结果。

重新解析无效与废标项：

- 清空 `rejection_check_extraction`。
- 清空三类检查结果。
- 保留招标/投标文件。

重新执行检查：

- 按启用类别清空对应结果表。
- 保留文档和解析结果。

清空废标项检查：

- 删除所有 `rejection_check_*` 表数据。
- 删除 `workspace/rejection-check/`。
- 清理 `rejection-check-*` 图片资产。

## 11. 旧数据策略

本方案明确不迁移旧 JSON 数据：

- 不读取 `duplicate_check.json`。
- 不读取 `rejection_check.json`。
- 不把旧 JSON 搬入 SQLite。
- 不提供 fallback。

升级后的首次打开：

- 标书查重页面显示为空，需要用户重新选择文件并分析。
- 废标项检查页面显示为空，需要用户重新准备招标文件和投标文件。

原因：

- 当前 JSON 中保存了大量大文本、绝对路径、任务运行中间态和解析结果，直接迁移容易引入不一致。
- 两个模块的结果都可由用户重新导入文件并重新生成，优先保证最终结构简单可靠。

## 12. 实施步骤

1. 重命名 SQL 说明文件为 `sql/workspace_schema.sql`，写入 v2 目标结构。
2. 扩展 `sqliteDatabase.cjs`，追加 migration v2。
3. 新增路径工具：`getRejectionCheckDir()`、`getRejectionCheckMarkdownPath(role)`，保留/复用 `getDuplicateCheckDir()`。
4. 新增 `duplicateCheckStore.cjs`。
5. 新增 `rejectionCheckStore.cjs`。
6. 新增 `duplicateCheckIpc.cjs` 和 `rejectionCheckIpc.cjs`。
7. 扩展 preload 和 `shared/types/ipc.ts`。
8. 改造 `taskService.cjs` 的 stateKey 分发。
9. 改造 `duplicateCheckService.cjs` 为 SQLite Store 局部写入。
10. 改造 `rejectionCheckTask.cjs` 为 Main 侧读取 Markdown 和解析结果。
11. 改造 `DuplicateCheckPage.tsx` 和 `RejectionCheckPage.tsx`。
12. 删除 `workspaceStore.cjs` 中标书查重、废标项检查 JSON 方法。
13. 删除 `workspaceIpc.cjs` 对应 IPC。
14. 更新 `client/开发说明.md`。

## 13. 验证标准

语法检查：

```powershell
cd client
node --check electron\services\sqliteDatabase.cjs
node --check electron\services\duplicateCheckStore.cjs
node --check electron\services\rejectionCheckStore.cjs
node --check electron\services\duplicateCheckService.cjs
node --check electron\services\rejectionCheckTask.cjs
node --check electron\ipc\duplicateCheckIpc.cjs
node --check electron\ipc\rejectionCheckIpc.cjs
node --check electron\preload.cjs
```

构建检查：

```powershell
cd client
npm run build
```

依赖检查：

```powershell
cd client
npm audit
```

手动验证：

- `npm run dev` 打开客户端。
- 标书查重：选择招标文件和多份投标文件，完成四类分析，切页后恢复状态。
- 标书查重：重新分析、替换文件、清空缓存后结果正确清理。
- 废标项检查：上传招标文件和投标文件，完成解析和三类检查，切页后恢复状态。
- 废标项检查：从技术方案读取招标文件，确认写入本模块快照后不受技术方案后续重新导入影响。
- 应用重启后，running 但无 active task 的任务按既有规则标记为未完成或可重试。

## 14. 风险与取舍

- 不迁移旧 JSON 会让用户升级后丢失这两个模块的历史缓存；这是明确取舍，换取结构简单和一致性。
- 标书查重的结果表较多，第一版 Store 应优先保证读写稳定，不做复杂 SQL 视图优化。
- 元数据对比行可运行时计算，不建议第一版缓存 `rows`，避免 metadata item 与 rows 双写不一致。
- 废标项检查文档来自技术方案时必须写入本模块快照，避免两个模块共享同一 Markdown 文件导致检查结果和输入不一致。
